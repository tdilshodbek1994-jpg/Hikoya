import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { Spinner, TopBar, useToast } from "../../components/ui";
import { get, post } from "../../lib/api";
import { fmtDate, useT } from "../../lib/i18n";
import { confirmDialog } from "../../lib/tg";

/** E-23: immutable revision history, block-level diff and audited rollback (T-33). */
export default function History() {
  const { chapterId } = useParams();
  const t = useT();
  const toast = useToast();
  const revs = useQuery({ queryKey: ["revs", chapterId], queryFn: () => get<any[]>(`/studio/chapters/${chapterId}/revisions`) });
  const [sel, setSel] = useState<number | null>(null);
  const diff = useQuery({ queryKey: ["diff", sel], enabled: !!sel, queryFn: () => get(`/studio/revisions/${sel}/diff`) });
  const restore = async (id: number, publish: boolean) => {
    if (!(await confirmDialog(publish ? t("Bu nusxa nashr qilinsinmi? Tarix o'chirilmaydi.") : t("Bu nusxa qoralamaga tiklansinmi?")))) return;
    try {
      await post(`/studio/chapters/${chapterId}/restore`, { revision_id: id, publish });
      toast(t("Tiklandi"));
      revs.refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Tahrirlar tarixi")} />
      {!revs.data ? <Spinner /> : (
        <div className="pad stack">
          {revs.data.map((r) => (
            <div key={r.id} className="panel">
              <div className="row between">
                <b>#{r.id}</b>
                <div className="row" style={{ gap: 6 }}>{r.published && <span className="pill ok">{t("Nashrda")}</span>}{r.draft && <span className="pill warn">{t("Qoralama")}</span>}</div>
              </div>
              <div className="small muted">{fmtDate(r.created_at, true)} · {r.words} {t("so'z")}{r.note ? ` · ${r.note}` : ""}</div>
              <div className="row wrap mt8" style={{ gap: 8 }}>
                <button className="btn" style={{ minHeight: 36 }} onClick={() => setSel(sel === r.id ? null : r.id)}>{t("Farqni ko'rish")}</button>
                {!r.published && <button className="btn ghost" style={{ minHeight: 36 }} onClick={() => restore(r.id, false)}>{t("Qoralamaga tiklash")}</button>}
                {!r.published && <button className="btn ghost" style={{ minHeight: 36 }} onClick={() => restore(r.id, true)}>{t("Tiklash va nashr")}</button>}
              </div>
              {sel === r.id && (
                <div className="mt16 small" style={{ fontFamily: "var(--font-serif)" }}>
                  {!diff.data ? <Spinner /> : !diff.data.changes.length ? <span className="muted">{t("Farq yo'q")}</span> : diff.data.changes.map((c: any) => (
                    <p key={c.bid + c.op} style={{ margin: "0 0 10px" }}>
                      {c.op === "added" && <span className="diff-ins">{c.text}</span>}
                      {c.op === "removed" && <span className="diff-del">{c.text}</span>}
                      {c.op === "changed" && c.parts.map((p: any, i: number) => <span key={i} className={p.t === "ins" ? "diff-ins" : p.t === "del" ? "diff-del" : ""}>{p.s} </span>)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
