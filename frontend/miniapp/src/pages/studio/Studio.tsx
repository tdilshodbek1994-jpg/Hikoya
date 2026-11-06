import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { Cover, Empty, Spinner, TopBar, useToast } from "../../components/ui";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useT } from "../../lib/i18n";
import ChapterEditor from "./ChapterEditor";
import History from "./History";
import ImportPage from "./ImportPage";
import Reviews from "./Reviews";
import StoryComposer, { MyStories } from "./StoryComposer";
import { Royalties } from "./Extras";
import WorkEditor from "./WorkEditor";

export const STATE_LABEL: Record<string, string> = {
  draft: "Qoralama", in_review: "Tekshiruvda", changes_requested: "Tuzatish so'ralgan", approved: "Tasdiqlangan", scheduled: "Rejalashtirilgan",
  published: "Nashr qilingan", unpublished: "Nashrdan olingan", delisted: "Katalogdan yashirilgan", archived: "Arxivda", suspended: "To'xtatilgan",
};

/** E-21…E-24 live inside the same Mini App. The server checks every permission again. */
export default function Studio() {
  const { me, can } = useAuth();
  const t = useT();
  const allowed = !!me && (!!me.author || can("work.create") || can("work.edit_any") || can("work.review") || me.assigned_work_ids.length > 0);
  if (!allowed) {
    return (
      <div className="page no-nav">
        <TopBar title={t("Ijod ustaxonasi")} />
        <Empty icon="✍️" title={t("Ustaxona mualliflar va xodimlar uchun")}>
          <Link to="/support?apply=author" className="btn primary mt8">{t("Muallif bo'lish uchun ariza")}</Link>
        </Empty>
      </div>
    );
  }
  return (
    <Routes>
      <Route index element={<Dashboard />} />
      <Route path="new" element={<NewWork />} />
      <Route path="w/:id" element={<WorkEditor />} />
      <Route path="e/:chapterId" element={<ChapterEditor />} />
      <Route path="h/:chapterId" element={<History />} />
      <Route path="p/:chapterId" element={<Preview />} />
      <Route path="import/:workId" element={<ImportPage />} />
      <Route path="reviews" element={<Reviews />} />
      <Route path="stories" element={<MyStories />} />
      <Route path="stories/new" element={<StoryComposer />} />
      <Route path="calendar" element={<Calendar />} />
      <Route path="royalties" element={<Royalties />} />
      <Route path="stats" element={<Dashboard />} />
      <Route path="stats/:workId" element={<WorkStats />} />
    </Routes>
  );
}

