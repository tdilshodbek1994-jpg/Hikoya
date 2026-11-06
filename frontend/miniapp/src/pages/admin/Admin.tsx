import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Route, Routes } from "react-router";
import { Empty, Spinner, TopBar, useToast } from "../../components/ui";
import { del, get, patch, post, uuid } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useT } from "../../lib/i18n";
import { confirmDialog } from "../../lib/tg";
import Analytics from "./Analytics";

/** Staff screens inside the same Mini App. Menu items follow permissions; the API checks them again. */
export default function Admin() {
  const { me } = useAuth();
  const t = useT();
  if (!me?.is_staff) return (<div className="page no-nav"><TopBar title={t("Boshqaruv")} /><Empty icon="🔒" title={t("Vakolat yo'q")} /></div>);
  return (
    <Routes>
      <Route index element={<Menu />} />
      <Route path="moderation" element={<Moderation />} />
      <Route path="home" element={<HomeSections />} />
      <Route path="genres" element={<Genres />} />
      <Route path="staff" element={<Staff />} />
      <Route path="authors" element={<Authors />} />
      <Route path="billing" element={<Billing />} />
      <Route path="support" element={<Support />} />
      <Route path="audit" element={<Audit />} />
      <Route path="analytics" element={<Analytics />} />
    </Routes>
  );
}

function Menu() {
  const t = useT();
  const { can } = useAuth();
  const stats = useQuery({ queryKey: ["admin-stats"], enabled: can("stats.view_all"), queryFn: () => get("/admin/stats") });
  const items: [string, string, string][] = [
    ["stats.view_all", "analytics", "📊 Analitika: faollik, voronka, qaytish"],
    ["comment.moderate", "moderation", "💬 Sharhlar, storis va shikoyatlar"],
    ["catalog.manage", "home", "🏠 Bosh sahifa va tahririyat tanlovi"],
    ["catalog.manage", "genres", "🏷 Janrlar"],
    ["author.manage", "authors", "👤 Mualliflar"],
    ["roles.manage", "staff", "👥 Xodimlar va vakolatlar"],
    ["billing.view", "billing", "⭐ Premium va to'lovlar"],
    ["support.handle", "support", "🛟 Murojaatlar"],
    ["audit.view", "audit", "🧾 Audit"],
  ];
  const s = stats.data;
  return (
    <div className="page no-nav">
      <TopBar title={t("Boshqaruv")} />
      <div className="pad stack">
        {s && (
          <>
            <div className="kpis">
              <div className="kpi"><b>{s.users_total}</b><span>{t("Foydalanuvchilar")}</span></div>
              <div className="kpi"><b>{s.users_new_this_week}</b><span>{t("Shu hafta yangi")}</span></div>
              <div className="kpi"><b>{s.active_today}</b><span>{t("Bugun faol")}</span></div>
              <div className="kpi"><b>{s.works_published_real}</b><span>{t("Real asarlar")}</span></div>
              <div className="kpi"><b>{s.works_demo}</b><span>{t("Demo asarlar")}</span></div>
              <div className="kpi"><b>{s.unique_qualified_readers_this_week}</b><span>{t("Haftalik noyob o'quvchilar")}</span></div>
            </div>
            <p className="tiny dim">{s.note} {t("Hisoblangan")}: {fmtDate(s.computed_at, true)}</p>
          </>
        )}
        <div className="list">
          {items.filter(([p]) => can(p) || (p === "comment.moderate" && can("story.moderate"))).map(([, path, label]) => <Link key={path} to={`/admin/${path}`}>{t(label)}</Link>)}
          <Link to="/studio">✍️ {t("Ijod ustaxonasi")}</Link>
        </div>
      </div>
    </div>
  );
}

function useAct() {
  const toast = useToast();
  return async (fn: () => Promise<any>, ok = "Bajarildi", refetch?: () => void) => {
    try {
      await fn();
      toast(ok);
      refetch?.();
    } catch (e: any) {
      toast(e.message, true);
    }
  };
}

