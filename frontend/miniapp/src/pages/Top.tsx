import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Cover, Empty, Seg, Spinner, TopBar } from "../components/ui";
import { get, type Card } from "../lib/api";
import { useT } from "../lib/i18n";

/** E-06: TOP lists. «Eng ko'p o'qilgan» = unique qualified readers in the calendar period. Trend is separate. */
export default function Top() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const period = sp.get("period") || "week";
  const metric = sp.get("metric") || "most_read";
  const genre = sp.get("genre") || "";
  const { data: genres } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });
  const { data, isLoading } = useQuery({ queryKey: ["rank", metric, period, genre], queryFn: () => get("/rankings", { metric, period, genre, limit: 50 }) });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    v ? n.set(k, v) : n.delete(k);
    setSp(n, { replace: true });
  };
  return (
    <div className="page">
      <TopBar title="TOP" />
      <div className="pad stack">
        <Seg value={metric} onChange={(v) => set("metric", v)} options={[["most_read", t("Ko'p o'qilgan")], ["trend", t("Trend")], ["thanks", t("Ko'p rahmat")]]} />
        {metric === "most_read" && <Seg value={period} onChange={(v) => set("period", v)} options={[["today", t("Bugun")], ["week", t("Hafta")], ["month", t("Oy")], ["all", t("Barchasi")]]} />}
        <select className="select" value={genre} onChange={(e) => set("genre", e.target.value)} aria-label={t("Janr")}>
          <option value="">{t("Barcha janrlar")}</option>
          {genres?.map((g) => <option key={g.slug} value={g.slug}>{g.name}</option>)}
        </select>
        <p className="tiny dim">
          {metric === "most_read" && `${data?.period_note || ""}. ${t("Bir o'quvchi davr ichida bir marta hisoblanadi.")}`}
          {metric === "trend" && t("Oxirgi 24 soatdagi tezlashgan qiziqish. Kamida 3 malakali o'quvchi bo'lgan asarlar.")}
          {metric === "thanks" && t("Bepul «Muallifga rahmat» soni bo'yicha.")}
          {data?.formula_version ? ` (${data.formula_version})` : ""}
        </p>
      </div>
      {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon="🏆" title={t("Bu davrda hali reyting yo'q")} /> : (
        <div className="mt8">
          {(data.items as Card[]).map((c) => (
            <Link key={c.id} to={`/w/${c.code}`} className="lrow">
              <b style={{ width: 28, fontSize: 20, color: c.rank! <= 3 ? "var(--premium)" : "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{c.rank}</b>
              <Cover card={c} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div className="small muted">{c.author?.pen_name} · {c.genre?.name}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
