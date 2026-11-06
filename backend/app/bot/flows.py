"""Bot conversation logic. Every action goes through the same services as the Mini App API.

State lives in ``bot_dialogs`` (database), so a bot restart in the middle of «Hikoya qo'shish»
continues from the same step with the same text, files and cover (T-28).
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.ui import BACK, CANCEL, SAVE, Reply, cb, esc, webapp
from app.config import get_settings
from app.core import content_schema as cs
from app.core.errors import AppError
from app.core.permissions import ROLE_TITLES
from app.core.timeutil import utcnow
from app.models import (
    AuthorProfile,
    BotDialog,
    Chapter,
    EditorialReview,
    Genre,
    Payment,
    Product,
    PublishJob,
    Report,
    SupportMessage,
    SupportTicket,
    User,
    Work,
)
from app.services import content as content_svc
from app.services import stories as story_svc
from app.services.identity import Actor, can_publish_work, find_user, grant_role, revoke_role

ACCESS_LABELS = {"FREE": "Bepul", "PREMIUM": "Premium", "PURCHASE": "Alohida xarid", "PREMIUM_OR_PURCHASE": "Premium yoki xarid"}
STATE_LABELS = {
    "draft": "Qoralama", "in_review": "Tekshiruvda", "changes_requested": "Tuzatish so'ralgan", "approved": "Tasdiqlangan",
    "scheduled": "Rejalashtirilgan", "published": "Nashr qilingan", "unpublished": "Nashrdan olingan", "delisted": "Katalogdan yashirilgan",
    "archived": "Arxivda", "suspended": "To'xtatilgan",
}


async def get_dialog(db: AsyncSession, user: User) -> BotDialog:
    d = await db.get(BotDialog, user.id)
    if d is None:
        d = BotDialog(user_id=user.id, flow="", step="", data={})
        db.add(d)
        await db.flush()
    return d


def set_dialog(d: BotDialog, flow: str, step: str, **data) -> None:
    d.flow, d.step = flow, step
    merged = dict(d.data or {})
    merged.update(data)
    d.data = merged


def clear_dialog(d: BotDialog) -> None:
    d.flow, d.step, d.data, d.active_work_id = "", "", {}, None


# ---------------------------------------------------------------- reader side


def main_menu(actor: Actor) -> Reply:
    rows = [
        [webapp("📖 Ilovani ochish")],
        [webapp("📚 Kutubxonam", "library"), webapp("⭐ Premium", "premium")],
        [cb("❓ Yordam", "m:help"), cb("⚙️ Sozlamalar", "m:settings")],
    ]
    if actor.is_staff or actor.own_author_id:
        rows.append([cb("🛠 Boshqaruv paneli", "a:menu")])
    return Reply("<b>HIKOYA PRO</b>\nHikoyalarni topish, o'qish va davom ettirish — barchasi ilova ichida.", rows)


async def cmd_start(db: AsyncSession, actor: Actor, payload: str) -> list[Reply]:
    user = actor.user
    first = not user.bot_started
    user.bot_started = True
    user.bot_blocked = False
    out: list[Reply] = []
    if payload.startswith(("w_", "c_", "a_", "st_")):
        out.append(Reply("Havola bo'yicha ochish:", [[webapp("📖 Ochish", payload)]]))
    elif payload == "author_apply":
        t = SupportTicket(user_id=user.id, category="other", subject="Muallif bo'lish arizasi", status="open")
        db.add(t)
        await db.flush()
        db.add(SupportMessage(ticket_id=t.id, author_user_id=user.id, body="Muallif sifatida hikoya joylamoqchiman."))
        out.append(Reply("Arizangiz qabul qilindi. Administrator ko'rib chiqqach, «Ijod ustaxonasi» ochiladi."))
    out.append(main_menu(actor))
    if first:
        out.append(
            Reply(
                "Yangi boblar va javoblar haqida botda xabar olishni xohlaysizmi? Rad etsangiz ham o'qish to'liq ishlaydi; ilova ichidagi bildirishnomalar markazi doim mavjud.",
                [[cb("🔔 Ha, yuborilsin", "m:consent:1"), cb("Kerak emas", "m:consent:0")]],
            )
        )
    return out


def help_reply() -> Reply:
    return Reply(
        "<b>Yordam</b>\n• Ilovani ochish: pastdagi tugma yoki /app\n• To'lov bo'yicha savol: /paysupport\n• Sozlamalar: /settings\n\nMuallif bo'lmoqchimisiz? «Muallif bo'lish» tugmasini bosing.",
        [[webapp("💬 Yordam bo'limi", "support")], [cb("✍️ Muallif bo'lish", "m:author_apply")]],
    )


async def settings_reply(db: AsyncSession, actor: Actor) -> Reply:
    from app.models import NotificationPreference

    u = actor.user
    prefs = await db.get(NotificationPreference, u.id)
    mode = prefs.mode if prefs else "instant"
    return Reply(
        f"<b>Sozlamalar</b>\nBot xabarlari: {'yoqilgan' if u.bot_messages_allowed else 'o‘chirilgan'}\nRejim: {'tezkor' if mode == 'instant' else 'kunlik yig‘ma'}\nYozuv: {'lotin' if u.script == 'latn' else 'кирилл'}\nSokin vaqt: {prefs.quiet_start if prefs else '22:00'}–{prefs.quiet_end if prefs else '09:00'}",
        [
            [cb("🔔 Xabarlar: " + ("o‘chirish" if u.bot_messages_allowed else "yoqish"), f"m:consent:{0 if u.bot_messages_allowed else 1}")],
            [cb("⏱ Tezkor / yig‘ma", "m:mode")],
            [cb("Aa Lotin / Кирилл", "m:script")],
            [webapp("Batafsil sozlamalar", "settings")],
        ],
    )


async def on_menu_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    from app.models import NotificationPreference

    u = actor.user
    if data == "m:help":
        return [help_reply()]
    if data == "m:settings":
        return [await settings_reply(db, actor)]
    if data.startswith("m:consent:"):
        u.bot_messages_allowed = data.endswith("1")
        return [Reply("Bot xabarlari yoqildi." if u.bot_messages_allowed else "Bot xabarlari o'chirildi. Ilova ichidagi bildirishnomalar ishlashda davom etadi.")]
    if data == "m:mode":
        prefs = await db.get(NotificationPreference, u.id)
        if prefs is None:
            prefs = NotificationPreference(user_id=u.id)
            db.add(prefs)
        prefs.mode = "digest" if prefs.mode == "instant" else "instant"
        return [await settings_reply(db, actor)]
    if data == "m:script":
        u.script = "cyrl" if u.script == "latn" else "latn"
        return [await settings_reply(db, actor)]
    if data == "m:author_apply":
        return await cmd_start(db, actor, "author_apply")
    return []


async def paysupport_start(db: AsyncSession, actor: Actor) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    set_dialog(d, "paysupport", "text")
    pays = (await db.scalars(select(Payment).where(Payment.user_id == actor.id).order_by(Payment.id.desc()).limit(3))).all()
    lines = "\n".join(f"• #{p.id}: {p.amount} ⭐ — {p.created_at:%d.%m.%Y} ({ {'confirmed': 'tasdiqlangan', 'refunded': 'qaytarilgan', 'needs_review': 'tekshiruvda'}.get(p.state, p.state)})" for p in pays) or "To'lovlar topilmadi."
    return [Reply(f"<b>To'lov bo'yicha yordam</b>\nSo'nggi to'lovlaringiz:\n{lines}\n\nMuammoni bitta xabarda yozing. Operator javob beradi.", [[cb(CANCEL, "x:cancel")]])]


# ---------------------------------------------------------------- staff / author panel


def admin_menu(actor: Actor) -> Reply:
    rows: list[list[dict]] = []
    if actor.has("work.create"):
        rows.append([cb("➕ Hikoya qo'shish", "a:new"), cb("➕ Bob qo'shish", "a:addch")])
        rows.append([cb("📚 Mening hikoyalarim", "a:mine"), cb("📝 Qoralamalar", "a:drafts")])
    if actor.has("work.edit_any"):
        rows.append([cb("🗂 Barcha hikoyalar", "a:all")])
    if actor.has("story.create_own") or actor.has("author.post_as"):
        rows.append([cb("📮 Storis", "a:story")])
    if actor.has("work.review") or actor.has("work.publish") or actor.work_perms:
        rows.append([cb("✅ Tekshiruv navbati", "a:reviews"), cb("🗓 Nashr taqvimi", "a:calendar")])
    if actor.has("comment.moderate") or actor.has("story.moderate"):
        rows.append([cb("💬 Sharhlar va shikoyatlar", "a:moder")])
    if actor.has("author.manage"):
        rows.append([webapp("👤 Mualliflar", "admin/authors")])
    if actor.has("catalog.manage"):
        rows.append([webapp("🏠 Bosh sahifa", "admin/home"), webapp("🏷 Janrlar va to'plamlar", "admin/genres")])
    if actor.has("billing.view"):
        rows.append([cb("⭐ Premium va to'lovlar", "a:billing")])
    rows.append([cb("📊 Statistika", "a:stats")])
    if actor.has("roles.manage"):
        rows.append([cb("👥 Xodimlar va vakolatlar", "a:staff")])
    if actor.has("audit.view") or actor.has("settings.manage"):
        rows.append([webapp("⚙️ Sozlamalar va audit", "admin/audit")])
    rows.append([webapp("🎨 Ijod ustaxonasi", "studio")])
    roles = ", ".join(ROLE_TITLES.get(r, r) for r in sorted(actor.roles)) or "Muallif"
    return Reply(f"<b>Boshqaruv paneli</b>\nRolingiz: {roles}", rows)


def _require_any(actor: Actor, *perms: str) -> None:
    if not any(actor.has(p) for p in perms):
        from app.core.errors import Forbidden

        raise Forbidden("Bu bo'lim uchun vakolat yo'q")


async def works_list(db: AsyncSession, actor: Actor, *, drafts_only: bool = False, all_: bool = False, q: str = "") -> Reply:
    query = select(Work)
    if all_:
        _require_any(actor, "work.edit_any")
    else:
        query = query.where(Work.primary_author_id.in_(actor.author_ids or {0}) | Work.id.in_(list(actor.work_perms) or [0]))
    if drafts_only:
        query = query.where(Work.editorial_state.in_(("draft", "changes_requested", "in_review", "approved")))
    if q:
        from app.core.text import normalize_for_search

        query = query.where(Work.search_text.ilike(f"%{normalize_for_search(q)}%") | (Work.short_code == q) | (Work.id == (int(q) if q.isdigit() else -1)))
    rows = (await db.scalars(query.order_by(Work.updated_at.desc()).limit(15))).all()
    if not rows:
        return Reply("Hozircha hikoya yo'q.", [[cb("➕ Hikoya qo'shish", "a:new")], [cb(BACK, "a:menu")]])
    btns = [[cb(f"{'📝' if w.editorial_state != 'published' else '📖'} {w.title[:40]} · {STATE_LABELS.get(w.editorial_state, w.editorial_state)}", f"w:{w.id}")] for w in rows]
    btns.append([cb("🔎 Qidirish", "a:search"), cb(BACK, "a:menu")])
    title = "Qoralamalar" if drafts_only else ("Barcha hikoyalar" if all_ else "Mening hikoyalarim")
    return Reply(f"<b>{title}</b>", btns)


async def work_card(db: AsyncSession, actor: Actor, work_id: int) -> Reply:
    w = await content_svc.get_work(db, work_id)
    await content_svc.require_edit_work(db, actor, w)
    chapters = await content_svc.list_chapters(db, w.id)
    drafts = [c for c in chapters if c.draft_revision_id]
    can_pub = await can_publish_work(db, actor, w)
    text = (
        f"<b>{esc(w.title)}</b>  <code>#{w.id}</code>\nHolat: {STATE_LABELS.get(w.editorial_state, w.editorial_state)} · {ACCESS_LABELS.get(w.access_policy, w.access_policy)}\n"
        f"Boblar: {len(chapters)} (qoralamada: {len(drafts)})"
    )
    if (w.content_flags or {}).get("requested_access"):
        text += f"\nSo'ralgan kirish: {ACCESS_LABELS.get(w.content_flags['requested_access'])} (admin tasdiqlaydi)"
    rows = [
        [cb("➕ Bob qo'shish", f"w:{w.id}:addch"), webapp("✏️ Matnni tahrirlash", f"s_{w.id}")],
        [webapp("👁 O'quvchi ko'rinishida", f"s_{w.id}"), cb("📎 Fayl biriktirish", f"w:{w.id}:file")],
    ]
    if drafts:
        rows.append([cb("📮 Tekshiruvga yuborish", f"w:{w.id}:submit")])
        if can_pub:
            rows.append([cb("🚀 Hozir nashr qilish", f"w:{w.id}:pubask"), cb("🗓 Rejalashtirish", f"w:{w.id}:sched")])
    if w.editorial_state == "published" and can_pub:
        rows.append([cb("🙈 Katalogdan yashirish", f"w:{w.id}:delist")])
    rows.append([cb(BACK, "a:mine")])
    return Reply(text, rows)


async def on_admin_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    if data == "a:menu":
        clear_dialog(d)
        return [admin_menu(actor)]
    if data == "a:new":
        _require_any(actor, "work.create")
        set_dialog(d, "new_work", "kind")
        return [Reply("<b>Hikoya qo'shish</b>\nBitta hikoyami yoki ko'p bobli asar?", [[cb("📄 Bitta hikoya", "nw:kind:short"), cb("📚 Ko'p bobli", "nw:kind:novel")], [cb(CANCEL, "x:cancel")]])]
    if data == "a:addch":
        return [await works_list(db, actor)]
    if data == "a:mine":
        return [await works_list(db, actor)]
    if data == "a:drafts":
        return [await works_list(db, actor, drafts_only=True)]
    if data == "a:all":
        return [await works_list(db, actor, all_=True)]
    if data == "a:search":
        set_dialog(d, "search", "q")
        return [Reply("Nom, muallif, ichki ID yoki kodni yozing:", [[cb(CANCEL, "x:cancel")]])]
    if data == "a:story":
        _require_any(actor, "story.create_own", "author.post_as")
        set_dialog(d, "new_story", "media", frames=[])
        return [Reply("<b>Storis</b>\nRasm, qisqa video (≤60 s) yoki matn yuboring. Bir nechta lavha yuborish mumkin, so'ng «Tayyor».", [[cb("✅ Tayyor", "ns:done"), cb(CANCEL, "x:cancel")]])]
    if data == "a:reviews":
        return [await reviews_reply(db, actor)]
    if data == "a:calendar":
        return [await calendar_reply(db, actor)]
    if data == "a:moder":
        _require_any(actor, "comment.moderate", "story.moderate")
        n_reports = await db.scalar(select(func.count()).select_from(Report).where(Report.status == "open"))
        from app.models import AuthorStory, Comment

        n_pending = await db.scalar(select(func.count()).select_from(Comment).where(Comment.status == "pending"))
        n_stories = await db.scalar(select(func.count()).select_from(AuthorStory).where(AuthorStory.status == "pending"))
        return [Reply(f"<b>Moderatsiya</b>\nOchiq shikoyatlar: {n_reports}\nTasdiq kutayotgan sharhlar: {n_pending}\nTekshiruvdagi storislar: {n_stories}", [[webapp("Navbatni ochish", "q_moderation")], [cb(BACK, "a:menu")]])]
    if data == "a:billing":
        _require_any(actor, "billing.view")
        prods = (await db.scalars(select(Product).order_by(Product.sort_order))).all()
        from app.services.billing import current_version

        lines = []
        for p in prods:
            v = await current_version(db, p)
            lines.append(f"• {esc(p.title)}: {v.amount if v else '—'} ⭐ {'(demo)' if not v or v.is_demo else ''} {'faol' if p.active else 'o‘chiq'} <code>#{p.id}</code>")
        stats = (await db.execute(select(Payment.state, func.count(), func.coalesce(func.sum(Payment.amount), 0)).group_by(Payment.state))).all()
        st = "\n".join(f"• {s}: {n} ta, {a} ⭐" for s, n, a in stats) or "To'lovlar yo'q"
        hint = "\n\nNarx belgilash: <code>/price &lt;mahsulot_id&gt; &lt;stars&gt;</code>" if actor.has("billing.manage_products") else ""
        if not get_settings().billing_enabled:
            hint += "\n⚠️ Real to'lovlar server sozlamasida o'chirilgan (HIKOYA_BILLING_ENABLED)."
        return [Reply(f"<b>Premium va to'lovlar</b>\n{chr(10).join(lines)}\n\n{st}{hint}", [[webapp("Batafsil", "admin/billing")], [cb(BACK, "a:menu")]])]
    if data == "a:stats":
        return [await stats_reply(db, actor)]
    if data == "a:staff":
        _require_any(actor, "roles.manage")
        roles = "\n".join(f"• <code>{r}</code> — {t}" for r, t in ROLE_TITLES.items())
        return [Reply(f"<b>Xodimlar va vakolatlar</b>\nRol berish: <code>/grant &lt;telegram_id&gt; &lt;rol&gt;</code>\nOlish: <code>/revoke &lt;telegram_id&gt; &lt;rol&gt;</code>\n\nRollar:\n{roles}\n\nFoydalanuvchi avval botni ochgan bo'lishi kerak. Username emas, Telegram ID ishlatiladi.", [[webapp("Ro'yxat", "admin/staff")], [cb(BACK, "a:menu")]])]
    return []


async def reviews_reply(db: AsyncSession, actor: Actor) -> Reply:
    q = select(EditorialReview, Work).join(Work, Work.id == EditorialReview.work_id).where(EditorialReview.decision == "pending")
    if not (actor.has("work.review") or actor.has("work.publish")):
        q = q.where(EditorialReview.work_id.in_(list(actor.work_perms) or [0]))
    rows = (await db.execute(q.order_by(EditorialReview.id).limit(10))).all()
    if not rows:
        return Reply("Tekshiruv navbati bo'sh.", [[cb(BACK, "a:menu")]])
    btns = [[cb(f"#{r.id} {w.title[:40]}", f"rv:{r.id}")] for r, w in rows]
    btns.append([webapp("Navbatni ilovada ochish", "q_review")])
    btns.append([cb(BACK, "a:menu")])
    return Reply("<b>Tekshiruv navbati</b>", btns)


async def calendar_reply(db: AsyncSession, actor: Actor) -> Reply:
    q = select(PublishJob, Work.title, Chapter.title).join(Work, Work.id == PublishJob.work_id).join(Chapter, Chapter.id == PublishJob.chapter_id).where(PublishJob.status.in_(("pending", "failed")))
    if not actor.has("work.edit_any"):
        q = q.where(Work.primary_author_id.in_(actor.author_ids or {0}))
    rows = (await db.execute(q.order_by(PublishJob.run_at).limit(15))).all()
    tz = ZoneInfo(get_settings().timezone)
    lines = "\n".join(f"• {j.run_at.astimezone(tz):%d.%m %H:%M} — {esc(wt)} / {esc(ct)}{' ⚠️ ' + esc(j.last_error) if j.status == 'failed' else ''}" for j, wt, ct in rows) or "Rejalashtirilgan nashr yo'q."
    return Reply(f"<b>Nashr taqvimi</b> (Toshkent vaqti)\n{lines}", [[webapp("Taqvimni ochish", "studio/calendar")], [cb(BACK, "a:menu")]])


async def stats_reply(db: AsyncSession, actor: Actor) -> Reply:
    if actor.has("stats.view_all"):
        from app.api.v1.admin import stats

        s = await stats(db, actor)  # same computation as the Mini App admin
        text = (
            f"<b>Statistika</b> (hisoblangan: {s['computed_at'][:16]})\nFoydalanuvchilar: {s['users_total']} (shu hafta yangi: {s['users_new_this_week']})\nBugun faol: {s['active_today']}\n"
            f"Nashrdagi asarlar: {s['works_published_real']} (+ demo: {s['works_demo']})\nShu hafta noyob malakali o'quvchilar: {s['unique_qualified_readers_this_week']}\nShu hafta sharhlar: {s['comments_this_week']}"
        )
    else:
        works = (await db.scalars(select(Work).where(Work.primary_author_id.in_(actor.author_ids or {0})))).all()
        text = "<b>Mening statistikam</b>\n" + ("\n".join(f"• {esc(w.title)}: ❤️ {w.likes_count} · 🙏 {w.thanks_count} · 💬 {w.comments_count}" for w in works) or "Asarlar yo'q.")
    return Reply(text, [[webapp("Batafsil", "studio/stats")], [cb(BACK, "a:menu")]])


# ---------------------------------------------------------------- new work wizard


async def _genre_keyboard(db: AsyncSession, prefix: str, selected: list[int] | None = None) -> list[list[dict]]:
    gs = (await db.scalars(select(Genre).where(Genre.active.is_(True)).order_by(Genre.sort_order))).all()
    sel = set(selected or [])
    rows, row = [], []
    for g in gs:
        row.append(cb(("✅ " if g.id in sel else "") + f"{g.emoji} {g.name_latn}"[:30], f"{prefix}:{g.id}"))
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return rows


def _hdr(d: BotDialog) -> str:
    t = (d.data or {}).get("title")
    return f"📝 <b>«{esc(t)}»</b>\n" if t else ""


def _nav() -> list[dict]:
    return [cb(SAVE, "x:save"), cb(CANCEL, "x:cancel")]


async def wizard_prompt(db: AsyncSession, actor: Actor, d: BotDialog) -> Reply:
    s = d.step
    data = d.data or {}
    h = _hdr(d)
    if s == "title":
        return Reply("Sarlavhani yozing:", [[cb(CANCEL, "x:cancel")]])
    if s == "synopsis":
        return Reply(h + "Qisqa annotatsiya yozing (spoilersiz, 1–3 jumla):", [[cb("O'tkazib yuborish", "nw:skip")], _nav()])
    if s == "author":
        return Reply(h + "Kim nomidan joylanadi?", [[cb("👤 O'zim", "nw:author:me")], [cb("🔎 Mavjud muallif", "nw:author:search")], _nav()])
    if s == "author_search":
        return Reply(h + "Muallif taxallusini yozing:", [_nav()])
    if s == "genre":
        return Reply(h + "Asosiy janrni tanlang:", await _genre_keyboard(db, "nw:g") + [_nav()])
    if s == "genres_extra":
        return Reply(h + "Qo'shimcha janrlar (ixtiyoriy, 2 tagacha):", await _genre_keyboard(db, "nw:gx", data.get("genre_ids")) + [[cb("Davom etish »", "nw:gx:done")], _nav()])
    if s == "classify":
        script = data.get("script", "latn")
        comp = data.get("completion_state", "completed" if data.get("format") == "short" else "ongoing")
        return Reply(
            h + f"Yozuv: <b>{'lotin' if script == 'latn' else 'kirill'}</b>\nHolat: <b>{ {'ongoing': 'davom etmoqda', 'completed': 'tugallangan', 'paused': 'tanaffusda'}[comp]}</b>",
            [[cb("Lotin", "nw:script:latn"), cb("Kirill", "nw:script:cyrl")], [cb("Davom etmoqda", "nw:comp:ongoing"), cb("Tugallangan", "nw:comp:completed"), cb("Tanaffusda", "nw:comp:paused")], [cb("Davom etish »", "nw:classify:done")], _nav()],
        )
    if s == "cover":
        return Reply(h + "Muqova rasmini yuboring (2:3 nisbat tavsiya etiladi, ≤8 MiB):", [[cb("Keyinroq", "nw:skip")], _nav()])
    if s == "text":
        parts = data.get("text_parts", [])
        words = sum(len(p.split()) for p in parts)
        return Reply(
            h + f"Matnni yuboring: bir nechta xabar bo'lishi mumkin, fayl (TXT/DOCX/MD ≤16 MiB) ham bo'ladi.\nHozircha: {len(parts)} ta xabar, ~{words} so'z.\nTugatgach «Matn tugadi» tugmasini bosing.",
            [[cb("✅ Matn tugadi", "nw:textdone")], [webapp("✍️ Muharrirda yozish", f"s_{d.active_work_id}")], _nav()],
        )
    if s == "files":
        return Reply(h + "Qo'shimcha fayl biriktirasizmi? (PDF, MP3/M4A — biriktirma sifatida; PDF matnga aylantirilmaydi)", [[cb("Keyingisi »", "nw:skip")], _nav()])
    if s == "access":
        can = actor.has("work.change_access")
        note = "" if can else "\n<i>Pulli siyosat administrator tasdiqlagandan keyin yoqiladi.</i>"
        return Reply(h + "Kirish siyosati:" + note, [[cb("Bepul", "nw:acc:FREE"), cb("Premium", "nw:acc:PREMIUM")], [cb("Alohida xarid", "nw:acc:PURCHASE"), cb("Premium yoki xarid", "nw:acc:PREMIUM_OR_PURCHASE")], _nav()])
    if s == "sample":
        return Reply(h + "Bepul namuna: birinchi bob to'liq bepul bo'lsinmi?", [[cb("Ha, 1-bob bepul", "nw:sample:1"), cb("Yo'q, faqat boshi", "nw:sample:0")], _nav()])
    if s == "final":
        w = await db.get(Work, d.active_work_id)
        can_pub = bool(w and await can_publish_work(db, actor, w))
        rows = [[webapp("👁 O'quvchi ko'rinishida tekshirish", f"s_{d.active_work_id}")], [cb("💾 Qoralama qoldirish", "nw:fin:draft"), cb("📮 Tekshiruvga", "nw:fin:review")]]
        if can_pub:
            rows.append([cb("🚀 Hozir nashr", "nw:fin:publish"), cb("🗓 Rejalashtirish", "nw:fin:schedule")])
        return Reply(h + "Sharhlar odatiy holatda ochiq. Oxirgi qadam — nima qilamiz?\n<i>Fayl yuborishning o'zi nashr hisoblanmaydi.</i>", rows)
    if s == "schedule":
        return Reply(h + "Nashr vaqtini Toshkent vaqtida yozing: <code>YYYY-MM-DD HH:MM</code>", [_nav()])
    return Reply("Davom etamiz.", [_nav()])


async def _ensure_work(db: AsyncSession, actor: Actor, d: BotDialog) -> Work:
    if d.active_work_id:
        return await content_svc.get_work(db, d.active_work_id)
    data = d.data or {}
    w = await content_svc.create_work(db, actor, title=data["title"], format=data.get("format", "short"), author_id=data.get("author_id"))
    d.active_work_id = w.id
    return w


async def on_wizard_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    parts = data.split(":")
    if d.flow != "new_work":
        if parts[1] == "kind":
            set_dialog(d, "new_work", "kind")
        else:
            return [Reply("Bu jarayon yakunlangan. /admin orqali qaytadan boshlang.")]
    act = parts[1]
    w = await db.get(Work, d.active_work_id) if d.active_work_id else None
    if act == "kind":
        set_dialog(d, "new_work", "title", format=parts[2])
    elif act == "skip":
        nxt = {"synopsis": "author" if (actor.has("author.post_as") or len(actor.author_ids) > 1) else "genre", "cover": "text", "files": "access"}
        d.step = nxt.get(d.step, d.step)
    elif act == "author":
        if parts[2] == "me":
            set_dialog(d, "new_work", "genre", author_id=None)
        else:
            d.step = "author_search"
    elif act == "pick_author":
        set_dialog(d, "new_work", "genre", author_id=int(parts[2]))
    elif act == "g":
        gid = int(parts[2])
        set_dialog(d, "new_work", "genres_extra", primary_genre_id=gid, genre_ids=[gid])
    elif act == "gx":
        if parts[2] == "done":
            wk = await _ensure_work(db, actor, d)
            await content_svc.set_genres(db, wk, d.data.get("primary_genre_id"), d.data.get("genre_ids", []))
            await content_svc.refresh_search_text(db, wk)
            d.step = "classify"
        else:
            ids = list(d.data.get("genre_ids", []))
            gid = int(parts[2])
            if gid in ids and gid != d.data.get("primary_genre_id"):
                ids.remove(gid)
            elif gid not in ids and len(ids) < 3:
                ids.append(gid)
            set_dialog(d, "new_work", "genres_extra", genre_ids=ids)
    elif act == "script":
        set_dialog(d, "new_work", "classify", script=parts[2])
    elif act == "comp":
        set_dialog(d, "new_work", "classify", completion_state=parts[2])
    elif act == "classify":
        wk = await _ensure_work(db, actor, d)
        await content_svc.update_work_meta(db, actor, wk, {"script": d.data.get("script", "latn"), "completion_state": d.data.get("completion_state", "completed" if wk.format == "short" else "ongoing"), "synopsis": d.data.get("synopsis", "")})
        d.step = "cover"
    elif act == "textdone":
        return await _finish_text(db, actor, d)
    elif act == "acc":
        wk = await _ensure_work(db, actor, d)
        policy = parts[2]
        if actor.has("work.change_access"):
            await content_svc.change_access_policy(db, actor, wk, policy)
        elif policy != "FREE":
            wk.content_flags = {**(wk.content_flags or {}), "requested_access": policy}
        d.step = "sample" if policy != "FREE" else "final"
    elif act == "sample":
        if parts[2] == "1" and w:
            chs = await content_svc.list_chapters(db, w.id)
            if chs:
                chs[0].access_override = "free_sample"
        d.step = "final"
    elif act == "fin":
        return await _finalize(db, actor, d, parts[2])
    return [await wizard_prompt(db, actor, d)]


async def _finish_text(db: AsyncSession, actor: Actor, d: BotDialog) -> list[Reply]:
    data = d.data or {}
    parts = data.get("text_parts", [])
    if not parts and not data.get("imported"):
        return [Reply(_hdr(d) + "Hali matn yuborilmadi."), await wizard_prompt(db, actor, d)]
    w = await _ensure_work(db, actor, d)
    if parts:
        text = "\n\n".join(parts)
        doc = cs.text_to_doc(text)
        await content_svc.add_chapter(db, actor, w, title=data.get("chapter_title") or ("" if w.format != "short" else w.title), doc=doc)
    set_dialog(d, "new_work", "files", text_parts=[], imported=False)
    return [Reply(_hdr(d) + "Matn qoralamaga saqlandi. Nashr qilingan matn bu bilan o'zgarmaydi."), await wizard_prompt(db, actor, d)]


async def _finalize(db: AsyncSession, actor: Actor, d: BotDialog, how: str) -> list[Reply]:
    w = await content_svc.get_work(db, d.active_work_id) if d.active_work_id else None
    if w is None:
        clear_dialog(d)
        return [Reply("Qoralama topilmadi.")]
    try:
        if how == "draft":
            msg = "Qoralama saqlandi."
        elif how == "review":
            await content_svc.submit_for_review(db, actor, w)
            msg = "Tekshiruvga yuborildi. Javob kelganda xabar beramiz."
        elif how == "publish":
            await content_svc.publish_now(db, actor, w)
            msg = "Nashr qilindi! 🎉"
        elif how == "schedule":
            d.step = "schedule"
            return [await wizard_prompt(db, actor, d)]
        else:
            return []
    except AppError as e:
        problems = e.extra.get("problems") if hasattr(e, "extra") else None
        detail = "\n".join("• " + p["message"] for p in problems) if problems else ""
        return [Reply(f"⚠️ {esc(e.message)}\n{detail}"), await wizard_prompt(db, actor, d)]
    clear_dialog(d)
    return [Reply(f"<b>«{esc(w.title)}»</b>\n{msg}\nHolat: {STATE_LABELS.get(w.editorial_state)}", [[webapp("📖 Asarni ochish", f"w_{w.short_code}")], [webapp("🎨 Ustaxonada ochish", f"s_{w.id}")], [cb("« Panel", "a:menu")]])]


async def on_wizard_text(db: AsyncSession, actor: Actor, d: BotDialog, text: str) -> list[Reply]:
    s = d.step
    if s == "title":
        t = text.strip()[:200]
        if not t:
            return [await wizard_prompt(db, actor, d)]
        set_dialog(d, "new_work", "synopsis", title=t)
        await _ensure_work(db, actor, d)  # draft exists from now on
    elif s == "synopsis":
        set_dialog(d, "new_work", "author" if (actor.has("author.post_as") or len(actor.author_ids) > 1) else "genre", synopsis=text.strip()[:2000])
        w = await _ensure_work(db, actor, d)
        w.synopsis = text.strip()[:2000]
    elif s == "author_search":
        from app.core.text import normalize_for_search

        rows = (await db.scalars(select(AuthorProfile).where(AuthorProfile.search_text.ilike(f"%{normalize_for_search(text)}%")).limit(8))).all()
        if not rows:
            return [Reply("Muallif topilmadi. Boshqacha yozib ko'ring."), await wizard_prompt(db, actor, d)]
        return [Reply("Tanlang:", [[cb(a.pen_name[:40], f"nw:pick_author:{a.id}")] for a in rows] + [_nav()])]
    elif s == "text":
        parts = list(d.data.get("text_parts", []))
        parts.append(text)
        set_dialog(d, "new_work", "text", text_parts=parts)
        words = sum(len(p.split()) for p in parts)
        return [Reply(f"{_hdr(d)}Qabul qilindi ({len(parts)}-xabar, ~{words} so'z). Davom eting yoki «Matn tugadi».", [[cb("✅ Matn tugadi", "nw:textdone")], _nav()])]
    elif s == "schedule":
        try:
            local = datetime.strptime(text.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(get_settings().timezone))
        except ValueError:
            return [Reply("Format: <code>2026-11-20 09:00</code>"), await wizard_prompt(db, actor, d)]
        w = await content_svc.get_work(db, d.active_work_id)  # type: ignore[arg-type]
        chs = [c for c in await content_svc.list_chapters(db, w.id) if c.draft_revision_id]
        try:
            for c in chs:
                await content_svc.schedule_publish(db, actor, c, local)
        except AppError as e:
            return [Reply(f"⚠️ {esc(e.message)}"), await wizard_prompt(db, actor, d)]
        clear_dialog(d)
        return [Reply(f"🗓 «{esc(w.title)}» {local:%d.%m.%Y %H:%M} (Toshkent) da nashr qilinadi.", [[webapp("🎨 Ustaxona", f"s_{w.id}")], [cb("« Panel", "a:menu")]])]
    else:
        return [Reply("Iltimos, tugmalardan foydalaning."), await wizard_prompt(db, actor, d)]
    return [await wizard_prompt(db, actor, d)]


async def on_wizard_file(db: AsyncSession, actor: Actor, d: BotDialog, kind: str, data: bytes, filename: str) -> list[Reply]:
    from app.services import assets as asset_svc
    from app.services import importer

    w = await _ensure_work(db, actor, d)
    if d.step == "cover":
        if kind != "photo":
            return [Reply("Muqova uchun rasm yuboring.")]
        asset = await asset_svc.store_upload(db, actor.id, data, filename or "cover.jpg", source="bot", public=True)
        await content_svc.update_work_meta(db, actor, w, {"cover_asset_id": asset.id})
        d.step = "text"
        return [Reply(_hdr(d) + "Muqova saqlandi."), await wizard_prompt(db, actor, d)]
    if d.step == "text" and kind == "document":
        asset = await asset_svc.store_upload(db, actor.id, data, filename, source="bot")
        if asset.kind not in ("text", "docx"):
            return [Reply("Matn uchun TXT, DOCX yoki MD fayl yuboring. PDF faqat biriktirma bo'ladi (keyingi qadamda).")]
        try:
            job = await importer.start_import(db, actor, asset, w.id)
        except AppError as e:
            return [Reply(f"⚠️ {esc(e.message)}"), await wizard_prompt(db, actor, d)]
        if job.status != "parsed" or not job.proposed:
            return [Reply("Fayldan matn olinmadi: " + "; ".join(job.report.get("warnings", []))), await wizard_prompt(db, actor, d)]
        created = await importer.apply_import(db, actor, job)
        rep = job.report
        warn = ("\n⚠️ " + "\n⚠️ ".join(rep.get("warnings", []))) if rep.get("warnings") else ""
        lost = ("\nSaqlanmagan format: " + ", ".join(rep["lost_formatting"])) if rep.get("lost_formatting") else ""
        set_dialog(d, "new_work", "files", imported=True)
        return [Reply(f"{_hdr(d)}Import: {len(created)} ta bob, ~{rep.get('total_words', 0)} so'z qoralamaga qo'shildi.{warn}{lost}\nBoblarni ustaxonada tekshirib chiqing.", [[webapp("👁 Boblarni ko'rish", f"s_{w.id}")]]), await wizard_prompt(db, actor, d)]
    if d.step == "files":
        asset = await asset_svc.store_upload(db, actor.id, data, filename or "file", source="bot")
        purpose = "audio" if asset.kind == "audio" else "attachment"
        await asset_svc.link_asset(db, asset, "work", w.id, purpose, title=filename)
        await content_svc.recompute_work_counters(db, w)
        return [Reply(f"{_hdr(d)}📎 «{esc(filename)}» biriktirildi. Yana yuboring yoki «Keyingisi»."), await wizard_prompt(db, actor, d)]
    return [Reply("Bu qadamda fayl kutilmaydi."), await wizard_prompt(db, actor, d)]


# ---------------------------------------------------------------- work card actions


async def on_work_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    parts = data.split(":")
    wid = int(parts[1])
    act = parts[2] if len(parts) > 2 else ""
    d = await get_dialog(db, actor.user)
    if not act:
        return [await work_card(db, actor, wid)]
    w = await content_svc.get_work(db, wid)
    await content_svc.require_edit_work(db, actor, w)
    try:
        if act == "addch":
            set_dialog(d, "new_work", "text", title=w.title, text_parts=[], chapter_title="")
            d.active_work_id = w.id
            return [Reply(f"📝 <b>«{esc(w.title)}»</b> — yangi bob.\nBob sarlavhasini birinchi qatorda «# Sarlavha» ko'rinishida yozishingiz mumkin."), await wizard_prompt(db, actor, d)]
        if act == "file":
            set_dialog(d, "new_work", "files", title=w.title)
            d.active_work_id = w.id
            return [await wizard_prompt(db, actor, d)]
        if act == "submit":
            await content_svc.submit_for_review(db, actor, w)
            return [Reply("📮 Tekshiruvga yuborildi."), await work_card(db, actor, wid)]
        if act == "pubask":
            chs = [c for c in await content_svc.list_chapters(db, w.id) if c.draft_revision_id]
            names = "\n".join(f"• {esc(c.title)}" for c in chs)
            return [Reply(f"Quyidagilar nashr qilinadi:\n{names}\nTasdiqlaysizmi?", [[cb("🚀 Ha, nashr qilish", f"w:{wid}:pub"), cb(BACK, f"w:{wid}")]])]
        if act == "pub":
            await content_svc.publish_now(db, actor, w)
            return [Reply("🚀 Nashr qilindi.", [[webapp("📖 Ochish", f"w_{w.short_code}")]]), await work_card(db, actor, wid)]
        if act == "sched":
            set_dialog(d, "new_work", "schedule", title=w.title)
            d.active_work_id = w.id
            return [await wizard_prompt(db, actor, d)]
        if act == "delist":
            await content_svc.set_work_state(db, actor, w, "delist", "botdan")
            return [Reply("Katalogdan yashirildi. Oldin xarid qilganlar uchun ochiq qoladi."), await work_card(db, actor, wid)]
    except AppError as e:
        problems = e.extra.get("problems")
        detail = "\n".join("• " + p["message"] for p in problems) if problems else ""
        return [Reply(f"⚠️ {esc(e.message)}\n{detail}"), await work_card(db, actor, wid)]
    return []


async def on_review_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    parts = data.split(":")
    rid = int(parts[1])
    r = await db.get(EditorialReview, rid)
    if r is None:
        return [Reply("Topilmadi.")]
    w = await content_svc.get_work(db, r.work_id)
    if len(parts) == 2:
        ch = await db.get(Chapter, r.chapter_id) if r.chapter_id else None
        req = (w.content_flags or {}).get("requested_access")
        extra = f"\nSo'ralgan kirish: {ACCESS_LABELS.get(req)}" if req else ""
        return [Reply(f"<b>{esc(w.title)}</b>\nBob: {esc(ch.title) if ch else '—'}\nIzoh: {esc(r.note) or '—'}{extra}", [[webapp("👁 Ko'rish va farq", f"s_{w.id}")], [cb("✅ Tasdiqlash", f"rv:{rid}:ok"), cb("✍️ Tuzatish so'rash", f"rv:{rid}:fix")], [cb(BACK, "a:reviews")]])]
    try:
        if parts[2] == "ok":
            await content_svc.decide_review(db, actor, r, "approved")
            return [Reply("Tasdiqlandi."), await reviews_reply(db, actor)]
        if parts[2] == "fix":
            d = await get_dialog(db, actor.user)
            set_dialog(d, "review_note", "note", review_id=rid)
            return [Reply("Muallifga izoh yozing (nima tuzatilsin):", [[cb(CANCEL, "x:cancel")]])]
    except AppError as e:
        return [Reply(f"⚠️ {esc(e.message)}")]
    return []


# ---------------------------------------------------------------- storis wizard


async def on_story_input(db: AsyncSession, actor: Actor, d: BotDialog, *, text: str | None = None, media: tuple[str, bytes, str, dict] | None = None) -> list[Reply]:
    from app.services import assets as asset_svc

    frames = list(d.data.get("frames", []))
    if d.step == "media":
        if media:
            kind, data, fname, meta = media
            asset = await asset_svc.store_upload(db, actor.id, data, fname, source="bot", meta=meta)
            if kind == "video" and meta.get("duration", 0) > get_settings().story_video_max_seconds:
                return [Reply(f"Video {get_settings().story_video_max_seconds} soniyadan oshmasin.")]
            frames.append({"kind": "image" if asset.kind == "image" else "video", "media_asset_id": asset.id, "text": text or ""})
        elif text:
            frames.append({"kind": "text", "text": text[:700]})
        if len(frames) >= 10:
            set_dialog(d, "new_story", "link", frames=frames)
        else:
            set_dialog(d, "new_story", "media", frames=frames)
            return [Reply(f"{len(frames)} ta lavha. Yana yuboring yoki «Tayyor».", [[cb("✅ Tayyor", "ns:done"), cb(CANCEL, "x:cancel")]])]
    return [await story_prompt(db, actor, d)]


async def story_prompt(db: AsyncSession, actor: Actor, d: BotDialog) -> Reply:
    if d.step == "link":
        works = (await db.scalars(select(Work).where(Work.primary_author_id.in_(actor.author_ids or {0}), Work.editorial_state == "published").order_by(Work.updated_at.desc()).limit(8))).all()
        rows = [[cb(f"📖 {w.title[:40]}", f"ns:link:{w.id}")] for w in works]
        rows.append([cb("Havolasiz", "ns:link:0")])
        return Reply("Storis qaysi asarga olib borsin? «Hikoyani o'qish» tugmasi qo'shiladi.", rows)
    if d.step == "duration":
        hours = sorted(set([24] + list(get_settings().story_allowed_hours)))
        return Reply("Necha soat ko'rinsin?", [[cb(f"{h} soat", f"ns:dur:{h}") for h in hours]])
    return Reply("Lavha yuboring.")


async def on_story_callback(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    parts = data.split(":")
    if d.flow != "new_story":
        return [Reply("Storis jarayoni yakunlangan.")]
    if parts[1] == "done":
        if not d.data.get("frames"):
            return [Reply("Kamida bitta lavha yuboring.")]
        d.step = "link"
    elif parts[1] == "link":
        wid = int(parts[2])
        frames = list(d.data.get("frames", []))
        if wid:
            for f in frames:
                f["linked_work_id"] = wid
                f["action_type"] = "read"
        set_dialog(d, "new_story", "duration", frames=frames)
    elif parts[1] == "dur":
        try:
            st = await story_svc.create_story(db, actor, author_id=None, frames=d.data.get("frames", []), duration_hours=int(parts[2]))
        except AppError as e:
            return [Reply(f"⚠️ {esc(e.message)}")]
        clear_dialog(d)
        msg = "Storis nashr qilindi." if st.status == "published" else "Storis tekshiruvga yuborildi."
        return [Reply(msg, [[webapp("Ko'rish", f"st_{st.id}")], [cb("« Panel", "a:menu")]])]
    return [await story_prompt(db, actor, d)]


# ---------------------------------------------------------------- text commands for staff


async def cmd_grant(db: AsyncSession, actor: Actor, args: list[str], revoke: bool = False) -> list[Reply]:
    if len(args) != 2:
        return [Reply("Foydalanish: <code>/grant &lt;telegram_id&gt; &lt;rol&gt;</code>")]
    target = await find_user(db, args[0])
    if target is None:
        return [Reply("Foydalanuvchi topilmadi. U avval botni ochishi kerak.")]
    try:
        if revoke:
            n = await revoke_role(db, actor, target, args[1])
            return [Reply(f"Olib tashlandi: {n} ta.")]
        await grant_role(db, actor, target, args[1])
    except AppError as e:
        return [Reply(f"⚠️ {esc(e.message)}")]
    return [Reply(f"✅ {esc(target.display_name)} — {ROLE_TITLES.get(args[1], args[1])}")]


async def cmd_price(db: AsyncSession, actor: Actor, args: list[str]) -> list[Reply]:
    from app.services.billing import set_price

    if len(args) != 2 or not args[0].isdigit() or not args[1].isdigit():
        return [Reply("Foydalanish: <code>/price &lt;mahsulot_id&gt; &lt;stars&gt;</code>")]
    try:
        v = await set_price(db, actor, int(args[0]), int(args[1]))
    except AppError as e:
        return [Reply(f"⚠️ {esc(e.message)}")]
    return [Reply(f"✅ Yangi narx: {v.amount} ⭐ (versiya {v.version}). Avvalgi buyurtmalar o'z shartida qoladi.")]


async def on_free_text(db: AsyncSession, actor: Actor, text: str) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    if d.flow == "new_work":
        return await on_wizard_text(db, actor, d, text)
    if d.flow == "new_story":
        return await on_story_input(db, actor, d, text=text)
    if d.flow == "search":
        clear_dialog(d)
        return [await works_list(db, actor, all_=actor.has("work.edit_any"), q=text.strip())]
    if d.flow == "paysupport":
        t = SupportTicket(user_id=actor.id, category="payment", subject=text[:60], status="open")
        db.add(t)
        await db.flush()
        db.add(SupportMessage(ticket_id=t.id, author_user_id=actor.id, body=text[:4000]))
        clear_dialog(d)
        return [Reply(f"Murojaat #{t.id} qabul qilindi. Javob shu botga keladi.")]
    if d.flow == "review_note":
        r = await db.get(EditorialReview, int(d.data.get("review_id", 0)))
        clear_dialog(d)
        if r is None:
            return [Reply("Topilmadi.")]
        try:
            await content_svc.decide_review(db, actor, r, "changes_requested", text)
        except AppError as e:
            return [Reply(f"⚠️ {esc(e.message)}")]
        return [Reply("Muallifga tuzatish so'rovi yuborildi.")]
    return [main_menu(actor)]


async def on_cancel_or_save(db: AsyncSession, actor: Actor, data: str) -> list[Reply]:
    d = await get_dialog(db, actor.user)
    wid = d.active_work_id
    if data == "x:save" and d.flow == "new_work":
        parts = (d.data or {}).get("text_parts", [])
        if parts and wid:
            await _finish_text(db, actor, d)
        clear_dialog(d)
        return [Reply("💾 Qoralama saqlandi. /drafts orqali davom ettirasiz.", [[webapp("🎨 Ustaxona", f"s_{wid}")] if wid else [cb("« Panel", "a:menu")]])]
    if d.flow == "new_work" and wid:
        w = await db.get(Work, wid)
        # an empty draft created by this wizard is archived, never deleted silently with content
        if w and w.editorial_state == "draft" and not await content_svc.list_chapters(db, w.id):
            w.editorial_state = "archived"
            w.archived_at = utcnow()
    clear_dialog(d)
    return [Reply("Bekor qilindi.", [[cb("« Panel", "a:menu")]] if actor.is_staff or actor.own_author_id else [])]


def resume_hint(d: BotDialog) -> Reply | None:
    if d.flow == "new_work":
        t = (d.data or {}).get("title")
        return Reply(f"Sizda tugallanmagan jarayon bor: 📝 «{esc(t or 'yangi hikoya')}». Davom etamizmi?", [[cb("▶️ Davom etish", "x:resume"), cb(CANCEL, "x:cancel")]])
    return None


__all__ = ["utcnow"]