function Dashboard() {
  const t = useT();
  const { can, me } = useAuth();
  const [scope, setScope] = useState<"mine" | "all" | "assigned">(can("work.edit_any") && !me?.author ? "all" : me?.author ? "mine" : me?.assigned_work_ids.length ? "assigned" : "mine");
  const works = useQuery({ queryKey: ["studio-works", scope], queryFn: () => get<any[]>("/studio/works", { scope }) });
  const dash = useQuery({ queryKey: ["studio-dash"], queryFn: () => get("/studio/dashboard") });
  const d = dash.data;
  return (
    <div className="page no-nav">
      <TopBar title={t("Ijod ustaxonasi")} right={<Link to="/studio/new" className="btn primary" style={{ minHeight: 38 }}>+ {t("Asar")}</Link>} />
      <div className="pad stack">
        <div className="row wrap" style={{ gap: 8 }}>
          {(can("work.review") || can("work.publish") || !!me?.assigned_work_ids.length) && <Link to="/studio/reviews" className="chip">✅ {t("Tekshiruv navbati")}</Link>}
          <Link to="/studio/calendar" className="chip">🗓 {t("Nashr taqvimi")}</Link>
          {me?.author && <Link to="/studio/stories" className="chip">📮 {t("Storislarim")}</Link>}
          {me?.author && <Link to="/studio/stories/new" className="chip">+ {t("Storis")}</Link>}
          {me?.author && <Link to="/studio/royalties" className="chip">💰 {t("Daromad")}</Link>}
        </div>
        {d && (
          <div className="kpis">
            <div className="kpi"><b>{d.drafts.length}</b><span>{t("Yarim qolgan qoralamalar")}</span></div>
            <div className="kpi"><b>{d.scheduled.length}</b><span>{t("Navbatdagi boblar")}</span></div>
            <div className="kpi"><b>{d.unanswered_comments.length}</b><span>{t("Javobsiz sharhlar")}</span></div>
            <div className="kpi"><b>{Object.values(d.thanks_by_reason as Record<string, number>).reduce((a, b) => a + b, 0)}</b><span>{t("Rahmatlar")}</span></div>
          </div>
        )}
        {!!d?.review_answers.length && (
          <div className="panel">
            <b>{t("Tekshiruv javoblari")}</b>
            {d.review_answers.map((r: any) => (
              <Link key={r.id} to={`/studio/w/${r.work_id}`} className="row mt8 small"><span className={`pill ${r.decision === "approved" ? "ok" : "warn"}`}>{r.decision === "approved" ? t("Tasdiqlandi") : t("Tuzatish")}</span><span className="grow muted">{r.note}</span></Link>
            ))}
          </div>
        )}
        {!!d?.draft_chapters.length && (
          <div className="panel">
            <b>{t("Bugun davom ettirish")}</b>
            {d.draft_chapters.slice(0, 5).map((c: any) => (
              <Link key={c.id} to={`/studio/e/${c.id}`} className="row mt8 small"><span>✏️</span><span className="grow">{c.work_title} — {c.title}</span></Link>
            ))}
          </div>
        )}
        {!!d?.unanswered_comments.length && (
          <div className="panel">
            <b>{t("Javob kutayotgan sharhlar")}</b>
            {d.unanswered_comments.slice(0, 5).map((c: any) => <div key={c.id} className="small muted mt8">💬 {c.body}</div>)}
          </div>
        )}
        <p className="tiny dim">{d?.income_note}</p>
        <div className="row between mt8">
          <h2>{t("Asarlar")}</h2>
          <select className="select" style={{ width: "auto" }} value={scope} onChange={(e) => setScope(e.target.value as any)}>
            <option value="mine">{t("Meniki")}</option>
            {!!me?.assigned_work_ids.length && <option value="assigned">{t("Biriktirilgan")}</option>}
            {can("work.edit_any") && <option value="all">{t("Barchasi")}</option>}
          </select>
        </div>
      </div>
      {works.isLoading ? <Spinner /> : !works.data?.length ? <Empty icon="📝" title={t("Hali asar yo'q")}><Link to="/studio/new" className="btn primary mt8">{t("Birinchi asarni yaratish")}</Link></Empty> : (
        <div className="mt8">
          {works.data.map((w) => (
            <Link key={w.id} to={`/studio/w/${w.id}`} className="lrow">
              <Cover card={{ title: w.title, cover_url: w.cover_url, genre: null, author: null, access: "FREE", progress: null, is_demo: w.is_demo }} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{w.title}</div>
                <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                  <span className={`pill ${w.editorial_state === "published" ? "ok" : w.editorial_state === "changes_requested" ? "warn" : ""}`}>{t(STATE_LABEL[w.editorial_state] || w.editorial_state)}</span>
                  <span className="pill">{w.access_policy}</span>
                  {w.requested_access && <span className="pill warn">{t("so'ralgan")}: {w.requested_access}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NewWork() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data: genres } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });
  const authors = useQuery({ queryKey: ["admin-authors"], enabled: can("author.post_as"), queryFn: () => get<any[]>("/admin/authors") });
  const [f, setF] = useState({ title: "", synopsis: "", format: "short", completion_state: "completed", script: "latn", primary_genre_id: 0, access_policy: "FREE", author_id: 0 });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const w = await post("/studio/works", { ...f, primary_genre_id: f.primary_genre_id || null, author_id: f.author_id || null });
      nav(`/studio/w/${w.id}`, { replace: true });
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  return (
    <div className="page no-nav">
      <TopBar title={t("Yangi asar")} />
      <div className="pad stack">
        <p className="tiny dim">{t("Faqat sarlavha majburiy. Qolganlarini keyin to'ldirasiz.")}</p>
        <div className="field"><label>{t("Sarlavha")} *</label><input className="input" value={f.title} maxLength={200} onChange={(e) => set("title", e.target.value)} /></div>
        <div className="field"><label>{t("Qisqa annotatsiya")}</label><textarea className="textarea" value={f.synopsis} maxLength={4000} onChange={(e) => set("synopsis", e.target.value)} /></div>
        {can("author.post_as") && (
          <div className="field"><label>{t("Muallif")}</label>
            <select className="select" value={f.author_id} onChange={(e) => set("author_id", Number(e.target.value))}>
              <option value={0}>{t("O'zim")}</option>
              {authors.data?.map((a) => <option key={a.id} value={a.id}>{a.pen_name}</option>)}
            </select>
            <span className="tiny dim">{t("Kim nomidan joylangani auditda saqlanadi; haqiqiy mualliflik alohida.")}</span>
          </div>
        )}
        <div className="field"><label>{t("Asosiy janr")}</label>
          <select className="select" value={f.primary_genre_id} onChange={(e) => set("primary_genre_id", Number(e.target.value))}>
            <option value={0}>—</option>{genres?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="row">
          <div className="field grow"><label>{t("Format")}</label>
            <select className="select" value={f.format} onChange={(e) => set("format", e.target.value)}>
              <option value="short">{t("Qisqa hikoya")}</option><option value="novella">{t("Qissa")}</option><option value="novel">{t("Roman")}</option><option value="series">{t("Turkum")}</option><option value="diary">{t("Kundalik")}</option>
            </select>
          </div>
          <div className="field grow"><label>{t("Holat")}</label>
            <select className="select" value={f.completion_state} onChange={(e) => set("completion_state", e.target.value)}>
              <option value="ongoing">{t("Davom etmoqda")}</option><option value="completed">{t("Tugallangan")}</option><option value="paused">{t("Tanaffusda")}</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field grow"><label>{t("Yozuv")}</label>
            <select className="select" value={f.script} onChange={(e) => set("script", e.target.value)}><option value="latn">{t("Lotin")}</option><option value="cyrl">Кирилл</option></select>
          </div>
          <div className="field grow"><label>{t("Kirish")}</label>
            <select className="select" value={f.access_policy} onChange={(e) => set("access_policy", e.target.value)}>
              <option value="FREE">{t("Bepul")}</option><option value="PREMIUM">Premium</option><option value="PURCHASE">{t("Alohida xarid")}</option><option value="PREMIUM_OR_PURCHASE">{t("Premium yoki xarid")}</option>
            </select>
          </div>
        </div>
        {f.access_policy !== "FREE" && !can("work.change_access") && <p className="tiny" style={{ color: "var(--premium)" }}>{t("Pulli siyosat administrator tasdiqlagandan keyin yoqiladi.")}</p>}
        <button className="btn primary big block" disabled={busy || !f.title.trim()} onClick={create}>{t("Qoralama yaratish")}</button>
      </div>
    </div>
  );
}

function Preview() {
  const { chapterId } = useParams();
  const t = useT();
  const { data } = useQuery({ queryKey: ["studio-preview", chapterId], queryFn: () => get(`/studio/chapters/${chapterId}/preview`) });
  if (!data) return <Spinner />;
  return (
    <div className="reader dark serif w-normal">
      <TopBar title={`${t("Oldindan ko'rish")} · ${data.work.title}`} />
      <div className="rtext" style={{ paddingTop: 16, fontSize: 19, lineHeight: 1.65 }}>
        <p className="tiny" style={{ color: "var(--premium)" }}>{t("Bu ruxsatli preview — statistikaga qo'shilmaydi.")} {t("Bepul namuna")}: {data.preview_blocks} {t("blok")}</p>
        <h1 className="ch-title">{data.chapter.title}</h1>
        {data.content.content.map((b: any, i: number) => (
          <div key={b.attrs.bid} style={i === data.preview_blocks ? { borderTop: "2px dashed var(--premium)", paddingTop: 12 } : undefined}>
            {b.type === "heading" ? <h2>{b.content.map((n: any) => n.text).join("")}</h2> : b.type === "horizontalRule" ? <hr /> : b.type === "image" ? <figure><img src={data.images[String(b.attrs.asset_id)]} alt="" /><figcaption>{b.attrs.caption}</figcaption></figure> : <p>{(b.content || []).map((n: any, j: number) => (n.type === "hardBreak" ? <br key={j} /> : <span key={j} style={{ fontWeight: n.marks?.some((m: any) => m.type === "bold") ? 700 : undefined, fontStyle: n.marks?.some((m: any) => m.type === "italic") ? "italic" : undefined }}>{n.text}</span>))}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Calendar() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["calendar"], queryFn: () => get<any[]>("/studio/calendar") });
  return (
    <div className="page no-nav">
      <TopBar title={t("Nashr taqvimi")} />
      <p className="pad tiny dim">{t("Vaqtlar Toshkent vaqtida. O'quvchi faqat tasdiqlangan jadvalni ko'radi.")}</p>
      {!data ? <Spinner /> : !data.length ? <Empty icon="🗓" title={t("Rejalashtirilgan nashr yo'q")} /> : (
        <div className="pad stack">
          {data.map((j) => (
            <Link key={j.job_id} to={`/studio/w/${j.work_id}`} className="panel">
              <div className="row between"><b>{fmtDate(j.run_at, true)}</b><span className={`pill ${j.status === "failed" ? "err" : ""}`}>{j.status === "failed" ? t("Xato") : t("Navbatda")}</span></div>
              <div className="small muted">{j.work_title} — {j.chapter_title}</div>
              {j.error && <div className="tiny" style={{ color: "var(--danger)" }}>{j.error}</div>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkStats() {
  const { workId } = useParams();
  const t = useT();
  const { data } = useQuery({ queryKey: ["work-stats", workId], queryFn: () => get(`/studio/works/${workId}/stats`) });
  if (!data) return <Spinner />;
  const k = (v: any) => (v === null || v === undefined ? "—" : v);
  return (
    <div className="page no-nav">
      <TopBar title={t("Asar statistikasi")} />
      <div className="pad stack">
        <div className="kpis">
          <div className="kpi"><b>{data.unique_qualified_readers}</b><span>{t("Noyob o'quvchilar")}</span></div>
          <div className="kpi"><b>{data.started}</b><span>{t("Boshlaganlar")}</span></div>
          <div className="kpi"><b>{data.finished}</b><span>{t("Yakunlaganlar")}</span></div>
          <div className="kpi"><b>{k(data.start_to_finish)}</b><span>{t("Boshlash/yakunlash")}</span></div>
          <div className="kpi"><b>{data.followers}</b><span>{t("Kuzatuvchilar")}</span></div>
          <div className="kpi"><b>{k(data.reads_from_storis)}</b><span>{t("Storisdan kelgan")}</span></div>
          <div className="kpi"><b>{data.likes}</b><span>{t("Layk")}</span></div>
          <div className="kpi"><b>{data.thanks}</b><span>{t("Rahmat")}</span></div>
          <div className="kpi"><b>{data.comments}</b><span>{t("Sharh")}</span></div>
        </div>
        {data.small_sample && <p className="small" style={{ color: "var(--premium)" }}>{t("Namuna kichik: nozik kesimlar yashirilgan.")}</p>}
        <h3>{t("Boblar bo'yicha")}</h3>
        <table className="t"><thead><tr><th>{t("Bob")}</th><th>{t("Tugatgan")}</th><th>{t("Keyingisiga o'tish")}</th></tr></thead>
          <tbody>{data.chapters.map((c: any) => <tr key={c.chapter_id}><td>{c.title}</td><td>{k(c.completed)}</td><td>{c.next_transition === null ? "—" : `${Math.round(c.next_transition * 100)}%`}</td></tr>)}</tbody>
        </table>
        <p className="tiny dim">{data.note}</p>
        <button className="btn ghost" onClick={async () => {
          const r = await fetch(`/api/v1/studio/works/${workId}/stats.csv`, { headers: { Authorization: `Bearer ${sessionStorage.getItem("hk_token")}` } });
          const url = URL.createObjectURL(await r.blob());
          const a = document.createElement("a"); a.href = url; a.download = `asar-${workId}-statistika.csv`; a.click();
        }}>⬇️ {t("CSV yuklab olish")}</button>
      </div>
    </div>
  );
}