function Moderation() {
  const t = useT();
  const act = useAct();
  const { data, refetch } = useQuery({ queryKey: ["moderation"], queryFn: () => get("/admin/moderation") });
  const mod = async (target_type: string, target_id: number, action: string) => {
    const reason = window.prompt(t("Sabab (majburiy, auditda saqlanadi)"));
    if (!reason) return;
    await act(() => post("/admin/moderation", { target_type, target_id, action, reason }), t("Bajarildi"), refetch);
  };
  if (!data) return <Spinner />;
  return (
    <div className="page no-nav">
      <TopBar title={t("Moderatsiya navbati")} />
      <div className="pad stack">
        <p className="tiny dim">{t("Oddiy tanqid qoidaga zid emas. Yashirish faqat aniq sabab bilan.")}</p>
        <h3>{t("Shikoyatlar")} ({data.reports.length})</h3>
        {data.reports.map((r: any) => (
          <div key={r.id} className="panel small stack" style={{ gap: 6 }}>
            <div className="row between"><span className="pill warn">{r.reason}</span><span className="dim">{r.target_type} #{r.target_id}</span></div>
            {r.preview && <div>{r.preview}</div>}
            {r.note && <div className="muted">{r.note}</div>}
            {r.target_type === "comment" && <div className="row"><button className="btn danger" onClick={() => mod("comment", r.target_id, "hide")}>{t("Yashirish")}</button><button className="btn" onClick={() => mod("comment", r.target_id, "restore")}>{t("Qoldirish")}</button><button className="btn ghost" onClick={() => mod("comment", r.target_id, "restrict")}>{t("3 kun cheklash")}</button></div>}
            {r.target_type === "story" && <div className="row"><button className="btn danger" onClick={() => mod("story", r.target_id, "hide")}>{t("Yashirish")}</button></div>}
          </div>
        ))}
        <h3 className="mt16">{t("Tasdiq kutayotgan sharhlar")} ({data.pending_comments.length})</h3>
        {data.pending_comments.map((c: any) => (
          <div key={c.id} className="panel small"><div>{c.body}</div><div className="row mt8"><button className="btn primary" onClick={() => mod("comment", c.id, "approve")}>{t("Tasdiqlash")}</button><button className="btn danger" onClick={() => mod("comment", c.id, "hide")}>{t("Rad")}</button></div></div>
        ))}
        <h3 className="mt16">{t("Tekshiruvdagi storislar")} ({data.pending_stories.length})</h3>
        {data.pending_stories.map((s: any) => (
          <div key={s.id} className="panel small row"><Link className="grow link" to={`/s/${s.id}`}>#{s.id} {s.caption || t("storis")}</Link><button className="btn primary" onClick={() => mod("story", s.id, "approve")}>{t("Tasdiqlash")}</button><button className="btn danger" onClick={() => mod("story", s.id, "hide")}>{t("Rad")}</button></div>
        ))}
      </div>
    </div>
  );
}

