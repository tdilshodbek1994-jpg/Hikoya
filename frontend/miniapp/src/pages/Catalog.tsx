import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Empty, ErrorBox, Grid, Sheet, Spinner, TopBar } from "../components/ui";
import { get, type Card } from "../lib/api";
import { useT } from "../lib/i18n";
import { useState } from "react";

/** E-04: catalogue with independent filters. Filters live in the URL so «back» and links keep them. */
export default function Catalog() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const [open, setOpen] = useState(false);
  const f = Object.fromEntries(sp.entries());
  const { data: genres } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });
  const q = useInfiniteQuery({
    queryKey: ["catalog", f],
    queryFn: ({ pageParam }) => get<{ items: Card[]; next_cursor: string | null }>("/works", { ...f, genre: sp.getAll("genre"), cursor: pageParam, limit: 24 }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v === null || v === "") n.delete(k);
    else n.set(k, v);
    setSp(n, { replace: true });
  };
  const items = q.data?.pages.flatMap((p) => p.items) || [];
  const genreName = genres?.find((g) => g.slug === f.genre)?.name;
  const active = Object.keys(f).filter((k) => k !== "sort").length;
  const chip = (k: string, v: string, label: string, cls = "") => (
    <button className={`chip ${f[k] === v ? "on" : ""} ${cls}`} aria-pressed={f[k] === v} onClick={() => set(k, f[k] === v ? null : v)}>
      {t(label)}
    </button>
  );
  return (
    <div className="page">
      <TopBar title={genreName || t("Katalog")} right={<button className="btn ghost" style={{ minHeight: 36 }} onClick={() => setOpen(true)}>{t("Filtr")}{active ? ` (${active})` : ""}</button>} />
      <div className="chips">
        {chip("access", "premium", "Premium", "premium")}
        {chip("access", "free", "Bepul")}
        {chip("access", "purchase", "Alohida xarid")}
        {chip("status", "completed", "Tugallangan")}
        {chip("status", "ongoing", "Davom etmoqda")}
        {chip("has_audio", "true", "Audio bor")}
        {active > 0 && (
          <button className="chip" onClick={() => setSp(new URLSearchParams(f.sort ? { sort: f.sort } : {}), { replace: true })}>✕ {t("Hammasini tozalash")}</button>
        )}
      </div>
      <div className="pad row between mt8" style={{ marginBottom: 10 }}>
        <span className="small muted">{items.length ? `${items.length}${q.hasNextPage ? "+" : ""} ${t("asar")}` : ""}</span>
        <select className="select" style={{ width: "auto", minHeight: 36 }} value={f.sort || "new"} onChange={(e) => set("sort", e.target.value)} aria-label={t("Tartib")}>
          <option value="new">{t("Yangi")}</option>
          <option value="popular">{t("Ko'p o'qilgan")}</option>
          <option value="thanks">{t("Ko'p rahmat")}</option>
          <option value="updated">{t("Yangilangan")}</option>
          <option value="short">{t("Qisqasi avval")}</option>
        </select>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={q.refetch} /> : items.length ? <Grid items={items} /> : (
        <Empty icon="🔎" title={t("Bu filtrlar bo'yicha asar topilmadi")}>
          <button className="btn mt8" onClick={() => setSp(new URLSearchParams(), { replace: true })}>{t("Filtrlarni tozalash")}</button>
        </Empty>
      )}
      {q.hasNextPage && (
        <div className="pad mt16">
          <button className="btn block" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Yana ko'rsatish")}</button>
        </div>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} label={t("Filtr")}>
        <h2>{t("Filtr")}</h2>
        <div className="stack mt16">
          <div className="field">
            <label>{t("Janr")}</label>
            <select className="select" value={f.genre || ""} onChange={(e) => set("genre", e.target.value)}>
              <option value="">{t("Barchasi")}</option>
              {genres?.map((g) => <option key={g.slug} value={g.slug}>{g.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("Format")}</label>
            <select className="select" value={f.format || ""} onChange={(e) => set("format", e.target.value)}>
              <option value="">{t("Barchasi")}</option>
              <option value="short">{t("Qisqa hikoya")}</option>
              <option value="novella">{t("Qissa")}</option>
              <option value="novel">{t("Roman")}</option>
              <option value="series">{t("Turkum")}</option>
              <option value="diary">{t("Kundalik")}</option>
            </select>
          </div>
          <div className="field">
            <label>{t("Yozuv")}</label>
            <select className="select" value={f.script || ""} onChange={(e) => set("script", e.target.value)}>
              <option value="">{t("Barchasi")}</option>
              <option value="latn">{t("Lotin")}</option>
              <option value="cyrl">Кирилл</option>
            </select>
          </div>
          <div className="field">
            <label>{t("Hajm (daqiqa)")}</label>
            <div className="row">
              <input className="input" inputMode="numeric" placeholder={t("dan")} value={f.min_minutes || ""} onChange={(e) => set("min_minutes", e.target.value.replace(/\D/g, ""))} />
              <input className="input" inputMode="numeric" placeholder={t("gacha")} value={f.max_minutes || ""} onChange={(e) => set("max_minutes", e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <button className="btn primary block" onClick={() => setOpen(false)}>{t("Ko'rsatish")}</button>
        </div>
      </Sheet>
    </div>
  );
}
