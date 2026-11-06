import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Cover, Sheet, Spinner, TopBar, useToast } from "../../components/ui";
import { ApiError, api, del, get, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useT } from "../../lib/i18n";
import { confirmDialog } from "../../lib/tg";
import { AiSynopsis, BetaInvites, CharactersManager } from "./Extras";
import { STATE_LABEL } from "./Studio";

export async function upload(file: File, purpose: string, isPublic = false) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("purpose", purpose);
  fd.append("public", String(isPublic));
  return api("/studio/assets/upload", { method: "POST", form: fd });
}

/** E-21: metadata (separate from text), chapters, files, review/publish/schedule and state actions. */
export default function WorkEditor() {
  const { id } = useParams();
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const key = ["studio-work", id];
  const { data: w, isLoading, refetch } = useQuery({ queryKey: key, queryFn: () => get(`/studio/works/${id}`) });
  const { data: genres } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });
  const { data: moods } = useQuery({ queryKey: ["tags", "mood"], queryFn: () => get<any[]>("/tags") });
  const [meta, setMeta] = useState<any>(null);
  const [problems, setProblems] = useState<any[] | null>(null);
  const [sched, setSched] = useState<any>(null);
  const [when, setWhen] = useState("");
  const coverRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (w) setMeta({ title: w.title, synopsis: w.synopsis, format: w.format, completion_state: w.completion_state, script: w.script, comments_policy: w.comments_policy, planned_chapters: w.planned_chapters ?? "", next_release_note: w.next_release_note, primary_genre_id: w.primary_genre_id, genre_ids: w.genre_ids, tag_ids: w.tag_ids, content_flags: w.content_flags || {} });
  }, [w]);
  if (isLoading || !w || !meta) return (<div className="page no-nav"><TopBar /><Spinner /></div>);

  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      setProblems(null);
      await refetch();
      qc.invalidateQueries({ queryKey: ["studio-works"] });
    } catch (e) {
      if (e instanceof ApiError && e.data.problems) setProblems(e.data.problems as any[]);
      toast(e instanceof Error ? e.message : "Xato", true);
    }
  };
  const saveMeta = () =>
    run(async () => {
      const r = await patch(`/studio/works/${w.id}`, { ...meta, planned_chapters: meta.planned_chapters === "" ? null : Number(meta.planned_chapters), version: w.version });
      qc.setQueryData(key, r);
    }, t("Metama'lumot saqlandi"));
  const onCover = async (f?: File) => {
    if (!f) return;
    await run(async () => {
      const a = await upload(f, "cover", true);
      await post("/studio/assets/link", { asset_id: a.asset_id, target_type: "work", target_id: w.id, purpose: "cover" });
    }, t("Muqova yangilandi"));
  };
  const onFile = async (f?: File) => {
    if (!f) return;
    await run(async () => {
      const a = await upload(f, "attachment");
      await post("/studio/assets/link", { asset_id: a.asset_id, target_type: "work", target_id: w.id, purpose: a.kind === "audio" ? "audio" : "attachment", title: f.name });
    }, t("Fayl biriktirildi"));
  };
  const addChapter = async (copyFrom?: number) => {
    const r = await post(`/studio/works/${w.id}/chapters`, { title: "", copy_settings_from_chapter: copyFrom });
    nav(`/studio/e/${r.id}`);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const ids = w.chapters.map((c: any) => c.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => post(`/studio/works/${w.id}/chapters/reorder`, { chapter_ids: ids }));
  };
  const schedule = () =>
    run(async () => {
      const local = new Date(when);
      // the browser gives local time; send it with an explicit offset (server stores UTC)
      await post("/studio/publish-jobs", { chapter_id: sched.id, run_at: local.toISOString() });
      setSched(null);
    }, t("Rejalashtirildi"));
  const stateAction = async (action: string, needReason = false) => {
    const reason = needReason ? window.prompt(t("Sabab")) || "" : "";
    if (needReason && !reason) return;
    if (!(await confirmDialog(t("Tasdiqlaysizmi?")))) return;
    run(() => post(`/studio/works/${w.id}/state`, { action, reason }), t("Bajarildi"));
  };
  const drafts = w.chapters.filter((c: any) => c.draft_revision_id);
  const set = (k: string, v: any) => setMeta((m: any) => ({ ...m, [k]: v }));

  return (
    <div className="page no-nav">
      <TopBar title={w.title} right={<Link to={`/w/${w.code}`} className="link small">{t("Ommaviy")}</Link>} />
      <div className="pad stack">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <button onClick={() => coverRef.current?.click()} style={{ width: 96 }} aria-label={t("Muqovani almashtirish")}>
            <Cover card={{ title: w.title, cover_url: w.cover_url, genre: null, author: null, access: "FREE", progress: null, is_demo: w.is_demo }} />
            <div className="tiny dim center mt8">{t("Muqova 2:3")}</div>
          </button>
          <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => onCover(e.target.files?.[0])} />
          <div className="grow stack" style={{ gap: 6 }}>
            <span className="pill">{t(STATE_LABEL[w.editorial_state] || w.editorial_state)}</span>
            <span className="small muted">{t("Kirish")}: {w.access_policy}{w.requested_access ? ` (${t("so'ralgan")}: ${w.requested_access})` : ""}</span>
            <Link className="link small" to={`/studio/stats/${w.id}`}>📊 {t("Statistika")}</Link>
          </div>
        </div>

        {problems && (
          <div className="panel" style={{ borderColor: "var(--danger)" }}>
            <b>{t("Nashrdan oldingi tekshiruv")}</b>
            {problems.map((p, i) => <div key={i} className="small mt8">• {p.message}</div>)}
          </div>
        )}

        <div className="row wrap" style={{ gap: 8 }}>
          {!!drafts.length && <button className="btn" onClick={() => run(() => post(`/studio/works/${w.id}/submit`, {}), t("Tekshiruvga yuborildi"))}>📮 {t("Tekshiruvga yuborish")}</button>}
          {!!drafts.length && w.can_publish && <button className="btn primary" onClick={() => run(() => post(`/studio/works/${w.id}/publish`, {}), t("Nashr qilindi"))}>🚀 {t("Hozir nashr")}</button>}
          {w.editorial_state === "unpublished" && w.can_publish && <button className="btn primary" onClick={() => run(() => post(`/studio/works/${w.id}/publish`, {}), t("Qayta nashr qilindi"))}>{t("Qayta nashr")}</button>}
          <button className="btn ghost" onClick={async () => setProblems((await get(`/studio/works/${w.id}/check`)).problems)}>{t("Texnik tekshiruv")}</button>
        </div>
        {problems && !problems.length && <p className="small" style={{ color: "var(--ok)" }}>✓ {t("Muammo topilmadi")}</p>}

        <div className="row between mt16"><h2>{t("Boblar")}</h2>
          <div className="row"><Link to={`/studio/import/${w.id}`} className="btn ghost" style={{ minHeight: 36 }}>{t("Import")}</Link><button className="btn" style={{ minHeight: 36 }} onClick={() => addChapter()}>+ {t("Bob")}</button></div>
        </div>
        <div className="list">
          {w.chapters.map((c: any, i: number) => (
            <div key={c.id} className="li" style={{ alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: 0 }}>
                <button aria-label={t("Yuqoriga")} onClick={() => move(i, -1)} disabled={i === 0}>▲</button>
                <button aria-label={t("Pastga")} onClick={() => move(i, 1)} disabled={i === w.chapters.length - 1}>▼</button>
              </div>
              <Link to={`/studio/e/${c.id}`} className="grow">
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div className="row wrap tiny" style={{ gap: 6, marginTop: 4 }}>
                  <span className="pill">{t(STATE_LABEL[c.editorial_state] || c.editorial_state)}</span>
                  {c.draft_revision_id && c.published_revision_id && <span className="pill warn">{t("Nashr qilinmagan tahrir bor")}</span>}
                  {c.access_override !== "inherit" && <span className="pill">{c.access_override}</span>}
                  <span className="dim">{c.words} {t("so'z")} · ~{c.minutes} {t("daq")}</span>
                </div>
                {c.scheduled && <div className="tiny mt8" style={{ color: c.scheduled.status === "failed" ? "var(--danger)" : "var(--premium)" }}>🗓 {fmtDate(c.scheduled.run_at, true)} {c.scheduled.error}</div>}
              </Link>
              <div className="stack" style={{ gap: 4 }}>
                {c.draft_revision_id && w.can_publish && <button className="tiny link" onClick={() => { setSched(c); setWhen(""); }}>{t("Reja")}</button>}
                {c.scheduled && <button className="tiny link" onClick={() => run(() => del(`/studio/publish-jobs/${c.id}`), t("Bekor qilindi"))}>{t("Bekor")}</button>}
                <Link className="tiny link" to={`/studio/h/${c.id}`}>{t("Tarix")}</Link>
              </div>
            </div>
          ))}
          {!w.chapters.length && <div className="li muted small">{t("Hali bob yo'q. «+ Bob» yoki «Import».")}</div>}
        </div>
        {!!w.chapters.length && <button className="btn ghost" onClick={() => addChapter(w.chapters[w.chapters.length - 1].id)}>{t("Keyingi bobni shu sozlamalar bilan yaratish")}</button>}

        <h2 className="mt16">{t("Metama'lumot")}</h2>
        <p className="tiny dim">{t("Matn alohida tahrirlanadi. Bu yerdagi o'zgarish bob matniga tegmaydi.")}</p>
        <div className="field"><label>{t("Sarlavha")}</label><input className="input" value={meta.title} onChange={(e) => set("title", e.target.value)} /></div>
        <div className="field"><label>{t("Annotatsiya")}</label><textarea className="textarea" value={meta.synopsis} onChange={(e) => set("synopsis", e.target.value)} /></div>
        <AiSynopsis workId={w.id} onPick={(text) => set("synopsis", text)} />
        <div className="field"><label>{t("Asosiy janr")}</label>
          <select className="select" value={meta.primary_genre_id || 0} onChange={(e) => set("primary_genre_id", Number(e.target.value) || null)}>
            <option value={0}>—</option>{genres?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="field"><label>{t("Qo'shimcha janrlar")}</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {genres?.filter((g) => g.id !== meta.primary_genre_id).map((g) => {
              const on = meta.genre_ids.includes(g.id);
              return <button key={g.id} className={`chip ${on ? "on" : ""}`} onClick={() => set("genre_ids", on ? meta.genre_ids.filter((x: number) => x !== g.id) : [...meta.genre_ids, g.id].slice(0, 4))}>{g.name}</button>;
            })}
          </div>
        </div>
        <div className="field"><label>{t("Kayfiyat teglari")}</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {moods?.map((m) => { const on = meta.tag_ids.includes(m.id); return <button key={m.id} className={`chip ${on ? "on" : ""}`} onClick={() => set("tag_ids", on ? meta.tag_ids.filter((x: number) => x !== m.id) : [...meta.tag_ids, m.id])}>{m.name}</button>; })}
          </div>
        </div>
        <div className="row">
          <div className="field grow"><label>{t("Holat")}</label>
            <select className="select" value={meta.completion_state} onChange={(e) => set("completion_state", e.target.value)}><option value="ongoing">{t("Davom etmoqda")}</option><option value="completed">{t("Tugallangan")}</option><option value="paused">{t("Tanaffusda")}</option></select>
          </div>
          <div className="field grow"><label>{t("Rejadagi boblar")}</label><input className="input" inputMode="numeric" value={meta.planned_chapters} onChange={(e) => set("planned_chapters", e.target.value.replace(/\D/g, ""))} /></div>
        </div>
        <div className="row">
          <div className="field grow"><label>{t("Format")}</label>
            <select className="select" value={meta.format} onChange={(e) => set("format", e.target.value)}><option value="short">{t("Qisqa hikoya")}</option><option value="novella">{t("Qissa")}</option><option value="novel">{t("Roman")}</option><option value="series">{t("Turkum")}</option><option value="diary">{t("Kundalik")}</option></select>
          </div>
          <div className="field grow"><label>{t("Sharhlar")}</label>
            <select className="select" value={meta.comments_policy} onChange={(e) => set("comments_policy", e.target.value)}><option value="open">{t("Ochiq")}</option><option value="closed">{t("Yopiq")}</option></select>
          </div>
        </div>
        <div className="field"><label>{t("Keyingi nashr haqida eslatma (ixtiyoriy)")}</label><input className="input" value={meta.next_release_note} onChange={(e) => set("next_release_note", e.target.value)} /></div>
        <label className="row small"><input type="checkbox" checked={!!meta.content_flags.author_claim} onChange={(e) => set("content_flags", { ...meta.content_flags, author_claim: e.target.checked })} /> {t("«Muallif taqdimotiga ko'ra» belgisi")}</label>
        <div className="field"><label>{t("Yosh belgisi")}</label>
          <select className="select" value={meta.content_flags.age_rating || ""} onChange={(e) => set("content_flags", { ...meta.content_flags, age_rating: e.target.value || null })}><option value="">—</option><option value="0+">0+</option><option value="12+">12+</option><option value="16+">16+</option><option value="18+">18+</option></select>
        </div>
        <button className="btn primary block" onClick={saveMeta}>{t("Metama'lumotni saqlash")}</button>

        {can("work.change_access") && (
          <div className="panel stack">
            <b>{t("Kirish siyosati")}</b>
            <select className="select" defaultValue={w.access_policy} onChange={(e) => run(() => post(`/studio/works/${w.id}/access`, { access_policy: e.target.value }), t("Kirish siyosati o'zgardi"))}>
              <option value="FREE">{t("Bepul")}</option><option value="PREMIUM">Premium</option><option value="PURCHASE">{t("Alohida xarid")}</option><option value="PREMIUM_OR_PURCHASE">{t("Premium yoki xarid")}</option>
            </select>
          </div>
        )}

        <div className="row between mt16"><h2>{t("Fayllar")}</h2><button className="btn" style={{ minHeight: 36 }} onClick={() => fileRef.current?.click()}>+ {t("Fayl")}</button></div>
        <input ref={fileRef} type="file" hidden accept=".pdf,.mp3,.m4a,.mp4,.txt,.md,.docx,.epub,image/*" onChange={(e) => onFile(e.target.files?.[0])} />
        <p className="tiny dim">{t("«Fayl biriktirish» va «Matnga aylantirish» alohida. PDF avtomatik bobga aylanmaydi.")}</p>
        <div className="list">
          {w.files.map((f: any) => (
            <div key={f.link_id} className="li"><span className="grow small">{f.purpose === "audio" ? "🎧" : "📎"} {f.title} <span className="dim">({(f.size / 1048576).toFixed(1)} MB)</span></span>
              <button className="tiny link" onClick={() => run(() => del(`/studio/assets/link/${f.link_id}`))}>{t("Olib tashlash")}</button></div>
          ))}
          {!w.files.length && <div className="li small muted">{t("Fayl yo'q")}</div>}
        </div>

        <CharactersManager workId={w.id} chapters={w.chapters} />
        <BetaInvites workId={w.id} chapters={w.chapters} />

        {!!w.reviews.length && (
          <>
            <h2 className="mt16">{t("Tekshiruv tarixi")}</h2>
            {w.reviews.map((r: any) => <div key={r.id} className="small"><span className="pill">{r.decision}</span> {r.note} <span className="dim">{fmtDate(r.created_at)}</span></div>)}
          </>
        )}

        <h2 className="mt16">{t("Holat")}</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          {w.editorial_state === "published" && w.can_publish && <button className="btn ghost" onClick={() => stateAction("delist")}>{t("Katalogdan yashirish")}</button>}
          {w.editorial_state === "delisted" && <button className="btn ghost" onClick={() => stateAction("relist")}>{t("Katalogga qaytarish")}</button>}
          {w.editorial_state === "published" && w.can_publish && <button className="btn ghost" onClick={() => stateAction("unpublish")}>{t("Nashrdan olish")}</button>}
          {w.editorial_state !== "archived" && <button className="btn ghost" onClick={() => stateAction("archive")}>{t("Arxivlash")}</button>}
          {w.editorial_state === "archived" && <button className="btn" onClick={() => stateAction("restore")}>{t("Arxivdan tiklash (30 kun)")}</button>}
          {can("work.suspend") && w.editorial_state !== "suspended" && <button className="btn danger" onClick={() => stateAction("suspend", true)}>{t("To'xtatish")}</button>}
          {can("work.suspend") && w.editorial_state === "suspended" && <button className="btn" onClick={() => stateAction("unsuspend")}>{t("Qayta ochish")}</button>}
        </div>
        <p className="tiny dim">{t("Katalogdan yashirilgan asar oldin xarid qilganlarga ochiq qoladi.")}</p>
      </div>

      <Sheet open={!!sched} onClose={() => setSched(null)} label={t("Rejalashtirish")}>
        <h2>{t("Nashrni rejalashtirish")}</h2>
        <p className="small muted">{sched?.title}. {t("Tasdiqlangan qoralama belgilangan vaqtda nashr qilinadi. Vaqtni o'zgartirsangiz eski reja bekor bo'ladi.")}</p>
        <input className="input mt16" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button className="btn primary block mt16" disabled={!when} onClick={schedule}>{t("Rejalashtirish")}</button>
      </Sheet>
    </div>
  );
}
