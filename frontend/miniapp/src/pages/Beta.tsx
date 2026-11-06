import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorBox, Sheet, Spinner, TopBar, useToast } from "../components/ui";
import { get, post, type Block } from "../lib/api";
import { untilDate, useT } from "../lib/i18n";

/** Beta-reader landing: an unpublished draft shared personally by the author (b_<token> link). */
export function BetaHome() {
  const { token } = useParams();
  const t = useT();
  const q = useQuery({ queryKey: ["beta", token], queryFn: () => get(`/beta/${token}`) });
  if (q.isLoading) return <div className="page no-nav"><TopBar title={t("Beta o'qish")} /><Spinner /></div>;
  if (q.error || !q.data) return <div className="page no-nav"><TopBar title={t("Beta o'qish")} /><ErrorBox error={q.error} /></div>;
  const d = q.data;
  return (
    <div className="page no-nav">
      <TopBar title={t("Beta o'qish")} />
      <div className="pad stack">
        <div className="panel">
          <span className="pill">β {t("Qoralama")}</span>
          <h2 className="mt8">{d.work.title}</h2>
          {d.work.synopsis && <p className="small muted">{d.work.synopsis}</p>}
          {d.note && <p className="small">✉️ {d.note}</p>}
          <p className="tiny dim">{t("Muallif sizni shaxsan taklif qildi. Matn hali nashr qilinmagan: uni boshqalarga tarqatmang.")} {t("Havola")}: {untilDate(d.expires_at)}</p>
        </div>
        <div className="list">
          {d.chapters.map((c: any) => (
            <Link key={c.id} to={`/beta/${token}/c/${c.id}`} className="li"><span className="grow">{c.title}</span><span className="tiny dim">{c.words} {t("so'z")}</span></Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function text(b: Block): string {
  return "content" in b && Array.isArray(b.content) ? b.content.map((n: any) => (n.type === "text" ? n.text : "\n")).join("") : "";
}

/** Plain reader for drafts + feedback bound to a paragraph. Nothing here counts as a read in stats. */
export function BetaReader() {
  const { token, chapterId } = useParams();
  const t = useT();
  const toast = useToast();
  const q = useQuery({ queryKey: ["beta-ch", chapterId], queryFn: () => get(`/beta/chapters/${chapterId}`) });
  const [bid, setBid] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <div className="page no-nav"><TopBar /><Spinner /></div>;
  if (q.error || !q.data) return <div className="page no-nav"><TopBar /><ErrorBox error={q.error} /></div>;
  const d = q.data;
  const blocks: Block[] = d.content.content || [];
  const send = async (blockId: string) => {
    setBusy(true);
    try {
      await post(`/beta/chapters/${chapterId}/feedback`, { body, block_id: blockId });
      toast(t("Fikringiz muallifga yuborildi"));
      setBody("");
      setBid(null);
      q.refetch();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={d.chapter.title} />
      <div className="pad">
        <p className="tiny dim">β {t("Xatboshiga bosing va o'sha joy haqida fikr yozing.")} <Link className="link tiny" to={`/beta/${token}`}>{t("Boblar")}</Link></p>
        <div className="rtext" style={{ fontSize: 18, lineHeight: 1.65 }}>
          {blocks.map((b) =>
            b.type === "image" ? (
              d.images[String(b.attrs.asset_id)] ? <img key={b.attrs.bid} src={d.images[String(b.attrs.asset_id)]} alt={b.attrs.caption} style={{ maxWidth: "100%" }} /> : null
            ) : b.type === "horizontalRule" ? <hr key={b.attrs.bid} /> : (
              <p key={b.attrs.bid} onClick={() => setBid(b.attrs.bid)} style={{ cursor: "pointer", fontWeight: b.type === "heading" ? 700 : undefined }}>
                {text(b)}
                {d.my_feedback.some((f: any) => f.block_id === b.attrs.bid) && <span className="tiny"> 💬</span>}
              </p>
            ),
          )}
        </div>
        <div className="panel stack mt16">
          <b className="small">{t("Bob haqida umumiy fikr")}</b>
          <textarea className="textarea" maxLength={2000} value={bid ? "" : body} onChange={(e) => { setBid(null); setBody(e.target.value); }} />
          <button className="btn primary" disabled={!body.trim() || busy || !!bid} onClick={() => send("")}>{t("Yuborish")}</button>
        </div>
        {!!d.my_feedback.length && (
          <div className="stack mt16">
            <b className="small">{t("Siz yuborgan fikrlar")}</b>
            {d.my_feedback.map((f: any) => <div key={f.id} className="small muted">• {f.body.replace(/^\[Beta\] /, "")}</div>)}
          </div>
        )}
      </div>
      <Sheet open={!!bid} onClose={() => setBid(null)} label={t("Shu joy haqida fikr")}>
        <h2>{t("Shu joy haqida fikr")}</h2>
        <textarea className="textarea mt8" autoFocus maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("Nima tushunarsiz, ortiqcha yoki yoqdi?")} />
        <button className="btn primary block mt16" disabled={!body.trim() || busy} onClick={() => send(bid!)}>{t("Yuborish")}</button>
      </Sheet>
    </div>
  );
}
