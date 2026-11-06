import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { IAa, IAudio, IBack, IBookmark, IChat, IList, ILock, INext, IPause, IPlay, IPrev } from "../components/icons";
import { ShareSheet } from "../components/ShareSheet";
import { Seg, Sheet, Spinner, useToast } from "../components/ui";
import { ApiError, get, patch, post, uuid, type Block, type Inline, type Me, type ReaderSettings } from "../lib/api";
import { useAuth } from "../lib/auth";
import { latToCyr, useT } from "../lib/i18n";
import { deviceId, flush, queueEvent, queueProgress } from "../lib/offline";
import { backButton, canShareToStory, haptic, shareLink, shareToStory } from "../lib/tg";

const DEFAULTS: Required<ReaderSettings> = { theme: "dark", font: "serif", font_size: 19, line_height: 1.65, width: "normal", show_progress: true, original_script: false };
const LS_SETTINGS = "hk_reader_settings";
const CACHE = "hk_ch_cache_v1";

function cacheChapter(id: string, data: any) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE) || "{}");
    all[id] = { data, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 3);
    localStorage.setItem(CACHE, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]]))));
  } catch {
    /* storage full */
  }
}
function cachedChapter(id: string) {
  try {
    return JSON.parse(localStorage.getItem(CACHE) || "{}")[id]?.data || null;
  } catch {
    return null;
  }
}

function Inlines({ nodes, tr }: { nodes: Inline[]; tr: (s: string) => string }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === "hardBreak") return <br key={i} />;
        let el: React.ReactNode = tr(n.text);
        if (n.marks?.some((m) => m.type === "italic")) el = <em>{el}</em>;
        if (n.marks?.some((m) => m.type === "bold")) el = <strong>{el}</strong>;
        return <Fragment key={i}>{el}</Fragment>;
      })}
    </>
  );
}

function BlockView({ b, tr, images, marked, inline, onInline }: { b: Block; tr: (s: string) => string; images: Record<string, string>; marked: { hl: boolean; bm: boolean; speaking?: boolean }; inline?: number; onInline?: (bid: string) => void }) {
  const cls = `${marked.hl ? "hl" : ""} ${marked.bm ? "bm" : ""} ${marked.speaking ? "speaking" : ""}`.trim() || undefined;
  const badge = inline ? (
    <button className="inline-badge" aria-label={`${inline} izoh`} onClick={(e) => { e.stopPropagation(); onInline?.(b.attrs.bid); }}>💬 {inline}</button>
  ) : null;
  const p = { "data-bid": b.attrs.bid, className: cls } as const;
  switch (b.type) {
    case "heading":
      return b.attrs.level === 3 ? <h3 {...p}><Inlines nodes={b.content} tr={tr} /></h3> : <h2 {...p}><Inlines nodes={b.content} tr={tr} /></h2>;
    case "blockquote":
      return <blockquote {...p}><Inlines nodes={b.content} tr={tr} /></blockquote>;
    case "horizontalRule":
      return <hr {...p} />;
    case "image":
      return (
        <figure {...p}>
          {images[String(b.attrs.asset_id)] && <img src={images[String(b.attrs.asset_id)]} alt={b.attrs.caption} loading="lazy" />}
          {b.attrs.caption && <figcaption>{tr(b.attrs.caption)}</figcaption>}
        </figure>
      );
    default:
      return <p {...p} style={{ position: "relative" }}><Inlines nodes={b.content} tr={tr} />{badge}</p>;
  }
}

type SyncMark = { bid: string; t: number };

