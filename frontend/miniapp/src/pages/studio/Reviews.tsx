import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Empty, Spinner, TopBar, useToast } from "../../components/ui";
import { get, post } from "../../lib/api";
import { fmtDate, useT } from "../../lib/i18n";

/** E-24 (editorial side): publication review queue with diff/preview links. */
export default function Reviews() {
  const t = useT();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ["reviews"], queryFn: () => get<any[]>("/studio/reviews") });
  const [note, setNote] = useState<Record<number, string>>({});
  const decide = async (id: number, decision: string) => {
    try {
      await post(`/studio/reviews/${id}`, { decision, note: note[id] || "" });
      toast(decision === "approved" ? t("Tasdiqlandi") : t("Muallifga qaytarildi"));
      refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Tekshiruv navbati")} />
      {!data ? <Spinner /> : !data.length ? <Empty icon="✅" title={t("Navbat bo'sh")} /> : (
        <div className="pad stack">
          {data.map((r) => (
            <div key={r.id} className="panel stack" style={{ gap: 8 }}>
              <div className="row between"><b>{r.work_title}</b><span className="tiny dim">{fmtDate(r.created_at)}</span></div>
              <div className="small muted">{r.chapter_title}{r.note ? ` — ${r.note}` : ""}</div>
              {r.requested_access && <span className="pill warn">{t("So'ralgan kirish")}: {r.requested_access}</span>}
              <div className="row wrap" style={{ gap: 8 }}>
                {r.chapter_id && <Link className="btn ghost" style={{ minHeight: 36 }} to={`/studio/p/${r.chapter_id}`}>👁 {t("Preview")}</Link>}
                {r.revision_id && <Link className="btn ghost" style={{ minHeight: 36 }} to={`/studio/h/${r.chapter_id}`}>{t("Farq")}</Link>}
                <Link className="btn ghost" style={{ minHeight: 36 }} to={`/studio/w/${r.work_id}`}>{t("Asar")}</Link>
              </div>
              <textarea className="textarea" style={{ minHeight: 60 }} placeholder={t("Muallifga izoh (tuzatish uchun majburiy emas)")} value={note[r.id] || ""} onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))} />
              <div className="row"><button className="btn primary grow" onClick={() => decide(r.id, "approved")}>{t("Tasdiqlash")}</button><button className="btn grow" onClick={() => decide(r.id, "changes_requested")}>{t("Tuzatish so'rash")}</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
