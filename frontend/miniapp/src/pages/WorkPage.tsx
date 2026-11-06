import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { IBookmark, IChat, IFile, IFlag, IHeart, ILock, IShare, IThanks } from "../components/icons";
import { Cover, ErrorBox, Sheet, Spinner, TopBar, useToast } from "../components/ui";
import { api, del, get, post, put } from "../lib/api";
import { FORMAT_LABEL, STATUS_LABEL, fmtDate, useT } from "../lib/i18n";
import { haptic, shareLink } from "../lib/tg";

const REASONS: [string, string][] = [["touched", "Ta'sirlantirdi"], ["useful", "Foydali bo'ldi"], ["waiting", "Davomini kutaman"], ["", "Shunchaki rahmat"]];

export default function WorkPage() {
  const { code } = useParams();
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["work", code];
  const { data: w, error, refetch, isLoading } = useQuery({ queryKey: key, queryFn: () => get(`/works/${code}`) });
  const [thanksOpen, setThanksOpen] = useState(false);
  const [moreSyn, setMoreSyn] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [collOpen, setCollOpen] = useState(false);
  const lib = useQuery({ queryKey: ["library"], enabled: collOpen, queryFn: () => get("/library") });

  if (isLoading) return (<div className="page no-nav"><TopBar /><Spinner /></div>);
  if (error || !w) return (<div className="page no-nav"><TopBar /><ErrorBox error={error} retry={refetch} /></div>);

  const st = w.user_state || {};
  const patchLocal = (fn: (x: any) => any) => qc.setQueryData(key, (old: any) => (old ? fn(structuredClone(old)) : old));

  const toggleLike = async () => {
    haptic.tap();
    const on = !st.liked;
    patchLocal((x) => { x.user_state.liked = on; x.counters.likes += on ? 1 : -1; return x; });
    try {
      const r = on ? await put(`/works/${w.id}/like`) : await del(`/works/${w.id}/like`);
      patchLocal((x) => { x.counters.likes = r.likes; return x; });
    } catch (e: any) {
      patchLocal((x) => { x.user_state.liked = !on; x.counters.likes += on ? -1 : 1; return x; });
      toast(e.message, true);
    }
  };
  const giveThanks = async (reason: string | null) => {
    setThanksOpen(false);
    try {
      const r = reason === null ? await del(`/works/${w.id}/thanks`) : await put(`/works/${w.id}/thanks`, { reason });
      patchLocal((x) => { x.user_state.thanked = r.thanked; x.user_state.thanks_reason = r.reason; x.counters.thanks = r.thanks; return x; });
      if (r.thanked) { haptic.ok(); toast(t("Rahmatingiz muallifga yetkazildi. Bu bepul.")); }
    } catch (e: any) {
      toast(e.message, true);
    }
  };
  const toggleLibrary = async () => {
    const on = !st.in_library;
    patchLocal((x) => { x.user_state.in_library = on; return x; });
    try {
      on ? await put(`/library/items/${w.id}`) : await del(`/library/items/${w.id}`);
      toast(on ? t("Kutubxonaga qo'shildi") : t("Kutubxonadan olindi"));
      qc.invalidateQueries({ queryKey: ["library"] });
    } catch (e: any) {
      patchLocal((x) => { x.user_state.in_library = !on; return x; });
      toast(e.message, true);
    }
  };
  const followAuthor = async () => {
    const on = !st.following_author;
    const aid = w.contributors.find((c: any) => c.type === "author")?.id;
    try {
      on ? await put(`/authors/${aid}/follow`) : await del(`/authors/${aid}/follow`);
      patchLocal((x) => { x.user_state.following_author = on; return x; });
    } catch (e: any) { toast(e.message, true); }
  };
  const notifyComplete = async () => {
    const on = !st.notify_on_complete;
    await put(`/works/${w.id}/follow`, { notify_on_complete: on });
    patchLocal((x) => { x.user_state.notify_on_complete = on; x.user_state.following_work = true; return x; });
    toast(on ? t("Asar tugaganda xabar beramiz") : t("Eslatma o'chirildi"));
  };
  const openFile = async (f: any) => {
    try {
      const r = await get(`/assets/${f.asset_id}/access`);
      window.open(r.url, "_blank");
    } catch (e: any) {
      if (e.code === "access_required") nav("/premium");
      else toast(e.message, true);
    }
  };

  const toc: any[] = w.toc || [];
  const progress = st.progress;
  const startChapter = progress ? progress.chapter_id : toc[0]?.id;
  const startLabel = { start: t("O'qishni boshlash"), continue: t("Davom ettirish"), reread: t("Qayta o'qish") }[w.start_action as string];
  const author = w.contributors.find((c: any) => c.type === "author");
  const locked = toc.filter((c) => c.access === "locked").length;

  return (
    <div className="page no-nav">
      <TopBar right={<button className="icon-btn" aria-label={t("Ulashish")} onClick={() => shareLink(w.share_url, w.title)}><IShare /></button>} />
      <div className="hero">
        <Cover card={w} />
        <div className="grow stack" style={{ gap: 8 }}>
          <h1 style={{ fontSize: 21 }}>{w.title}</h1>
          {w.contributors.map((c: any) => (
            <Link key={c.id + c.type} to={`/a/${c.id}`} className="small" style={{ color: "var(--accent-2)" }}>
              {c.type !== "author" ? `${t(c.type === "translator" ? "Tarjimon" : "Hammuallif")}: ` : ""}{c.pen_name}{c.verified ? " ✓" : ""}
            </Link>
          ))}
          <div className="meta">
            <span>{t(FORMAT_LABEL[w.format] || w.format)}</span>
            <span>{t(STATUS_LABEL[w.completion_state])}</span>
            <span>{w.chapters} {t("bob")}{w.planned_chapters ? ` / ${w.planned_chapters} ${t("reja")}` : ""}</span>
            <span title={t("Taxminiy")}>~{w.minutes} {t("daq")}</span>
            {w.has_audio && <span>🎧 {t("Audio")}</span>}
          </div>
          {w.is_demo && <span className="pill">{t("Demo kontent")}</span>}
          {w.content_flags?.author_claim && <span className="pill">{t("Muallif taqdimotiga ko'ra")}</span>}
        </div>
      </div>

      {w.editorial_state === "suspended" && (
        <div className="pad mt16"><div className="panel" style={{ borderColor: "var(--danger)" }}>⚠️ {t("O'qish vaqtincha to'xtatilgan")}: {w.suspended_reason}</div></div>
      )}
      {w.delisted && <div className="pad mt16"><div className="panel small muted">{t("Asar katalogdan yashirilgan. Sizda u ochiq qoladi.")}</div></div>}

      <div className="actions mt16">
        {startChapter ? (
          <Link to={`/read/${startChapter}`} className="btn primary big" onClick={() => haptic.tap()}>{startLabel}</Link>
        ) : (
          <span className="btn big" aria-disabled>{t("Boblar hali chiqmagan")}</span>
        )}
        <button className={`btn big ${st.in_library ? "" : "ghost"}`} style={{ flex: "0 0 52px", padding: 0 }} aria-pressed={!!st.in_library} aria-label={t("Kutubxonaga")} onClick={toggleLibrary}>
          <IBookmark on={st.in_library} />
        </button>
      </div>
      {(w.access === "PREMIUM" || w.access === "PURCHASE") && locked > 0 && (
        <div className="pad mt8">
          <Link to={`/premium?work=${w.id}`} className="btn premium block"><ILock /> {w.access === "PURCHASE" ? t("Asarni sotib olish") : t("Premium bilan ochish")}</Link>
          <p className="tiny dim mt8">{t("Bepul namunani o'qib ko'rishingiz mumkin.")}</p>
        </div>
      )}

      <div className="pad row wrap mt16" style={{ gap: 8 }}>
        <button className={`counter-btn ${st.liked ? "on" : ""}`} aria-pressed={!!st.liked} onClick={toggleLike}><IHeart on={st.liked} /> {w.counters.likes}</button>
        <button className={`counter-btn ${st.thanked ? "on" : ""}`} aria-pressed={!!st.thanked} onClick={() => setThanksOpen(true)}><IThanks /> {t("Rahmat")} · {w.counters.thanks}</button>
        <Link className="counter-btn" to={`/w/${w.code}/comments`}><IChat /> {w.counters.comments}</Link>
      </div>

      <div className="pad mt16">
        <p className={`synopsis ${moreSyn ? "" : "clamp3"}`} onClick={() => setMoreSyn(!moreSyn)}>{w.synopsis}</p>
        <div className="row wrap mt8" style={{ gap: 6 }}>
          {w.genres.map((g: any) => <Link key={g.slug} className="pill" to={`/catalog?genre=${g.slug}`}>{g.name}</Link>)}
          {w.tags.map((tg: any) => <Link key={tg.slug} className="pill" to={`/catalog?tag=${tg.slug}`}>#{tg.name}</Link>)}
        </div>
      </div>

      {author && (
        <div className="pad mt16">
          <div className="panel row">
            <Link to={`/a/${author.id}`} className="ring" style={{ width: 48, height: 48, padding: 2 }}>
              <div className="av">{author.avatar_url ? <img src={author.avatar_url} alt="" /> : author.pen_name[0]}</div>
            </Link>
            <Link to={`/a/${author.id}`} className="grow"><div style={{ fontWeight: 600 }}>{author.pen_name}</div><div className="tiny dim">{t("Muallif profili")}</div></Link>
            <button className={`btn ${st.following_author ? "" : "primary"}`} style={{ minHeight: 38 }} onClick={followAuthor}>{st.following_author ? t("Kuzatilmoqda") : t("Kuzatish")}</button>
          </div>
        </div>
      )}

      {(w.next_release_at || w.next_release_note) && (
        <div className="pad mt16"><div className="panel small">🗓 {t("Keyingi bob")}: {w.next_release_at ? fmtDate(w.next_release_at, true) : ""} {w.next_release_note}</div></div>
      )}
      {w.completion_state === "ongoing" && (
        <div className="pad mt8"><button className="link small" onClick={notifyComplete}>{st.notify_on_complete ? "🔔 " + t("Tugaganda xabar beriladi") : "🔕 " + t("Tugaganda menga ayting")}</button></div>
      )}

      <section className="section">
        <div className="section-h"><h2>{t("Mundarija")}</h2><span className="small dim">{toc.length} {t("bob")}</span></div>
        <div className="toc">
          {toc.map((c) => (
            <Link key={c.id} to={`/read/${c.id}`}>
              <span className="idx">{c.index}</span>
              <div className="grow">
                <div style={{ fontWeight: progress?.chapter_id === c.id ? 700 : 500 }}>{c.title}</div>
                <div className="tiny dim">~{c.minutes} {t("daq")}{c.is_new ? ` · ${t("yangi")}` : ""}{c.has_audio ? " · 🎧" : ""}</div>
              </div>
              {c.completed ? <span className="pill ok">✓</span> : c.access === "locked" ? <span className="pill warn"><ILock /> {c.free_sample ? "" : t("Premium")}</span> : c.free_sample ? <span className="pill">{t("Bepul namuna")}</span> : null}
            </Link>
          ))}
        </div>
      </section>

      {!!w.files.length && (
        <section className="section">
          <div className="section-h"><h2>{t("Fayllar va audio")}</h2></div>
          <div className="pad"><div className="list">
            {w.files.map((f: any) => (
              <button key={f.link_id} onClick={() => openFile(f)}>
                {f.purpose === "audio" ? "🎧" : <IFile />}
                <div className="grow"><div>{f.title}</div><div className="tiny dim">{(f.size_bytes / 1048576).toFixed(1)} MB{f.download_allowed ? "" : ` · ${t("faqat ko'rish")}`}</div></div>
              </button>
            ))}
          </div></div>
        </section>
      )}

      {!!w.update_history.length && (
        <section className="section">
          <div className="section-h"><h2>{t("Yangilanishlar")}</h2></div>
          <div className="pad small muted stack" style={{ gap: 4 }}>
            {w.update_history.slice(0, 5).map((h: any) => <div key={h.chapter_id}>{fmtDate(h.published_at)} — {h.title}</div>)}
          </div>
        </section>
      )}

      <div className="pad mt24 row" style={{ gap: 8 }}>
        <button className="btn ghost" onClick={() => setCollOpen(true)}>🗂 {t("To'plamga")}</button>
        <button className="btn ghost" onClick={() => setReportOpen(true)}><IFlag /> {t("Xato yoki shikoyat")}</button>
      </div>

      <Sheet open={thanksOpen} onClose={() => setThanksOpen(false)} label={t("Muallifga rahmat")}>
        <h2>{t("Muallifga rahmat")}</h2>
        <p className="small muted">{t("Bu bepul — pul yechilmaydi. Sabab ixtiyoriy.")}</p>
        <div className="stack mt16">
          {REASONS.map(([r, l]) => (
            <button key={r} className={`btn block ${st.thanked && (st.thanks_reason || "") === r ? "primary" : ""}`} onClick={() => giveThanks(r)}>{t(l)}</button>
          ))}
          {st.thanked && <button className="btn ghost block" onClick={() => giveThanks(null)}>{t("Rahmatni olib tashlash")}</button>}
        </div>
      </Sheet>
      <Sheet open={collOpen} onClose={() => setCollOpen(false)} label={t("To'plamga qo'shish")}>
        <h2>{t("To'plamga qo'shish")}</h2>
        {!lib.data ? <Spinner /> : !lib.data.collections.length ? <p className="muted small">{t("Avval «Kutubxonam» bo'limida to'plam yarating.")}</p> : (
          <div className="list mt16">
            {lib.data.collections.map((c: any) => (
              <button key={c.id} onClick={async () => { try { await put(`/collections/${c.id}/items/${w.id}`); toast(t("Qo'shildi")); setCollOpen(false); } catch (e: any) { toast(e.message, true); } }}>{c.title}<span className="dim small" style={{ marginLeft: "auto" }}>{c.count}</span></button>
            ))}
          </div>
        )}
      </Sheet>
      <ReportSheet open={reportOpen} onClose={() => setReportOpen(false)} targetType="work" targetId={w.id} />
    </div>
  );
}

export function ReportSheet({ open, onClose, targetType, targetId }: { open: boolean; onClose: () => void; targetType: string; targetId: number }) {
  const t = useT();
  const toast = useToast();
  const [note, setNote] = useState("");
  const send = async (reason: string) => {
    try {
      if (targetType === "comment") await post(`/comments/${targetId}/report`, { reason, note });
      else await api(`/reports`, { method: "POST", body: { reason, note }, query: { target_type: targetType, target_id: targetId } });
      toast(t("Shikoyat moderatorga yuborildi"));
      onClose();
    } catch (e: any) {
      toast(e.message, true);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} label={t("Shikoyat")}>
      <h2>{t("Nima noto'g'ri?")}</h2>
      <textarea className="textarea mt16" placeholder={t("Izoh (ixtiyoriy)")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <div className="stack mt16">
        {[["spam", "Spam"], ["abuse", "Haqorat"], ["ads", "Takroriy reklama"], ["personal_data", "Shaxsiy ma'lumot oshkor qilingan"], ["plagiarism", "Plagiat"], ["other", "Boshqa"]].map(([r, l]) => (
          <button key={r} className="btn block" onClick={() => send(r)}>{t(l)}</button>
        ))}
      </div>
    </Sheet>
  );
}