function AudioPlayer({ assetId, sync, onActive, seekRef }: { assetId: number; sync?: SyncMark[]; onActive?: (bid: string | null) => void; seekRef?: React.MutableRefObject<((bid: string) => boolean) | null> }) {
  const t = useT();
  const ref = useRef<HTMLAudioElement>(null);
  const lastBid = useRef<string | null>(null);
  useEffect(() => {
    if (!seekRef) return;
    seekRef.current = (bid) => {
      const m = sync?.find((x) => x.bid === bid);
      if (!m || !ref.current) return false;
      ref.current.currentTime = m.t;
      ref.current.play().catch(() => {});
      return true;
    };
    return () => { seekRef.current = null; };
  }, [sync, seekRef]);
  const follow = (time: number) => {
    if (!sync?.length || !onActive) return;
    let cur: string | null = null;
    for (const m of sync) { if (m.t <= time + 0.05) cur = m.bid; else break; }
    if (cur !== lastBid.current) { lastBid.current = cur; onActive(cur); }
  };
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sleep, setSleep] = useState(0);
  const key = `hk_audio_pos_${assetId}`;
  useEffect(() => {
    get(`/assets/${assetId}/access`).then((r) => setUrl(r.url)).catch(() => setUrl(null));
  }, [assetId]);
  useEffect(() => {
    if (!sleep) return;
    const id = setTimeout(() => { ref.current?.pause(); setSleep(0); }, sleep * 60000);
    return () => clearTimeout(id);
  }, [sleep]);
  if (!url) return null;
  return (
    <div className="panel row" style={{ margin: "0 auto 18px", maxWidth: 640, fontFamily: "var(--font-sans)", color: "var(--text)" }}>
      <audio
        ref={ref}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => { const p = Number(localStorage.getItem(key) || 0); if (p) e.currentTarget.currentTime = p; }}
        onTimeUpdate={(e) => { localStorage.setItem(key, String(Math.floor(e.currentTarget.currentTime))); follow(e.currentTarget.currentTime); }}
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); onActive?.(null); lastBid.current = null; }}
      />
      <button className="icon-btn" aria-label={playing ? t("Pauza") : t("Tinglash")} onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}>{playing ? <IPause /> : <IPlay />}</button>
      <span className="grow small"><IAudio /> {t("Audio")}{sync?.length ? <span className="tiny dim"> · {t("matn bilan")}</span> : null}</span>
      <select className="select" style={{ width: 76, minHeight: 36 }} value={rate} aria-label={t("Tezlik")} onChange={(e) => { const r = Number(e.target.value); setRate(r); if (ref.current) ref.current.playbackRate = r; }}>
        {[0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
      </select>
      <select className="select" style={{ width: 92, minHeight: 36 }} value={sleep} aria-label={t("Uyqu taymeri")} onChange={(e) => setSleep(Number(e.target.value))}>
        <option value={0}>⏾ —</option>
        {[15, 30, 60].map((m) => <option key={m} value={m}>⏾ {m}</option>)}
      </select>
    </div>
  );
}

