import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Spinner, TopBar } from "../components/ui";
import { get } from "../lib/api";
import { useT } from "../lib/i18n";

/** E-04 entry: all genres with counts. */
export default function Genres() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });
  const { data: moods } = useQuery({ queryKey: ["tags", "mood"], queryFn: () => get<any[]>("/tags", { kind: "mood" }) });
  return (
    <div className="page">
      <TopBar title={t("Barcha janrlar")} />
      {!data ? (
        <Spinner />
      ) : (
        <div className="pad" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
          {data.map((g) => (
            <Link key={g.id} to={`/catalog?genre=${g.slug}`} className="panel row" style={{ minHeight: 64 }}>
              <span style={{ fontSize: 24 }} aria-hidden>{g.emoji}</span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{g.name}</div>
                <div className="tiny dim">{g.count} {t("asar")}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="section">
        <div className="section-h"><h2>{t("Kayfiyat bo'yicha")}</h2></div>
        <div className="chips">
          {moods?.map((m) => (
            <Link key={m.id} to={`/catalog?tag=${m.slug}`} className="chip">{m.name}</Link>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="section-h"><h2>{t("Menda vaqt bor")}</h2></div>
        <div className="chips">
          {[[5, "5 daqiqa"], [7, "7 daqiqa"], [15, "15 daqiqa"], [30, "30 daqiqa"]].map(([m, l]) => (
            <Link key={m} className="chip" to={`/catalog?max_minutes=${m}&status=completed&sort=short`}>⏱ {t(String(l))}</Link>
          ))}
        </div>
        <p className="pad tiny dim mt8">{t("Tanlangan vaqtga sig'adigan tugallangan hikoyalar (butun asar bo'yicha).")}</p>
      </div>
    </div>
  );
}