function HomeSections() {
  const t = useT();
  const act = useAct();
  const { data, refetch } = useQuery({ queryKey: ["admin-home"], queryFn: () => get<any[]>("/admin/home-sections") });
  const cur = useQuery({ queryKey: ["admin-curated"], queryFn: () => get("/admin/curated/editors-choice") });
  const [workId, setWorkId] = useState("");
  const [reason, setReason] = useState("");
  const [sponsored, setSponsored] = useState(false);
  if (!data) return <Spinner />;
  const move = (i: number, dir: number) => {
    const a = data[i], b = data[i + dir];
    if (!b) return;
    act(async () => { await patch(`/admin/home-sections/${a.id}`, { sort_order: b.sort_order }); await patch(`/admin/home-sections/${b.id}`, { sort_order: a.sort_order }); }, t("Tartib o'zgardi"), refetch);
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Bosh sahifa")} />
      <div className="pad stack">
        <p className="tiny dim">{t("Lenta nomi, tartibi, filtri, faol vaqti va maksimal kartalar soni.")}</p>
        {data.map((s, i) => (
          <div key={s.id} className="panel stack" style={{ gap: 6 }}>
            <div className="row">
              <div className="stack" style={{ gap: 0 }}><button onClick={() => move(i, -1)} aria-label="up">▲</button><button onClick={() => move(i, 1)} aria-label="down">▼</button></div>
              <input className="input grow" defaultValue={s.title} onBlur={(e) => e.target.value !== s.title && act(() => patch(`/admin/home-sections/${s.id}`, { title: e.target.value }), t("Saqlandi"), refetch)} />
              <button className={`switch ${s.active ? "on" : ""}`} role="switch" aria-checked={s.active} onClick={() => act(() => patch(`/admin/home-sections/${s.id}`, { active: !s.active }), t("Saqlandi"), refetch)} />
            </div>
            <div className="row tiny dim" style={{ gap: 8 }}>
              <span>{s.kind}</span>
              <label>max <input className="input" style={{ width: 60, minHeight: 32 }} type="number" defaultValue={s.max_items} onBlur={(e) => act(() => patch(`/admin/home-sections/${s.id}`, { max_items: Number(e.target.value) }), t("Saqlandi"), refetch)} /></label>
              <label><input type="checkbox" defaultChecked={s.allow_duplicates} onChange={(e) => act(() => patch(`/admin/home-sections/${s.id}`, { allow_duplicates: e.target.checked }), t("Saqlandi"), refetch)} /> {t("takrorlashga ruxsat")}</label>
            </div>
            {s.kind === "rail" && <input className="input" style={{ fontFamily: "monospace", fontSize: 12 }} defaultValue={JSON.stringify(s.filter)} onBlur={(e) => { try { const f = JSON.parse(e.target.value); act(() => patch(`/admin/home-sections/${s.id}`, { filter: f }), t("Filtr saqlandi"), refetch); } catch { /* invalid json */ } }} aria-label="filter" />}
            <div className="row tiny"><label>{t("dan")} <input type="datetime-local" className="input" style={{ minHeight: 32 }} defaultValue={s.starts_at?.slice(0, 16) || ""} onBlur={(e) => act(() => patch(`/admin/home-sections/${s.id}`, { starts_at: e.target.value ? new Date(e.target.value).toISOString() : "" }), t("Saqlandi"), refetch)} /></label>
              <label>{t("gacha")} <input type="datetime-local" className="input" style={{ minHeight: 32 }} defaultValue={s.ends_at?.slice(0, 16) || ""} onBlur={(e) => act(() => patch(`/admin/home-sections/${s.id}`, { ends_at: e.target.value ? new Date(e.target.value).toISOString() : "" }), t("Saqlandi"), refetch)} /></label></div>
          </div>
        ))}
        <h2 className="mt16">{t("Muharrir tavsiyasi")}</h2>
        {cur.data?.items.map((i: any) => (
          <div key={i.id} className="panel row small"><span className="grow">{i.title}{i.sponsored ? ` · ${t("Homiylik")}` : ""}<div className="dim">{i.reason}</div></span><button className="link tiny" onClick={() => act(() => del(`/admin/curated/editors-choice/${i.work_id}`), t("Olib tashlandi"), cur.refetch)}>✕</button></div>
        ))}
        <div className="panel stack">
          <input className="input" placeholder={t("Asar ID")} value={workId} onChange={(e) => setWorkId(e.target.value.replace(/\D/g, ""))} />
          <input className="input" placeholder={t("Nega tavsiya qilinyapti? (bir jumla)")} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label className="row small"><input type="checkbox" checked={sponsored} onChange={(e) => setSponsored(e.target.checked)} /> {t("Homiylik (pulli joy) — ochiq belgilanadi")}</label>
          <button className="btn" disabled={!workId} onClick={() => act(() => post("/admin/curated/editors-choice", { work_id: Number(workId), reason, sponsored }), t("Qo'shildi"), () => { setWorkId(""); setReason(""); cur.refetch(); })}>{t("Qo'shish")}</button>
        </div>
      </div>
    </div>
  );
}