export default function Reader() {
  const { chapterId } = useParams();
  const nav = useNavigate();
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { me, setMe } = useAuth();
  const [settings, setSettings] = useState<Required<ReaderSettings>>(() => ({ ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}")), ...(me?.reader_settings || {}) }));
  const [bars, setBars] = useState(true);
  const [sheet, setSheet] = useState<null | "settings" | "toc" | "select">(null);
  const [ratio, setRatio] = useState(0);
  const [selection, setSelection] = useState<{ bid: string; quote: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const pendingBlocks = useRef<Set<string>>(new Set());
  const activeRef = useRef({ last: Date.now(), acc: 0 });
  const currentBid = useRef("");

  const q = useQuery({
    queryKey: ["chapter", chapterId],
    queryFn: async () => {
      try {
        const d = await get(`/chapters/${chapterId}/content`, { device_id: deviceId() });
        setOffline(false);
        if (d.mode === "full") cacheChapter(chapterId!, { ...d, session_id: null });
        return d;
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          const c = cachedChapter(chapterId!);
          if (c) { setOffline(true); return c; }
        }
        throw e;
      }
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const d = q.data;
  const marks = useQuery({ queryKey: ["marks", chapterId], enabled: d?.mode === "full", queryFn: () => get(`/chapters/${chapterId}/my-marks`) });
  const toc = useQuery({ queryKey: ["toc", d?.work.code], enabled: !!d && sheet === "toc", queryFn: () => get<any[]>(`/works/${d.work.code}/chapters`) });

  // apply local reader settings instantly; sync to the account in the background
  const saveSettings = (patchS: ReaderSettings) => {
    const next = { ...settings, ...patchS };
    setSettings(next);
    localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
    clearTimeout((saveSettings as any)._t);
    (saveSettings as any)._t = setTimeout(() => patch<Me>("/me/preferences", { reader_settings: patchS }).then(setMe).catch(() => {}), 600);
  };

  const cyr = me?.script === "cyrl" && !settings.original_script && d?.work.script === "latn";
  const tr = useCallback((s: string) => (cyr ? latToCyr(s) : s), [cyr]);
  const blocks: Block[] = d?.content.content || [];
  const inline = useQuery({
    queryKey: ["inline", d?.chapter.id],
    enabled: !!d && d.mode === "full" && d.work.comments_policy !== "closed",
    queryFn: () => get<{ counts: Record<string, number> }>(`/works/${d.work.id}/chapters/${d.chapter.id}/inline-counts`),
  });
  const [recapOpen, setRecapOpen] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const seekRef = useRef<((bid: string) => boolean) | null>(null);
  useEffect(() => {
    if (!speaking) return;
    const el = document.querySelector(`[data-bid="${speaking}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 90) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [speaking]);
  const markSets = useMemo(() => ({ hl: new Set((marks.data?.highlights || []).map((h: any) => h.block_id)), bm: new Set((marks.data?.bookmarks || []).map((b: any) => b.block_id)) }), [marks.data]);

  // Telegram back button returns to the work page
  useEffect(() => backButton(true, () => (d ? nav(`/w/${d.work.code}`) : nav(-1))), [d, nav]);

  // restore position (T-12, T-17)
  useEffect(() => {
    if (!d || !textRef.current) return;
    seenRef.current = new Set();
    const pos = d.position;
    if (pos?.block_id) {
      const el = textRef.current.querySelector(`[data-bid="${pos.block_id}"]`);
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 30);
      if (pos.text_updated) toast(t("Matn yangilangan. Eng yaqin saqlangan joydan davom etyapsiz."));
    } else window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.chapter.id, d?.revision_id]);

  // visible blocks → qualified-read events + current position
  useEffect(() => {
    if (!d || d.mode !== "full" || !textRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const bid = (e.target as HTMLElement).dataset.bid!;
          if (e.isIntersecting && !seenRef.current.has(bid)) {
            seenRef.current.add(bid);
            pendingBlocks.current.add(bid);
          }
        }
      },
      { threshold: 0.6 },
    );
    textRef.current.querySelectorAll("[data-bid]").forEach((el) => io.observe(el));
    const markActive = () => (activeRef.current.last = Date.now());
    window.addEventListener("scroll", markActive, { passive: true });
    window.addEventListener("touchstart", markActive, { passive: true });
    const tick = setInterval(() => {
      const visible = document.visibilityState === "visible";
      const recent = Date.now() - activeRef.current.last < 30000;
      if (visible && recent) activeRef.current.acc += 1;
    }, 1000);
    const send = setInterval(() => {
      if (!d.session_id) return;
      const blocksNow = Array.from(pendingBlocks.current);
      const secs = activeRef.current.acc;
      if (!blocksNow.length && !secs) return;
      pendingBlocks.current.clear();
      activeRef.current.acc = 0;
      queueEvent({ session_id: d.session_id, type: "blocks", blocks: blocksNow, active_seconds: secs });
      flush();
    }, 10000);
    return () => {
      io.disconnect();
      clearInterval(tick);
      clearInterval(send);
      window.removeEventListener("scroll", markActive);
      window.removeEventListener("touchstart", markActive);
    };
  }, [d]);

  const ratioRef = useRef(0);
  const saveProgress = useCallback(() => {
    if (!d || !currentBid.current) return;
    queueProgress({ work_id: d.work.id, chapter_id: d.chapter.id, revision_id: d.revision_id, block_id: currentBid.current, ratio: ratioRef.current });
    flush();
  }, [d]);

  useEffect(() => {
    if (!d) return;
    let to = 0;
    const onScroll = () => {
      const h = document.documentElement;
      const r = Math.min(1, Math.max(0, h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)));
      ratioRef.current = r;
      setRatio(r);
      const els = textRef.current?.querySelectorAll<HTMLElement>("[data-bid]") || [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > 80) { currentBid.current = el.dataset.bid!; break; }
      }
      window.clearTimeout(to);
      to = window.setTimeout(() => { if (d.mode === "full") saveProgress(); }, 1500);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const onHide = () => document.visibilityState === "hidden" && d.mode === "full" && saveProgress();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      window.clearTimeout(to);
    };
  }, [d, saveProgress]);

  // finishing the chapter
  useEffect(() => {
    if (d?.mode === "full" && ratio > 0.98 && blocks.length) {
      currentBid.current = blocks[blocks.length - 1].attrs.bid;
      queueProgress({ work_id: d.work.id, chapter_id: d.chapter.id, revision_id: d.revision_id, block_id: currentBid.current, ratio: 1 });
      flush().then(() => qc.invalidateQueries({ queryKey: ["work", d.work.code] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio > 0.98]);

  const onTextClick = (e?: React.MouseEvent) => {
    const sel = window.getSelection();
    const quote = sel?.toString().trim();
    // while narration plays, tapping a paragraph jumps the audio there
    if (!quote && speaking && seekRef.current && e) {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-bid]");
      if (el && seekRef.current(el.dataset.bid!)) return;
    }
    if (quote && sel?.anchorNode) {
      const el = (sel.anchorNode.nodeType === 1 ? (sel.anchorNode as HTMLElement) : sel.anchorNode.parentElement)?.closest<HTMLElement>("[data-bid]");
      if (el) {
        setSelection({ bid: el.dataset.bid!, quote: quote.slice(0, 1000) });
        setSheet("select");
        return;
      }
    }
    setBars((b) => !b);
  };

  const bookmark = async () => {
    if (!d || d.mode !== "full") return;
    const bid = currentBid.current || blocks[0]?.attrs.bid;
    try {
      await post("/bookmarks", { chapter_id: d.chapter.id, revision_id: d.revision_id, block_id: bid, quote: (textRef.current?.querySelector(`[data-bid="${bid}"]`)?.textContent || "").slice(0, 200) });
      haptic.ok();
      toast(t("Xatcho'p qo'yildi"));
      marks.refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  const saveHighlight = async (note?: string) => {
    if (!selection || !d) return;
    try {
      await post("/highlights", { chapter_id: d.chapter.id, revision_id: d.revision_id, block_id: selection.bid, quote: selection.quote, note: note || "" });
      toast(note ? t("Eslatma saqlandi") : t("Iqtibos saqlandi"));
      setSheet(null);
      window.getSelection()?.removeAllRanges();
      marks.refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  const reportIssue = async (note: string) => {
    if (!selection || !d) return;
    await post("/content-issues", { chapter_id: d.chapter.id, revision_id: d.revision_id, block_id: selection.bid, quote: selection.quote.slice(0, 500), note });
    toast(t("Muallifga yuborildi. Rahmat!"));
    setSheet(null);
  };

  if (q.isLoading) return <div className={`reader ${settings.theme}`}><Spinner /></div>;
  if (q.error) {
    const e = q.error as ApiError;
    return (
      <div className="page no-nav pad" style={{ paddingTop: 80 }}>
        <h2>{e.code === "work_suspended" ? t("O'qish vaqtincha to'xtatilgan") : t("Bob ochilmadi")}</h2>
        <p className="muted">{e.message}</p>
        <button className="btn mt16" onClick={() => nav(-1)}>{t("Orqaga")}</button>
      </div>
    );
  }
  const minutesLeft = Math.max(0, Math.round((d.chapter.minutes || 0) * (1 - ratio)));
  const fadeTo = settings.theme === "light" ? "var(--reader-light)" : settings.theme === "sepia" ? "var(--reader-sepia)" : "var(--reader-dark)";

  return (
    <div className={`reader ${settings.theme} ${settings.font} w-${settings.width}`}>
      {settings.show_progress && <div className="r-prog" style={{ width: `${ratio * 100}%` }} aria-hidden />}
      <div className={`r-bar r-top ${bars ? "" : "hidden"}`}>
        <Link to={`/w/${d.work.code}`} className="icon-btn" aria-label={t("Asar sahifasi")}><IBack /></Link>
        <div className="grow small" style={{ overflow: "hidden" }}>
          <div style={{ fontWeight: 600, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{tr(d.work.title)}</div>
          <div className="tiny dim">{d.chapter.index}/{d.chapter.total} · {t("taxminan")} {minutesLeft} {t("daq qoldi")}{offline ? ` · ${t("oflayn")}` : ""}</div>
        </div>
        {d.mode === "full" && <button className="icon-btn" aria-label={t("Xatcho'p")} onClick={bookmark}><IBookmark /></button>}
        <button className="icon-btn" aria-label={t("Sozlamalar")} onClick={() => setSheet("settings")}><IAa /></button>
      </div>

      <div className="rtext" ref={textRef} onClick={onTextClick} style={{ fontSize: settings.font_size, lineHeight: settings.line_height }}>
        {d.audio && d.mode === "full" && <AudioPlayer assetId={d.audio.asset_id} sync={d.audio.sync} onActive={setSpeaking} seekRef={seekRef} />}
        <h1 className="ch-title">{tr(d.chapter.title)}</h1>
        {d.recap && (
          <div className="panel recap" onClick={(e) => { e.stopPropagation(); setRecapOpen(!recapOpen); }} style={{ fontFamily: "var(--font-sans)", marginBottom: 18 }}>
            <div className="row"><b className="grow small">↺ {t("Qayerda to'xtagandim?")}</b><span className="tiny dim">{recapOpen ? "▲" : "▼"}</span></div>
            {recapOpen && <p className="small mt8" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}><span className="dim">{tr(d.recap.chapter_title)}: </span>{tr(d.recap.text)}</p>}
          </div>
        )}
        <div className={d.mode === "preview" ? "fade-out" : ""} style={{ ["--fade-to" as any]: fadeTo }}>
          {blocks.map((b) => (
            <BlockView key={b.attrs.bid} b={b} tr={tr} images={d.images || {}} marked={{ hl: markSets.hl.has(b.attrs.bid), bm: markSets.bm.has(b.attrs.bid), speaking: speaking === b.attrs.bid }}
              inline={inline.data?.counts?.[b.attrs.bid]} onInline={(bid) => nav(`/w/${d.work.code}/comments?chapter=${d.chapter.id}&block=${bid}`)} />
          ))}
        </div>
        {d.mode === "preview" && (
          <div className="paywall" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 28 }} aria-hidden>🔒</div>
            <h2 style={{ marginTop: 6 }}>{d.access.reason === "not_released" ? t("Bob hali ochilmagan") : t("Davomi Premiumda")}</h2>
            <p className="small" style={{ opacity: 0.8 }}>{t("Bu bepul namuna edi. To'liq matn faqat ruxsat bo'lganda yuklanadi.")}</p>
            <div className="stack mt16">
              {d.access.offers.includes("premium") && <Link className="btn premium block" to={`/premium?work=${d.work.id}`}>⭐ {t("Premium bilan o'qish")}</Link>}
              {d.access.offers.includes("purchase") && <Link className="btn block" to={`/premium?work=${d.work.id}&buy=1`}>{t("Asarni sotib olish")}</Link>}
            </div>
          </div>
        )}
        {d.mode === "full" && (
          <div className="stack mt24" style={{ fontFamily: "var(--font-sans)" }} onClick={(e) => e.stopPropagation()}>
            {d.choices?.length ? (
              <Choices chapterId={d.chapter.id} choices={d.choices} onGo={(id) => nav(`/read/${id}`)} />
            ) : d.next_chapter ? (
              <button className="btn primary big block" onClick={() => nav(`/read/${d.next_chapter.id}`)}>
                {d.next_chapter.locked && <ILock />} {t("Keyingi bob")}: {tr(d.next_chapter.title)}
              </button>
            ) : (
              <div className="panel center" style={{ color: "var(--text)" }}>
                <div style={{ fontSize: 26 }}>🌙</div>
                <b>{t("Hozircha shu yerda tugadi")}</b>
                <div className="small muted mt8">{t("Muallifga rahmat aytishni unutmang")}</div>
                <Link className="btn mt16" to={`/w/${d.work.code}`}>{t("Asar sahifasi")}</Link>
              </div>
            )}
            {d.work.comments_policy !== "closed" && <Link className="btn ghost block" to={`/w/${d.work.code}/comments?chapter=${d.chapter.id}`}><IChat /> {t("Bob muhokamasi")}</Link>}
            <button className="btn ghost block" onClick={() => setShareOpen(true)}>↗ {t("Do'stga ulashish")}</button>
            <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} target={{ type: "work", id: d.work.id, title: d.work.title }} />
          </div>
        )}
      </div>

      <div className={`r-bar r-bottom ${bars ? "" : "hidden"}`}>
        <button className="icon-btn" aria-label={t("Oldingi bob")} disabled={!d.prev_chapter_id} onClick={() => nav(`/read/${d.prev_chapter_id}`)}><IPrev /></button>
        <button className="icon-btn" aria-label={t("Mundarija")} onClick={() => setSheet("toc")}><IList /></button>
        <div className="grow" />
        <span className="tiny dim">{Math.round(ratio * 100)}%</span>
        <div className="grow" />
        <Link className="icon-btn" aria-label={t("Bob muhokamasi")} to={`/w/${d.work.code}/comments?chapter=${d.chapter.id}`}><IChat /></Link>
        <button className="icon-btn" aria-label={t("Keyingi bob")} disabled={!d.next_chapter} onClick={() => nav(`/read/${d.next_chapter.id}`)}><INext /></button>
      </div>

      <Sheet open={sheet === "settings"} onClose={() => setSheet(null)} label={t("O'qish sozlamalari")}>
        <h2>{t("O'qish sozlamalari")}</h2>
        <div className="stack mt16">
          <Seg value={settings.theme} onChange={(v) => saveSettings({ theme: v })} options={[["light", t("Oq")], ["sepia", t("Sepia")], ["dark", t("To'q")]]} />
          <Seg value={settings.font} onChange={(v) => saveSettings({ font: v })} options={[["serif", "Serif"], ["sans", "Sans"]]} />
          <div className="row">
            <button className="btn" aria-label={t("Kichikroq")} onClick={() => saveSettings({ font_size: Math.max(16, settings.font_size - 1) })}>A−</button>
            <input type="range" min={16} max={28} value={settings.font_size} onChange={(e) => saveSettings({ font_size: Number(e.target.value) })} className="grow" aria-label={t("Shrift o'lchami")} />
            <button className="btn" aria-label={t("Kattaroq")} onClick={() => saveSettings({ font_size: Math.min(28, settings.font_size + 1) })}>A+</button>
            <span className="small" style={{ width: 32 }}>{settings.font_size}</span>
          </div>
          <div className="field"><label>{t("Qator oralig'i")}</label>
            <Seg value={String(settings.line_height)} onChange={(v) => saveSettings({ line_height: Number(v) })} options={[["1.45", "1.45"], ["1.65", "1.65"], ["1.9", "1.9"]]} />
          </div>
          <div className="field"><label>{t("Matn kengligi")}</label>
            <Seg value={settings.width} onChange={(v) => saveSettings({ width: v })} options={[["narrow", t("Tor")], ["normal", t("O'rta")], ["wide", t("Keng")]]} />
          </div>
          <button className="toggle" onClick={() => saveSettings({ show_progress: !settings.show_progress })}><span>{t("Progress chizig'i")}</span><span className={`switch ${settings.show_progress ? "on" : ""}`} /></button>
          {me?.script === "cyrl" && d.work.script === "latn" && (
            <button className="toggle" onClick={() => saveSettings({ original_script: !settings.original_script })}><span>{t("Asl yozuvda (lotin) ko'rsatish")}</span><span className={`switch ${settings.original_script ? "on" : ""}`} /></button>
          )}
        </div>
      </Sheet>

      <Sheet open={sheet === "toc"} onClose={() => setSheet(null)} label={t("Mundarija")}>
        <h2>{t("Mundarija")}</h2>
        {!toc.data ? <Spinner /> : (
          <div className="list mt16">
            {toc.data.map((c: any) => (
              <button key={c.id} onClick={() => { setSheet(null); nav(`/read/${c.id}`); }} style={{ fontWeight: c.id === d.chapter.id ? 700 : 400 }}>
                <span className="dim" style={{ width: 22 }}>{c.index}</span>
                <span className="grow">{c.title}</span>
                {c.access === "locked" && <ILock />}{c.completed && "✓"}
              </button>
            ))}
          </div>
        )}
      </Sheet>

      <SelectionSheet open={sheet === "select"} selection={selection} onClose={() => { setSheet(null); setSelection(null); }} onHighlight={saveHighlight} onIssue={reportIssue} canSave={d.mode === "full"} work={d.work} chapterId={d.chapter.id} isAuthor={!!me?.author || !!me?.is_staff} onCommented={() => inline.refetch()} />
    </div>
  );
}

function SelectionSheet({ open, selection, onClose, onHighlight, onIssue, canSave, work, chapterId, isAuthor, onCommented }: { open: boolean; selection: { bid: string; quote: string } | null; onClose: () => void; onHighlight: (note?: string) => void; onIssue: (note: string) => void; canSave: boolean; work: any; chapterId: number; isAuthor: boolean; onCommented: () => void }) {
  const t = useT();
  const toast = useToast();
  const [mode, setMode] = useState<"" | "note" | "issue" | "comment">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setMode(""); setText(""); } }, [open]);
  if (!selection) return null;
  const q = selection.quote.trim().slice(0, 200);
  const shareQuote = () => {
    shareLink(`https://t.me/share/url`, `«${q}» — ${work.title}`);
  };
  const quoteCard = async () => {
    setBusy(true);
    try {
      const r = await post<{ image_url: string; link: string; text: string }>("/share/quote-card", { chapter_id: chapterId, block_id: selection.bid, text: q, theme: "paper" });
      if (canShareToStory()) shareToStory(r.image_url, r.text, r.link);
      else shareLink(r.link, `${r.text}\n${r.image_url}`);
      onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const storyDraft = async () => {
    setBusy(true);
    try {
      await post("/studio/storis/quote-draft", { chapter_id: chapterId, block_id: selection.bid, text: q, theme: "night" });
      toast(t("Storis qoralamasi yaratildi: Ijod ustaxonasi → Storis"));
      onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const sendComment = async () => {
    setBusy(true);
    try {
      await post(`/works/${work.id}/comments`, { body: text, chapter_id: chapterId, block_id: selection.bid, quote: q, client_key: uuid() });
      toast(t("Izoh qo'shildi"));
      onCommented();
      onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label={t("Belgilangan matn")}>
      <blockquote className="small muted" style={{ margin: 0, borderLeft: "3px solid var(--accent)", paddingLeft: 10 }}>{selection.quote.slice(0, 300)}</blockquote>
      {mode === "" ? (
        <div className="stack mt16">
          {canSave && <button className="btn block" onClick={() => onHighlight()}>✨ {t("Iqtibosni saqlash")}</button>}
          {canSave && <button className="btn block" onClick={() => setMode("note")}>📝 {t("Shaxsiy eslatma")}</button>}
          {canSave && work.comments_policy !== "closed" && <button className="btn block" onClick={() => setMode("comment")}>💬 {t("Shu joyga izoh")}</button>}
          <button className="btn block" onClick={() => setMode("issue")}>🛠 {t("Xato haqida xabar")}</button>
          {canSave && <button className="btn block" disabled={busy} onClick={quoteCard}>🖼 {canShareToStory() ? t("Iqtibos kartasi → storis") : t("Iqtibos kartasi")}</button>}
          {canSave && isAuthor && <button className="btn ghost block" disabled={busy} onClick={storyDraft}>✍️ {t("Muallif storisi qoralamasi")}</button>}
          <button className="btn ghost block" onClick={shareQuote}>{t("Ulashish (200 belgigacha)")}</button>
          {canShareToStory() && <p className="tiny dim">{t("Telegram storisiga ulashish ixtiyoriy alohida amal.")}</p>}
        </div>
      ) : (
        <div className="stack mt16">
          <textarea className="textarea" autoFocus maxLength={mode === "note" || mode === "comment" ? 2000 : 1000} value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === "note" ? t("Faqat sizga ko'rinadi") : mode === "comment" ? t("Boshqa o'quvchilar ham ko'radi. Spoiler yozmang.") : t("Qanday xato? (imlo, mantiq...)")} />
          <button className="btn primary block" disabled={!text.trim() || busy} onClick={() => (mode === "note" ? onHighlight(text) : mode === "comment" ? sendComment() : onIssue(text))}>{mode === "comment" ? t("Yuborish") : t("Saqlash")}</button>
        </div>
      )}
    </Sheet>
  );
}


/** Branching point: the reader decides where the story goes. Crowd percentages appear only after choosing. */
function Choices({ chapterId, choices, onGo }: { chapterId: number; choices: any[]; onGo: (id: number) => void }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pick = async (c: any) => {
    setBusy(true);
    haptic.tap();
    try {
      await post(`/chapters/${chapterId}/choices/${c.id}`);
      onGo(c.target_chapter_id);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="panel stack" style={{ color: "var(--text)" }}>
      <b>🔀 {t("Hikoya qayoqqa ketadi?")}</b>
      {choices.map((c) => (
        <button key={c.id} className={`btn block choice ${c.chosen ? "primary" : ""}`} disabled={busy} onClick={() => pick(c)}>
          {c.locked && <ILock />} {c.label}
          {c.percent != null && <span className="tiny" style={{ marginLeft: "auto", opacity: 0.8 }}>{c.percent}%</span>}
        </button>
      ))}
      {choices.some((c) => c.chosen) && <span className="tiny dim">{t("Tanlovni istalgan vaqtda o'zgartirishingiz mumkin. Foizlar boshqa o'quvchilar tanlovi.")}</span>}
    </div>
  );
}
