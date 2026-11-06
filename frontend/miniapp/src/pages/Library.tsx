import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Cover, Empty, Grid, Sheet, Spinner, TopBar, useToast } from "../components/ui";
import { del, get, post, type Card } from "../lib/api";
import { useT } from "../lib/i18n";

const TABS: [string, string][] = [
  ["continue", "Davom ettirish"], ["saved", "Saqlanganlar"], ["reading", "O'qiyapman"], ["finished", "Tugatganlar"],
  ["purchased", "Sotib olinganlar"], ["quotes", "Iqtiboslar va eslatmalar"], ["collections", "To'plamlarim"],
];

/** E-15 */
export default function Library() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") || "continue";
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["library"], queryFn: () => get("/library") });
  const create = async () => {
    try {
      await post("/collections", { title });
      setTitle("");
      setNewOpen(false);
      qc.invalidateQueries({ queryKey: ["library"] });
    } catch (e: any) { toast(e.message, true); }
  };
  const list: Card[] = data?.[tab] || [];
  return (
    <div className="page">
      <div className="header"><h1 className="grow" style={{ fontSize: 22 }}>{t("Kutubxonam")}</h1></div>
      <div className="chips">
        {TABS.map(([k, l]) => <button key={k} className={`chip ${tab === k ? "on" : ""}`} onClick={() => setSp({ tab: k }, { replace: true })}>{t(l)}</button>)}
      </div>
      <div className="mt16">
        {isLoading ? <Spinner /> : tab === "continue" ? (
          list.length ? list.map((c) => (
            <Link key={c.id} to={c.progress ? `/read/${c.progress.chapter_id}` : `/w/${c.code}`} className="lrow">
              <Cover card={c} />
              <div className="grow"><div style={{ fontWeight: 600 }}>{c.title}</div><div className="bar mt8"><i style={{ width: `${Math.round((c.progress?.ratio || 0) * 100)}%` }} /></div></div>
            </Link>
          )) : <Empty icon="📖" title={t("Hali o'qishni boshlamadingiz")}><Link to="/" className="btn mt8">{t("Katalogga o'tish")}</Link></Empty>
        ) : tab === "quotes" ? (
          <div className="pad stack">
            {[...(data.highlights || []).map((h: any) => ({ ...h, k: "h" })), ...(data.notes || []).map((n: any) => ({ ...n, k: "n" })), ...(data.bookmarks || []).map((b: any) => ({ ...b, k: "b" }))].map((x: any) => (
              <Link key={x.k + x.id} to={`/read/${x.chapter_id}`} className="panel">
                <div className="tiny dim">{x.k === "h" ? "✨" : x.k === "n" ? "📝" : "🔖"} {x.work_title}</div>
                {x.quote && <div className="mt8" style={{ fontFamily: "var(--font-serif)" }}>«{x.quote}»</div>}
                {x.text && <div className="small muted mt8">{x.text}</div>}
              </Link>
            ))}
            {!data.highlights?.length && !data.notes?.length && !data.bookmarks?.length && <Empty icon="✨" title={t("Matnni belgilab iqtibos yoki eslatma saqlang")} />}
          </div>
        ) : tab === "collections" ? (
          <div className="pad stack">
            <p className="tiny dim">{t("To'plamlar faqat sizga ko'rinadi.")}</p>
            {data.collections.map((c: any) => (
              <Link key={c.id} to={`/collection/${c.id}`} className="panel row between"><b>{c.title}</b><span className="dim small">{c.count}</span></Link>
            ))}
            <button className="btn block" onClick={() => setNewOpen(true)}>+ {t("Yangi to'plam")}</button>
          </div>
        ) : list.length ? <Grid items={list} /> : <Empty icon="📚" title={t("Bu yerda hozircha bo'sh")} />}
      </div>
      <Sheet open={newOpen} onClose={() => setNewOpen(false)} label={t("Yangi to'plam")}>
        <h2>{t("Yangi to'plam")}</h2>
        <p className="small muted">{t("Masalan: «Dam olishda», «Keyin o'qiyman», «Yaqinlarimga tavsiya»")}</p>
        <input className="input mt16" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t("Nomi")} />
        <button className="btn primary block mt16" disabled={!title.trim()} onClick={create}>{t("Yaratish")}</button>
      </Sheet>
    </div>
  );
}

export function CollectionPage() {
  const { id } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["collection", id], queryFn: () => get(`/collections/${id}`) });
  const remove = async () => {
    await del(`/collections/${id}`);
    qc.invalidateQueries({ queryKey: ["library"] });
    history.back();
  };
  return (
    <div className="page no-nav">
      <TopBar title={data?.title} right={<button className="link small" onClick={remove}>{t("O'chirish")}</button>} />
      {!data ? <Spinner /> : data.items.length ? <Grid items={data.items} /> : <Empty icon="🗂" title={t("To'plam bo'sh")}>{t("Asar sahifasidan qo'shing.")}</Empty>}
    </div>
  );
}