function Genres() {
  const t = useT();
  const act = useAct();
  const { data, refetch } = useQuery({ queryKey: ["admin-genres"], queryFn: () => get<any[]>("/admin/genres") });
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  if (!data) return <Spinner />;
  return (
    <div className="page no-nav">
      <TopBar title={t("Janrlar")} />
      <div className="pad stack">
        {data.map((g) => (
          <div key={g.id} className="panel row">
            <input className="input" style={{ width: 54 }} defaultValue={g.emoji} onBlur={(e) => act(() => patch(`/admin/genres/${g.id}`, { ...g, emoji: e.target.value }), t("Saqlandi"), refetch)} aria-label="emoji" />
            <input className="input grow" defaultValue={g.name} onBlur={(e) => act(() => patch(`/admin/genres/${g.id}`, { ...g, name: e.target.value }), t("Saqlandi"), refetch)} />
            <input className="input" style={{ width: 70 }} type="number" defaultValue={g.sort_order} onBlur={(e) => act(() => patch(`/admin/genres/${g.id}`, { ...g, sort_order: Number(e.target.value) }), t("Saqlandi"), refetch)} aria-label="sort" />
            <button className={`switch ${g.active ? "on" : ""}`} role="switch" aria-checked={g.active} onClick={() => act(() => patch(`/admin/genres/${g.id}`, { ...g, active: !g.active }), t("Saqlandi"), refetch)} />
          </div>
        ))}
        <div className="panel row">
          <input className="input" style={{ width: 54 }} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🙂" />
          <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Yangi janr")} />
          <button className="btn" disabled={!name} onClick={() => act(() => post("/admin/genres", { name, emoji }), t("Qo'shildi"), () => { setName(""); refetch(); })}>+</button>
        </div>
      </div>
    </div>
  );
}

function Staff() {
  const t = useT();
  const act = useAct();
  const { data, refetch } = useQuery({ queryKey: ["admin-roles"], queryFn: () => get("/admin/roles") });
  const [ref, setRef] = useState("");
  const [role, setRole] = useState("author");
  const [scopeWork, setScopeWork] = useState("");
  if (!data) return <Spinner />;
  return (
    <div className="page no-nav">
      <TopBar title={t("Xodimlar va vakolatlar")} />
      <div className="pad stack">
        <div className="panel stack">
          <input className="input" placeholder={t("Telegram ID yoki ichki ID (username emas)")} value={ref} onChange={(e) => setRef(e.target.value)} />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>{data.available.map((r: any) => <option key={r.role} value={r.role}>{r.title}</option>)}</select>
          {role === "editor" && <input className="input" placeholder={t("Asar ID (muharrir biriktiriladigan)")} value={scopeWork} onChange={(e) => setScopeWork(e.target.value.replace(/\D/g, ""))} />}
          <button className="btn primary" disabled={!ref} onClick={() => act(() => post("/admin/roles", { user_ref: ref, role, scope_type: role === "editor" && scopeWork ? "work" : "global", scope_id: role === "editor" && scopeWork ? Number(scopeWork) : null }), t("Rol berildi"), refetch)}>{t("Rol berish")}</button>
        </div>
        {data.grants.map((g: any) => (
          <div key={g.id} className="panel row small">
            <div className="grow"><b>{g.name}</b> <span className="dim">tg:{g.telegram_user_id}</span><div>{g.role}{g.scope_type === "work" ? ` · asar #${g.scope_id}` : ""}</div></div>
            <button className="btn danger" style={{ minHeight: 34 }} onClick={async () => (await confirmDialog(t("Rol olinsinmi?"))) && act(() => del("/admin/roles", { user_ref: String(g.telegram_user_id), role: g.role }), t("Olindi"), refetch)}>{t("Olish")}</button>
          </div>
        ))}
        <details className="small"><summary>{t("Rollar va vakolatlar")}</summary>{data.available.map((r: any) => <div key={r.role} className="mt8"><b>{r.title}</b>: <span className="dim">{r.permissions.join(", ")}</span></div>)}</details>
      </div>
    </div>
  );
}

