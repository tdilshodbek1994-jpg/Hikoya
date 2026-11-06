import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { InviteFriends } from "../components/growth";
import { Seg, Switch, useToast } from "../components/ui";
import { get, patch, post, type Me } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { requestWriteAccess } from "../lib/tg";

/** E-18: profile, reading & notification settings, links to studio/admin by permission. */
export default function Profile() {
  const { me, setMe, can } = useAuth();
  const t = useT();
  const toast = useToast();
  const { data: ent } = useQuery({ queryKey: ["ent"], queryFn: () => get("/me/entitlements") });
  const { data: rep } = useQuery({ queryKey: ["reading-report"], queryFn: () => get("/me/reading-report") });
  if (!me) return null;
  const save = async (body: Record<string, unknown>) => {
    try {
      setMe(await patch<Me>("/me/preferences", body));
    } catch (e: any) { toast(e.message, true); }
  };
  const botConsent = async (on: boolean) => {
    if (on) {
      const granted = await requestWriteAccess();
      // consent is stored even outside Telegram (the bot asks again on /start)
      await save({ bot_messages_allowed: granted || on });
    } else await save({ bot_messages_allowed: false });
  };
  const np = me.notification_prefs;
  const studio = me.author || can("work.create") || can("work.edit_any") || me.assigned_work_ids.length > 0 || can("work.review");
  const admin = me.is_staff && me.permissions.some((p) => ["catalog.manage", "roles.manage", "comment.moderate", "billing.view", "support.handle", "stats.view_all", "author.manage"].includes(p));
  return (
    <div className="page">
      <div className="header"><h1 className="grow" style={{ fontSize: 22 }}>{t("Profil")}</h1></div>
      <div className="pad stack">
        <div className="panel row">
          <div className="ring" style={{ width: 56, height: 56, padding: 2 }}><div className="av" style={{ fontSize: 22 }}>{me.display_name[0]}</div></div>
          <div className="grow"><b>{me.display_name}</b><div className="small muted">{ent?.premium ? "⭐ Premium" : t("Bepul o'quvchi")}</div>{me.telegram_user_id && <button className="tiny dim link" onClick={() => navigator.clipboard?.writeText(String(me.telegram_user_id))}>ID: {me.telegram_user_id} ⧉</button>}</div>
          <Link to="/premium" className="btn premium" style={{ minHeight: 38 }}>{ent?.premium ? t("Obuna") : "Premium"}</Link>
        </div>
        {studio && <Link to="/studio" className="btn primary block">✍️ {t("Ijod ustaxonasi")}</Link>}
        <InviteFriends />
        {admin && <Link to="/admin" className="btn block">🛠 {t("Boshqaruv")}</Link>}

        {rep && (
          <div className="panel stack" style={{ gap: 8 }}>
            <div className="row between"><b>{t("O'qish ritmi")}</b><span className="small muted">🔥 {rep.streak_days} {t("kun")}</span></div>
            <div className="row" style={{ alignItems: "flex-end", gap: 6, height: 64 }} aria-label={t("Oxirgi 7 kun")}>
              {rep.week.map((d: any) => {
                const max = Math.max(10, ...rep.week.map((x: any) => x.minutes), rep.daily_goal_minutes || 0);
                return (
                  <div key={d.date} className="grow center" title={`${d.date}: ${d.minutes} daq`}>
                    <div style={{ height: Math.max(3, (d.minutes / max) * 48), background: rep.daily_goal_minutes && d.minutes >= rep.daily_goal_minutes ? "var(--ok)" : "var(--accent)", borderRadius: 4 }} />
                    <div className="tiny dim">{new Date(d.date).getDate()}</div>
                  </div>
                );
              })}
            </div>
            <div className="small muted">
              {t("Haftada")}: {rep.total_minutes} {t("daq")} · {rep.chapters_completed} {t("bob")}
              {rep.daily_goal_minutes ? ` · ${t("Bugun")}: ${rep.today_minutes}/${rep.daily_goal_minutes} ${t("daq")}${rep.goal_reached_today ? " ✓" : ""}` : ""}
            </div>
            <span className="tiny dim">{t(rep.note)}</span>
          </div>
        )}

        <h3 className="mt16">{t("Ko'rinish")}</h3>
        <div className="panel stack">
          <div className="row between"><span>{t("Yozuv")}</span><Seg value={me.script} onChange={(v) => save({ script: v })} options={[["latn", "Lotin"], ["cyrl", "Кирилл"]]} /></div>
          <div className="row between"><span>{t("Ilova tili")}</span><Seg value={me.language || "uz"} onChange={(v) => save({ language: v })} options={[["uz", "O'zbek"], ["ru", "Русский"]]} /></div>
          <p className="tiny dim">{t("Kirill–lotin o'girish tarjima emas: bir xil matn boshqa yozuvda ko'rsatiladi.")}</p>
        </div>
        <div className="list">
          <Switch on={me.only_completed} onChange={(v) => save({ only_completed: v })} label={t("Faqat tugallangan asarlar")} />
          <div className="li"><span className="grow">{t("Kunlik o'qish maqsadi")}</span>
            <select className="select" style={{ width: 120 }} value={me.daily_goal_minutes || 0} onChange={(e) => save({ daily_goal_minutes: Number(e.target.value) || 0 })}>
              <option value={0}>{t("Yo'q")}</option>{[10, 20, 30, 60].map((m) => <option key={m} value={m}>{m} {t("daq")}</option>)}
            </select>
          </div>
          <Link to="/onboarding" className="li">{t("Sevimli janrlarni o'zgartirish")}</Link>
        </div>

        <h3 className="mt16">{t("Bildirishnomalar")}</h3>
        <div className="list">
          <Switch on={me.bot_messages_allowed} onChange={botConsent} label={t("Botda xabar olish")} />
          <div className="li"><span className="grow">{t("Rejim")}</span><Seg value={np?.mode || "instant"} onChange={(v) => save({ notification_mode: v })} options={[["instant", t("Tezkor")], ["digest", t("Kunlik yig'ma")]]} /></div>
          <div className="li"><span className="grow">{t("Sokin vaqt")}</span>
            <input className="input" style={{ width: 92 }} type="time" value={np?.quiet_start || "22:00"} onChange={(e) => save({ quiet_start: e.target.value })} aria-label={t("Boshlanishi")} />
            <input className="input" style={{ width: 92 }} type="time" value={np?.quiet_end || "09:00"} onChange={(e) => save({ quiet_end: e.target.value })} aria-label={t("Tugashi")} />
          </div>
          {[["new_chapter", "Yangi boblar"], ["new_work", "Kuzatilgan muallifning yangi asari"], ["comment_reply", "Sharhga javob"], ["work_completed", "Asar tugadi"]].map(([k, l]) => (
            <Switch key={k} on={!np?.disabled_types?.includes(k)} onChange={(on) => save({ disabled_types: on ? (np?.disabled_types || []).filter((x) => x !== k) : [...(np?.disabled_types || []), k] })} label={t(l)} />
          ))}
        </div>
        <p className="tiny dim">{t("Xabarni rad etsangiz ham o'qish to'liq ishlaydi. To'lov tasdiqlari alohida xizmat xabari.")}</p>

        <div className="list mt16">
          <Link to="/notifications" className="li">🔔 {t("Bildirishnomalar markazi")}</Link>
          <Link to="/support" className="li">💬 {t("Yordam va murojaatlar")}</Link>
          <Link to="/library?tab=purchased" className="li">🧾 {t("Sotib olinganlar")}</Link>
        </div>
        <div className="list mt16">
          <button onClick={async () => { const d = await get("/me/export"); const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "hikoya-mening-malumotlarim.json"; a.click(); }}>⬇️ {t("Ma'lumotlarimni yuklab olish")}</button>
          <button onClick={async () => { if (window.confirm(t("Hisobni o'chirish so'rovi yuborilsinmi?"))) { const r = await post("/me/delete-request"); toast(r.note); } }}>🗑 {t("Hisobni o'chirishni so'rash")}</button>
        </div>
        <p className="tiny dim center mt16">HIKOYA PRO · v1.0</p>
      </div>
    </div>
  );
}
