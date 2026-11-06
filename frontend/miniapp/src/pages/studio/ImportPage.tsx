import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { TopBar, useToast } from "../../components/ui";
import { ApiError, post } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { upload } from "./WorkEditor";

/** E-22: file → type/size check → safe parser → chapter guess → review → draft. */
export default function ImportPage() {
  const { workId } = useParams();
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [job, setJob] = useState<any>(null);
  const [assetId, setAssetId] = useState<number | null>(null);
  const [dup, setDup] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [titles, setTitles] = useState<Record<number, string>>({});

  const start = async (id: number, allowDuplicate = false) => {
    setBusy(true);
    try {
      const j = await post("/studio/imports", { asset_id: id, work_id: Number(workId), allow_duplicate: allowDuplicate });
      setJob(j);
      setDup(null);
      setSelected(j.chapters.map((c: any) => c.index));
    } catch (e) {
      if (e instanceof ApiError && e.code === "duplicate_import") setDup(e.data);
      else toast(e instanceof Error ? e.message : "Xato", true);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const a = await upload(f, "import");
      setAssetId(a.asset_id);
      await start(a.asset_id);
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await post(`/studio/imports/${job.id}/apply`, { selected, titles });
      toast(t("Boblar qoralamaga qo'shildi"));
      nav(`/studio/w/${workId}`, { replace: true });
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Matn importi")} />
      <div className="pad stack">
        <p className="small muted">{t("TXT, Markdown (≤5 MiB), DOCX yoki EPUB (≤10 MiB), PDF (matn qatlami bo'lsa). Import faqat qoralama yaratadi; nashr qilingan matn o'zgarmaydi.")}</p>
        <input type="file" accept=".txt,.md,.markdown,.docx,.epub,.pdf" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
        {dup && (
          <div className="panel" style={{ borderColor: "var(--premium)" }}>
            <b>{t("Bu fayl allaqachon import qilingan")}</b>
            <p className="small muted">{t("Ikki bir xil bob yaratilmasligi uchun to'xtatdik. Ataylab nusxa kerak bo'lsa davom eting.")}</p>
            <button className="btn" onClick={() => assetId && start(assetId, true)}>{t("Baribir nusxa olish")}</button>
          </div>
        )}
        {job && (
          <>
            <div className="panel small">
              <b>{t("Hisobot")}</b>
              <div className="mt8">{t("Aniqlangan boblar")}: {job.report.detected_chapters} · {t("so'zlar")}: {job.report.total_words}</div>
              {job.report.warnings?.map((w: string, i: number) => <div key={i} style={{ color: "var(--premium)" }}>⚠ {w}</div>)}
              {!!job.report.lost_formatting?.length && <div className="muted">{t("Saqlanmagan format")}: {job.report.lost_formatting.join(", ")}</div>}
              {job.status === "failed" && <div style={{ color: "var(--danger)" }}>{t("Faylni o'qib bo'lmadi")}</div>}
            </div>
            {job.chapters.map((c: any) => (
              <div key={c.index} className="panel">
                <label className="row"><input type="checkbox" checked={selected.includes(c.index)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.index] : s.filter((x) => x !== c.index)))} />
                  <input className="input grow" value={titles[c.index] ?? c.title} onChange={(e) => setTitles((x) => ({ ...x, [c.index]: e.target.value }))} /></label>
                <div className="tiny dim mt8">{c.words} {t("so'z")}</div>
                <div className="small muted mt8" style={{ fontFamily: "var(--font-serif)" }}>{c.preview}…</div>
              </div>
            ))}
            {job.status === "parsed" && <button className="btn primary big block" disabled={busy || !selected.length} onClick={apply}>{t("Tanlangan boblarni qoralamaga qo'shish")} ({selected.length})</button>}
          </>
        )}
      </div>
    </div>
  );
}