function Authors() {
  const t = useT();
  const act = useAct();
  const [q, setQ] = useState("");
  const { data, refetch } = useQuery({ queryKey: ["admin-authors", q], queryFn: () => get<any[]>("/admin/authors", { q }) });
  const [name, setName] = useState("");
  const [userRef, setUserRef] = useState("");
  return (
    <div className="page no-nav">
      <TopBar title={t("Mualliflar")} />
      <div className="pad stack">
        <input className="input" placeholder={t("Qidirish")} value={q} onChange={(e) => setQ(e.target.value)} />
        {data?.map((a) => (
          <div key={a.id} className="panel stack" style={{ gap: 6 }}>
            <div className="row between"><Link to={`/a/${a.id}`}><b>{a.pen_name}</b></Link>{a.is_demo && <span className="pill">demo</span>}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button className={`chip ${a.verified ? "on" : ""}`} onClick={() => act(() => patch(`/admin/authors/${a.id}`, { verification_status: a.verified ? "none" : "verified" }), t("Saqlandi"), refetch)}>✓ {t("Tasdiqlangan")}</button>
              <button className={`chip ${a.trusted ? "on" : ""}`} onClick={() => act(() => patch(`/admin/authors/${a.id}`, { publish_policy: a.trusted ? "review" : "trusted" }), t("Saqlandi"), refetch)}>{t("Ishonchli (darhol nashr)")}</button>
              <button className={`chip ${a.featured ? "on" : ""}`} onClick={() => act(() => patch(`/admin/authors/${a.id}`, { editorial_featured: !a.featured }), t("Saqlandi"), refetch)}>{t("Tahririyat tavsiyasi")}</button>
            </div>
          </div>
        ))}
        <div className="panel stack">
          <b>{t("Yangi muallif profili")}</b>
          <input className="input" placeholder={t("Taxallus")} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder={t("Telegram ID (ixtiyoriy)")} value={userRef} onChange={(e) => setUserRef(e.target.value)} />
          <button className="btn" disabled={!name} onClick={() => act(() => post("/admin/authors", { pen_name: name, user_ref: userRef || null }), t("Yaratildi"), () => { setName(""); setUserRef(""); refetch(); })}>{t("Yaratish")}</button>
        </div>
      </div>
    </div>
  );
}

