import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Empty, Spinner } from "../components/ui";
import { ISearch } from "../components/icons";
import { get } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { StoriesRow } from "./Home";

export default function Authors() {
  const t = useT();
  const { me } = useAuth();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(id);
  }, [text]);
  const res = useInfiniteQuery({
    queryKey: ["authors", q],
    queryFn: ({ pageParam }) => get("/authors", { q, cursor: pageParam }),
    initialPageParam: "",
    getNextPageParam: (l: any) => l.next_cursor || undefined,
  });
  const items = res.data?.pages.flatMap((p: any) => p.items) || [];
  return (
    <div className="page">
      <div className="header"><h1 className="grow" style={{ fontSize: 22 }}>{t("Mualliflar")}</h1>
        {me?.author ? <Link to="/studio" className="btn" style={{ minHeight: 38 }}>{t("Ustaxona")}</Link> : <Link to="/support?apply=author" className="link small">{t("Muallif bo'lish")}</Link>}
      </div>
      <StoriesRow />
      <label className="search mt8"><ISearch /><span className="sr">{t("Muallif qidirish")}</span><input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Taxallus bo'yicha qidirish")} /></label>
      {res.isLoading ? <Spinner /> : !items.length ? <Empty icon="✍️" title={t("Muallif topilmadi")} /> : (
        <div className="mt16">
          {items.map((a: any) => (
            <Link key={a.id} to={`/a/${a.id}`} className="lrow">
              <div className="ring" style={{ width: 48, height: 48, padding: 2 }}><div className="av">{a.avatar_url ? <img src={a.avatar_url} alt="" /> : a.pen_name[0]}</div></div>
              <div className="grow"><div style={{ fontWeight: 600 }}>{a.pen_name}{a.verified ? " ✓" : ""}</div>{a.featured && <div className="tiny dim">{t("Tahririyat tavsiyasi")}</div>}</div>
            </Link>
          ))}
          {res.hasNextPage && <div className="pad"><button className="btn block" onClick={() => res.fetchNextPage()}>{t("Yana")}</button></div>}
        </div>
      )}
    </div>
  );
}
