import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Empty, Spinner, TopBar, useToast } from "../../components/ui";
import { get, post } from "../../lib/api";
import { fmtDate, useT } from "../../lib/i18n";
import { upload } from "./WorkEditor";

type Frame = { kind: string; text: string; background: string; media_asset_id?: number; preview?: string; linked_work_id?: number | null; linked_chapter_id?: number | null; action_type?: string; audience: string; poll_options: string[] };
const BGS = ["violet", "night", "sunset", "forest", "gold", "rose"];

/** Author storis composer: text/quote/image/video/poll/new chapter frames, premium-only frames, scheduling. */
export default function StoryComposer() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [frames, setFrames] = useState<Frame[]>([{ kind: "text", text: "", background: "violet", audience: "all", poll_options: [] }]);
  const [hours, setHours] = useState(24);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const works = useQuery({ queryKey: ["studio-works", "mine"], queryFn: () => get<any[]>("/studio/works", { scope: "mine" }) });
  const upd = (i: number, p: Partial<Frame>) => setFrames((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const onMedia = async (i: number, file?: File) => {
    if (!file) return;
    try {
      const a = await upload(file, "story_media");
      upd(i, { media_asset_id: a.asset_id, kind: a.kind === "video" ? "video" : "image", preview: a.url });
    } catch (e: any) { toast(e.message, true); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/studio/storis", {
        frames: frames.map(({ preview: _p, ...f }) => ({ ...f, linked_work_id: f.linked_work_id || null })),
        duration_hours: hours,
        publish_at: when ? new Date(when).toISOString() : null,
      });
      toast(r.status === "published" ? t("Storis nashr qilindi") : t("Storis tekshiruvga yuborildi"));
      nav("/studio/stories", { replace: true });
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Yangi storis")} />
      <div className="pad stack">
        <p className="tiny dim">{t("Bu ilova ichidagi storis. Telegram storisiga ulashish alohida ixtiyoriy amal.")}</p>
        {frames.map((f, i) => (
          <div key={i} className="panel stack">
            <div className="row between"><b>{t("Lavha")} {i + 1}</b>{frames.length > 1 && <button className="link tiny" onClick={() => setFrames((fs) => fs.filter((_, j) => j !== i))}>{t("O'chirish")}</button>}</div>
            <select className="select" value={f.kind} onChange={(e) => upd(i, { kind: e.target.value })}>
              <option value="text">{t("Rangli fondagi matn")}</option><option value="quote">{t("Iqtibos kartasi")}</option><option value="image">{t("Rasm va izoh")}</option><option value="video">{t("Qisqa video (≤60 s)")}</option><option value="chapter">{t("Yangi bob e'loni")}</option><option value="poll">{t("So'rov")}</option>
            </select>
            {(f.kind === "image" || f.kind === "video") && (
              <>
                <input type="file" accept={f.kind === "video" ? "video/mp4" : "image/jpeg,image/png,image/webp"} onChange={(e) => onMedia(i, e.target.files?.[0])} />
                {f.preview && f.kind === "image" && <img src={f.preview} alt="" style={{ maxHeight: 160, borderRadius: 10 }} />}
              </>
            )}
            <textarea className="textarea" maxLength={700} value={f.text} onChange={(e) => upd(i, { text: e.target.value })} placeholder={f.kind === "quote" ? t("Asardan qisqa parcha (spoilersiz)") : t("Matn")} />
            {(f.kind === "text" || f.kind === "quote" || f.kind === "poll" || f.kind === "chapter") && (
              <div className="row wrap" style={{ gap: 6 }}>{BGS.map((b) => <button key={b} aria-label={b} className={`bg-${b}`} style={{ width: 34, height: 34, borderRadius: 17, outline: f.background === b ? "2px solid #fff" : "none" }} onClick={() => upd(i, { background: b })} />)}</div>
            )}
            {f.kind === "poll" && (
              <div className="stack">
                {[0, 1, 2, 3].map((k) => <input key={k} className="input" placeholder={`${t("Variant")} ${k + 1}`} value={f.poll_options[k] || ""} onChange={(e) => { const o = [...f.poll_options]; o[k] = e.target.value; upd(i, { poll_options: o.filter((x, idx) => x || idx < k) }); }} />)}
              </div>
            )}
            <select className="select" value={f.linked_work_id || 0} onChange={(e) => upd(i, { linked_work_id: Number(e.target.value) || null, action_type: Number(e.target.value) ? (f.kind === "chapter" ? "new_chapter" : "read") : "" })}>
              <option value={0}>{t("Asarga havola yo'q")}</option>
              {works.data?.filter((w) => w.editorial_state === "published").map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
            </select>
            <label className="row small"><input type="checkbox" checked={f.audience === "premium"} onChange={(e) => upd(i, { audience: e.target.checked ? "premium" : "all" })} /> {t("Faqat Premium uchun to'liq lavha")}</label>
          </div>
        ))}
        {frames.length < 10 && <button className="btn" onClick={() => setFrames((fs) => [...fs, { kind: "text", text: "", background: "night", audience: "all", poll_options: [] }])}>+ {t("Lavha")}</button>}
        <div className="row">
          <div className="field grow"><label>{t("Muddat")}</label><select className="select" value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={24}>24 {t("soat")}</option><option value={48}>48 {t("soat")}</option><option value={72}>72 {t("soat")}</option></select></div>
          <div className="field grow"><label>{t("Rejalashtirish")}</label><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
        </div>
        <p className="tiny dim">{t("48/72 soat egasi yoqqan bo'lsa ishlaydi. Ishonchli muallif darhol nashr qiladi, qolganlari tekshiruvga.")}</p>
        <button className="btn primary big block" disabled={busy} onClick={submit}>{t("Joylash")}</button>
      </div>
    </div>
  );
}

export function MyStories() {
  const t = useT();
  const list = useQuery({ queryKey: ["my-stories"], queryFn: () => get<any[]>("/studio/storis") });
  const stats = useQuery({ queryKey: ["story-stats"], queryFn: () => get<any[]>("/studio/storis/analytics") });
  const statFor = (id: number) => stats.data?.find((s) => s.story_id === id);
  return (
    <div className="page no-nav">
      <TopBar title={t("Storislarim")} right={<Link to="/studio/stories/new" className="btn primary" style={{ minHeight: 36 }}>+</Link>} />
      {!list.data ? <Spinner /> : !list.data.length ? <Empty icon="📮" title={t("Hali storis yo'q")} /> : (
        <div className="pad stack">
          {list.data.map((s) => {
            const st = statFor(s.id);
            return (
              <div key={s.id} className="panel">
                <div className="row between"><span className="pill">{s.status}</span><span className="tiny dim">{fmtDate(s.publish_at, true)} → {fmtDate(s.expires_at, true)}</span></div>
                {s.moderation_note && <div className="small" style={{ color: "var(--danger)" }}>{s.moderation_note}</div>}
                {st && <div className="meta mt8"><span>👁 {st.unique_views}</span><span>✓ {st.completed_views}</span><span>⏭ {st.skips}</span><span>🔗 {st.link_clicks}</span><span>📖 {st.work_starts}</span>{st.small_sample && <span className="dim">{t("kam namuna")}</span>}</div>}
                <Link className="link small" to={`/s/${s.id}`}>{t("Ko'rish")}</Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