function Billing() {
  const t = useT();
  const act = useAct();
  const { can } = useAuth();
  const prods = useQuery({ queryKey: ["admin-products"], queryFn: () => get<any[]>("/admin/products") });
  const ov = useQuery({ queryKey: ["admin-billing"], queryFn: () => get("/admin/billing") });
  const setPrice = (p: any) => {
    const v = window.prompt(t("Yangi narx (butun Stars)"), String(p.amount || ""));
    if (!v || !/^\d+$/.test(v)) return;
    act(() => post(`/admin/billing/products/${p.id}/price`, { amount: Number(v) }), t("Narx yangilandi — eski buyurtmalar o'z shartida"), prods.refetch);
  };
  const refund = (pid: number) => {
    const reason = window.prompt(t("Qaytarish sababi"));
    if (!reason) return;
    act(() => post(`/admin/billing/payments/${pid}/refund`, { reason, request_key: `rf-${pid}-${uuid()}` }), t("So'rov yuborildi"), ov.refetch);
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Premium va to'lovlar")} />
      <div className="pad stack">
        <h3>{t("Mahsulotlar")}</h3>
        {prods.data?.map((p) => (
          <div key={p.id} className="panel row small">
            <div className="grow"><b>{p.title}</b><div className="dim">{p.sku} · v{p.version} · {p.pricing_type}</div></div>
            <span style={{ color: "var(--premium)", fontWeight: 700 }}>{p.amount} ⭐</span>{p.is_demo && <span className="pill warn">demo</span>}
            {can("billing.manage_products") && <button className="btn" style={{ minHeight: 34 }} onClick={() => setPrice(p)}>{t("Narx")}</button>}
          </div>
        ))}
        <p className="tiny dim">{t("Demo narx real to'lovni yoqmaydi. Narx o'rnatilgach yangi versiya yaratiladi.")}</p>
        {can("billing.manage_products") && <WorkPrice />}
        <RoyaltyAdmin />
        <PromoAdmin />
        <h3 className="mt16">{t("Holatlar")}</h3>
        {ov.data?.by_state.map((s: any) => <div key={s.state} className="small">{s.state}: {s.count} · {s.stars} ⭐</div>)}
        <h3 className="mt16">{t("Tekshiruv kerak bo'lgan to'lovlar")}</h3>
        {!ov.data?.needs_review.length && <p className="small muted">{t("Yo'q")}</p>}
        {ov.data?.needs_review.map((p: any) => (
          <div key={p.id} className="panel small row"><span className="grow">#{p.id} · {p.amount} ⭐ · {p.reason}</span>{can("billing.refund") && <button className="btn danger" style={{ minHeight: 34 }} onClick={() => refund(p.id)}>{t("Qaytarish")}</button>}</div>
        ))}
        <h3 className="mt16">{t("Ochiq qaytarishlar")}</h3>
        {ov.data?.open_refunds.map((r: any) => <div key={r.id} className="small">#{r.id} → {t("to'lov")} #{r.payment_id}: <span className="pill">{r.state}</span> {r.error}</div>)}
        <p className="tiny dim">{ov.data?.note}</p>
      </div>
    </div>
  );
}

function PromoAdmin() {
  const t = useT();
  const act = useAct();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["admin-promo"], queryFn: () => get("/admin/promo-codes") });
  const [f, setF] = useState({ code: "", days: "7", max_uses: "", valid_until: "", new_users_only: false, note: "" });
  const create = () => act(() => post("/admin/promo-codes", {
    code: f.code || null, days: Number(f.days), max_uses: f.max_uses ? Number(f.max_uses) : null,
    valid_until: f.valid_until ? new Date(f.valid_until).toISOString() : null, new_users_only: f.new_users_only, note: f.note,
  }), t("Kod yaratildi"), () => { setF({ ...f, code: "", note: "" }); q.refetch(); });
  return (
    <div className="panel stack">
      <b>🎟 {t("Promo-kodlar")}</b>
      <span className="tiny dim">{t("Kod N kun Premium beradi. Har foydalanuvchi bir marta ishlatadi. Stars to'loviga aloqasi yo'q.")}</span>
      {can("billing.manage_products") && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><input className="input grow" placeholder={t("Kod (bo'sh = avtomatik)")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /><input className="input" style={{ width: 70 }} inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value.replace(/\D/g, "") })} /><span className="small">{t("kun")}</span></div>
          <div className="row"><input className="input grow" inputMode="numeric" placeholder={t("Limit (ixtiyoriy)")} value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value.replace(/\D/g, "") })} /><input className="input grow" type="datetime-local" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} /></div>
          <input className="input" placeholder={t("Izoh (masalan: kanal aksiyasi)")} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <label className="row small"><input type="checkbox" checked={f.new_users_only} onChange={(e) => setF({ ...f, new_users_only: e.target.checked })} /> {t("Faqat yangi foydalanuvchilar")}</label>
          <button className="btn" disabled={!f.days} onClick={create}>{t("Kod yaratish")}</button>
        </div>
      )}
      {(q.data?.items || []).map((p: any) => (
        <div key={p.id} className="row small">
          <span className="grow"><b>{p.code}</b> · {p.days} {t("kun")} · {p.uses}{p.max_uses ? `/${p.max_uses}` : ""}{p.note ? ` · ${p.note}` : ""}{!p.active && <span className="pill warn"> {t("o'chirilgan")}</span>}</span>
          {p.active && can("billing.manage_products") && <button className="tiny link" onClick={() => act(() => del(`/admin/promo-codes/${p.id}`), t("O'chirildi"), q.refetch)}>{t("O'chirish")}</button>}
        </div>
      ))}
    </div>
  );
}

function RoyaltyAdmin() {
  const t = useT();
  const act = useAct();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["admin-royalties"], queryFn: () => get("/admin/royalties") });
  const items: any[] = q.data?.items || [];
  const payout = (a: any) => {
    const note = window.prompt(t("Qanday to'landi? (masalan: karta, sana)"));
    if (!note || note.trim().length < 3) return;
    act(() => post(`/admin/royalties/${a.author_id}/payout`, { note }), t("To'lov qayd etildi"), q.refetch);
  };
  return (
    <div className="panel stack">
      <b>{t("Mualliflar ulushi (royalti)")}</b>
      <span className="tiny dim">{t("Ulush foizi .env da: HIKOYA_ROYALTY_SHARE_PERCENT. To'lov ilovadan tashqarida qilinadi va shu yerda qayd etiladi.")}</span>
      {!items.length && <span className="small muted">{t("Hozircha yozuv yo'q")}</span>}
      {items.map((a) => (
        <div key={a.author_id} className="row small">
          <span className="grow">{a.pen_name}<div className="tiny dim">{t("kutilmoqda")} {a.pending} · {t("tayyor")} {a.available} · {t("to'langan")} {a.paid} · {t("qaytarilgan")} {a.reversed} ⭐</div></span>
          {can("billing.refund") && a.available > 0 && <button className="btn" style={{ minHeight: 34 }} onClick={() => payout(a)}>{t("To'landi")}</button>}
        </div>
      ))}
    </div>
  );
}

