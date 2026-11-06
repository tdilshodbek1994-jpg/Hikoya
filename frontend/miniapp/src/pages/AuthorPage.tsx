import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { IShare } from "../components/icons";
import { ShareSheet } from "../components/ShareSheet";
import { ErrorBox, Grid, Spinner, TopBar, useToast } from "../components/ui";
import { del, get, put } from "../lib/api";
import { useT } from "../lib/i18n";
import { ReportSheet } from "./WorkPage";

/** E-13: author profile — pen name, bio, verified mark, works, ongoing series, storis highlights. */
export default function AuthorPage() {
  const { id } = useParams();
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [report, setReport] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const { data: a, error, isLoading, refetch } = useQuery({ queryKey: ["author", id], queryFn: () => get(`/authors/${id}`) });
  const { data: stories } = useQuery({ queryKey: ["author-storis", id], queryFn: () => get(`/authors/${id}/storis`) });
  if (isLoading) return (<div className="page no-nav"><TopBar /><Spinner /></div>);
  if (error || !a) return (<div className="page no-nav"><TopBar /><ErrorBox error={error} retry={refetch} /></div>);
  const follow = async () => {
    try {
      a.following ? await del(`/authors/${a.id}/follow`) : await put(`/authors/${a.id}/follow`);
      qc.invalidateQueries({ queryKey: ["author", id] });
    } catch (e: any) { toast(e.message, true); }
  };
  const hasStory = stories?.story_ids?.length > 0;
  return (
    <div className="page no-nav">
      <TopBar title={a.pen_name} right={<button className="icon-btn" aria-label={t("Ulashish")} onClick={() => setShareOpen(true)}><IShare /></button>} />
      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} target={{ type: "author", id: a.id, title: a.pen_name, cover: a.avatar_url }} />
      <div className="pad center stack" style={{ alignItems: "center" }}>
        <Link to={hasStory ? `/s/${stories.story_ids[0]}?author=${a.id}` : "#"} className={`ring ${hasStory ? "unseen" : ""}`} style={{ width: 96, height: 96 }} aria-label={hasStory ? t("Storisni ko'rish") : undefined}>
          <div className="av" style={{ fontSize: 34 }}>{a.avatar_url ? <img src={a.avatar_url} alt="" /> : a.pen_name[0]}</div>
        </Link>
        <h1>{a.pen_name}{a.verified && <span title={t("Tasdiqlangan")} style={{ color: "var(--accent-2)" }}> ✓</span>}</h1>
        {a.is_demo && <span className="pill">{t("Demo muallif")}</span>}
        {a.bio && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{a.bio}</p>}
        <div className="meta" style={{ justifyContent: "center" }}>
          <span>{a.followers} {t("kuzatuvchi")}</span><span>❤️ {a.likes}</span><span>🙏 {a.thanks}</span>
        </div>
        <div className="row">
          {a.is_me ? (
            <>
              <Link to="/studio" className="btn primary">{t("Ijod ustaxonasi")}</Link>
              <Link to="/studio/stories/new" className="btn">+ {t("Storis")}</Link>
            </>
          ) : (
            <button className={`btn ${a.following ? "" : "primary"}`} onClick={follow}>{a.following ? t("Kuzatilmoqda") : t("Kuzatish")}</button>
          )}
        </div>
        {a.next_release_note && <div className="panel small">🗓 {a.next_release_note}</div>}
      </div>
      {!!a.highlights.length && (
        <div className="stories mt16">
          {a.highlights.map((h: any) => (
            <Link key={h.id} to={`/h/${h.id}`} className="story"><div className="ring"><div className="av">★</div></div><div className="n">{h.title}</div></Link>
          ))}
        </div>
      )}
      {!!a.genres.length && <div className="chips mt16">{a.genres.map((g: any) => <Link key={g.slug} className="chip" to={`/catalog?genre=${g.slug}`}>{g.name}</Link>)}</div>}
      {!!a.series.length && (<><div className="section-h mt24"><h2>{t("Davomli turkumlar")}</h2></div><Grid items={a.series} /></>)}
      <div className="section-h mt24"><h2>{t("Asarlar")}</h2></div>
      {a.works.length ? <Grid items={a.works} /> : <p className="pad muted">{t("Hali nashr qilingan asar yo'q.")}</p>}
      {!a.is_me && <div className="pad mt24"><button className="btn ghost" onClick={() => setReport(true)}>{t("Profil haqida shikoyat")}</button></div>}
      <ReportSheet open={report} onClose={() => setReport(false)} targetType="author" targetId={a.id} />
    </div>
  );
}
