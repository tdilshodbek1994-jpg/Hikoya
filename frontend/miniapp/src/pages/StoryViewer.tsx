import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { IClose, ILock } from "../components/icons";
import { Spinner, useBack, useToast } from "../components/ui";
import { get, post, put, uuid } from "../lib/api";
import { useT } from "../lib/i18n";
import { haptic, reducedMotion } from "../lib/tg";

/** E-14: tap left/right, hold to pause, seen state, ≥2 s counts as a view, closes back to where you were. */
export default function StoryViewer() {
  const { storyId, authorIndex, highlightId } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ["storis-feed"], queryFn: () => get<any[]>("/storis/feed"), enabled: authorIndex !== undefined || !!sp.get("author") });
  const [aIdx, setAIdx] = useState(Number(authorIndex || 0));
  const [sIdx, setSIdx] = useState(0);
  const [fIdx, setFIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [poll, setPoll] = useState<Record<string, number> | null>(null);
  const counted = useRef<Set<number>>(new Set());
  const close = () => {
    qc.invalidateQueries({ queryKey: ["storis-feed"] });
    history.length > 1 ? nav(-1) : nav("/");
  };
  useBack(true, close);

  const storyIds: number[] = useMemo(() => {
    if (storyId) {
      const authorId = Number(sp.get("author") || 0);
      const entry = feed.data?.find((e) => e.author.id === authorId);
      return entry ? entry.story_ids : [Number(storyId)];
    }
    if (authorIndex !== undefined) return feed.data?.[aIdx]?.story_ids || [];
    return [];
  }, [storyId, authorIndex, feed.data, aIdx, sp]);

  const currentStoryId = storyIds[sIdx];
  const story = useQuery({
    queryKey: ["story", highlightId ? `h${highlightId}` : currentStoryId],
    enabled: !!highlightId || !!currentStoryId,
    queryFn: () => (highlightId ? get(`/highlights/${highlightId}`) : get(`/storis/${currentStoryId}`)),
    retry: false,
  });
  const frames: any[] = story.data?.frames || [];
  const frame = frames[fIdx];
  const duration = frame ? Math.max(4000, frame.duration_ms || 6000) : 6000;

  const next = () => {
    haptic.tap();
    setPoll(null);
    if (fIdx < frames.length - 1) return (setFIdx(fIdx + 1), setElapsed(0));
    if (sIdx < storyIds.length - 1) return (setSIdx(sIdx + 1), setFIdx(0), setElapsed(0));
    if (authorIndex !== undefined && feed.data && aIdx < feed.data.length - 1) return (setAIdx(aIdx + 1), setSIdx(0), setFIdx(0), setElapsed(0));
    close();
  };
  const prev = () => {
    setPoll(null);
    if (fIdx > 0) return (setFIdx(fIdx - 1), setElapsed(0));
    if (sIdx > 0) return (setSIdx(sIdx - 1), setFIdx(0), setElapsed(0));
    if (authorIndex !== undefined && aIdx > 0) return (setAIdx(aIdx - 1), setSIdx(0), setFIdx(0), setElapsed(0));
  };
  const skip = () => {
    if (frame && !highlightId && currentStoryId) post(`/storis/${currentStoryId}/actions`, { frame_id: frame.id, action: "skip", client_key: uuid() }).catch(() => {});
    next();
  };

  useEffect(() => {
    if (!frame || paused) return;
    const step = 100;
    const id = setInterval(() => setElapsed((e) => e + step), step);
    return () => clearInterval(id);
  }, [frame, paused]);

  useEffect(() => {
    if (!frame) return;
    if (elapsed >= 2000 && !counted.current.has(frame.id) && !highlightId && currentStoryId) {
      counted.current.add(frame.id);
      post(`/storis/${currentStoryId}/views`, { frame_id: frame.id, dwell_ms: elapsed, completed: false }).catch(() => {});
    }
    if (elapsed >= duration) {
      if (!highlightId && currentStoryId) post(`/storis/${currentStoryId}/views`, { frame_id: frame.id, dwell_ms: elapsed, completed: true }).catch(() => {});
      next();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  if (story.isError) {
    return (
      <div className="sv"><div className="pad" style={{ paddingTop: 80, color: "#fff" }}>
        <h2>{t("Storis muddati tugagan")}</h2>
        <button className="btn mt16" onClick={close}>{t("Yopish")}</button>
      </div></div>
    );
  }
  if (!frame) return <div className="sv"><Spinner /></div>;

  const vote = async (opt: string) => {
    try {
      const r = await post(`/storis/${currentStoryId}/actions`, { frame_id: frame.id, action: "vote", value: opt });
      setPoll(r.results || {});
    } catch (e: any) { toast(e.message, true); }
  };
  const follow = async () => {
    await put(`/authors/${story.data.author.id}/follow`);
    post(`/storis/${currentStoryId}/actions`, { frame_id: frame.id, action: "follow", client_key: "f" }).catch(() => {});
    toast(t("Kuzatilmoqda"));
  };
  const openLinked = () => {
    if (!frame.linked) return;
    post(`/storis/${currentStoryId}/actions`, { frame_id: frame.id, action: "start_work", client_key: uuid() }).catch(() => {});
    nav(frame.linked.chapter_id ? `/read/${frame.linked.chapter_id}` : `/w/${frame.linked.code}`);
  };

  return (
    <div className="sv" onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} onPointerCancel={() => setPaused(false)}>
      <div className="sv-bars" aria-hidden>
        {frames.map((f, i) => (
          <i key={f.id}><b style={{ width: i < fIdx ? "100%" : i === fIdx ? `${Math.min(100, (elapsed / duration) * 100)}%` : 0, transition: reducedMotion() ? "none" : "width .1s linear" }} /></i>
        ))}
      </div>
      <div className="sv-head" style={{ color: "#fff" }}>
        <Link to={`/a/${story.data.author?.id || story.data.author_id}`} className="grow" style={{ fontWeight: 600 }}>{story.data.author?.pen_name || story.data.title}</Link>
        {frame.kind === "video" && <button className="btn" style={{ minHeight: 34 }} onClick={() => setMuted(!muted)}>{muted ? "🔇" : "🔊"}</button>}
        <button className="icon-btn" aria-label={t("Yopish")} onClick={close}><IClose /></button>
      </div>
      <div className={`sv-frame bg-${frame.background || "violet"}`}>
        <button className="sv-tapl" aria-label={t("Oldingi")} onClick={prev} />
        <button className="sv-tapr" aria-label={t("Keyingi")} onClick={skip} />
        {frame.locked ? (
          <div className="sv-text" style={{ color: "#fff" }}>
            <ILock /> <div className="mt8">{t("Bu lavha faqat Premium uchun")}</div>
            <Link to="/premium" className="btn premium mt16" style={{ position: "relative", zIndex: 3 }}>⭐ Premium</Link>
          </div>
        ) : frame.kind === "image" && frame.media_url ? (
          <img src={frame.media_url} alt={frame.text || ""} />
        ) : frame.kind === "video" && frame.media_url ? (
          <video src={frame.media_url} autoPlay muted={muted} playsInline loop={false}>
            {frame.subtitles && <track kind="subtitles" srcLang="uz" label="O'zbek" default />}
          </video>
        ) : (
          <div className="sv-text" style={{ color: "#fff" }}>{frame.kind === "quote" ? `“${frame.text}”` : frame.text}</div>
        )}
        {frame.text && (frame.kind === "image" || frame.kind === "video") && !frame.locked && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, background: "linear-gradient(transparent, rgba(0,0,0,.7))", color: "#fff" }}>{frame.text}</div>
        )}
      </div>
      <div className="sv-foot" onPointerDown={(e) => e.stopPropagation()}>
        {frame.kind === "poll" && !frame.locked && (
          <div className="stack grow">
            {frame.poll_options.map((o: string) => (
              <button key={o} className="btn block" onClick={() => vote(o)}>
                {o}{poll ? ` · ${poll[o] || 0}` : ""}
              </button>
            ))}
          </div>
        )}
        {frame.linked && !frame.locked && (
          <button className="btn primary block" onClick={openLinked}>
            {frame.action_type === "new_chapter" ? t("Yangi bob") : t("Hikoyani o'qish")}{frame.linked.access_policy !== "FREE" ? " ⭐" : ""}
          </button>
        )}
        {frame.action_type === "follow" && <button className="btn block" onClick={follow}>{t("Kuzatish")}</button>}
      </div>
    </div>
  );
}