function WorkPrice() {
  const t = useT();
  const act = useAct();
  const [workId, setWorkId] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <div className="panel stack">
      <b>{t("Alohida asarni sotish")}</b>
      <span className="tiny dim">{t("Asar kirish siyosati «Alohida xarid» yoki «Premium yoki xarid» bo'lishi kerak. Xarid shu asarning mavjud va kelajakdagi boblarini ochadi.")}</span>
      <div className="row"><input className="input" placeholder={t("Asar ID")} value={workId} onChange={(e) => setWorkId(e.target.value.replace(/\D/g, ""))} /><input className="input" placeholder="⭐" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} /></div>
      <button className="btn" disabled={!workId || !amount} onClick={() => act(() => post(`/admin/billing/works/${workId}/product`, { amount: Number(amount) }), t("Narx belgilandi"))}>{t("Saqlash")}</button>
    </div>
  );
}

function Support() {
  const t = useT();
  const act = useAct();
  const [status, setStatus] = useState("open");
  const { data, refetch } = useQuery({ queryKey: ["admin-support", status], queryFn: () => get<any[]>("/admin/support", { status }) });
  const [reply, setReply] = useState<Record<number, string>>({});
  return (
    <div className="page no-nav">
      <TopBar title={t("Murojaatlar")} />
      <div className="pad stack">
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">open</option><option value="in_progress">in_progress</option><option value="resolved">resolved</option><option value="closed">closed</option></select>
        {!data ? <Spinner /> : !data.length ? <Empty icon="🛟" title={t("Murojaat yo'q")} /> : data.map((tk) => (
          <div key={tk.id} className="panel stack small" style={{ gap: 6 }}>
            <div className="row between"><b>#{tk.id} {tk.subject}</b><span className="pill">{tk.category}</span></div>
            {tk.payment_id && <span className="dim">{t("To'lov")} #{tk.payment_id}</span>}
            {tk.messages.map((m: any, i: number) => <div key={i} className={m.staff ? "" : "muted"}>{m.staff ? "🛟 " : "👤 "}{m.body}</div>)}
            <textarea className="textarea" style={{ minHeight: 60 }} value={reply[tk.id] || ""} onChange={(e) => setReply((r) => ({ ...r, [tk.id]: e.target.value }))} />
            <div className="row"><button className="btn primary" onClick={() => act(() => post(`/admin/support/${tk.id}`, { body: reply[tk.id] || "", status: "in_progress" }), t("Yuborildi"), refetch)}>{t("Javob")}</button><button className="btn" onClick={() => act(() => post(`/admin/support/${tk.id}`, { body: reply[tk.id] || "", status: "resolved" }), t("Yopildi"), refetch)}>{t("Hal qilindi")}</button></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Audit() {
  const t = useT();
  const [tt, setTt] = useState("");
  const { data } = useQuery({ queryKey: ["audit", tt], queryFn: () => get<any[]>("/studio/audit", { target_type: tt || undefined, limit: 200 }) });
  return (
    <div className="page no-nav">
      <TopBar title={t("Audit")} />
      <div className="pad stack">
        <select className="select" value={tt} onChange={(e) => setTt(e.target.value)}>
          <option value="">{t("Barchasi")}</option>{["work", "chapter", "user", "payment", "product", "comment", "story", "author", "setting"].map((x) => <option key={x}>{x}</option>)}
        </select>
        {!data ? <Spinner /> : (
          <table className="t"><tbody>{data.map((a) => (
            <tr key={a.id}><td className="tiny dim">{fmtDate(a.at, true)}</td><td><b>{a.action}</b><div className="tiny dim">{a.target} · actor {a.actor_user_id}{a.on_behalf_of_author_id ? ` · muallif nomidan #${a.on_behalf_of_author_id}` : ""}</div>{a.reason && <div className="tiny">{a.reason}</div>}</td></tr>
          ))}</tbody></table>
        )}
      </div>
    </div>
  );
}
