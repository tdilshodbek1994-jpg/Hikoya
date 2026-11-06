import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Empty, Grid, Spinner } from "../components/ui";
import { ISearch } from "../components/icons";
import { del, get, type Card } from "../lib/api";
import { useT } from "../lib/i18n";

/** E-05: debounced search; Latin/Cyrillic/apostrophe normalisation happens on the server. */
export default function Search() {
  const t = useT();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [text, setText] = useState(sp.get("q") || "");
  const [q, setQ] = useState(sp.get("q") || "");
  const inText = sp.get("in_text") === "1";
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(text.trim());
      const n = new URLSearchParams(sp);
      if (text.trim()) n.set("q", text.trim());
      else n.delete("q");
      setSp(n, { replace: true });
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const res = useQuery({ queryKey: ["search", q, inText], enabled: q.length >= 2, queryFn: () => get<{ items: Card[]; fuzzy: boolean }>("/search", { q, in_text: inText || undefined }) });
  const recent = useQuery({ queryKey: ["recent-search"], queryFn: () => get<{ id: number; query: string }[]>("/search/recent") });
  const clear = async (id?: number) => {
    await del("/search/recent", id ? { id } : undefined);
    qc.invalidateQueries({ queryKey: ["recent-search"] });
  };
  return (
    <div className="page">
      <div className="header" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <label className="search grow" style={{ margin: "0 16px" }}>
          <ISearch />
          <span className="sr">{t("Qidiruv")}</span>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Asar, muallif yoki janr")} enterKeyHint="search" />
          {text && <button aria-label={t("Tozalash")} onClick={() => setText("")}>✕</button>}
        </label>
      </div>
      <div className="chips">
        <button className={`chip ${inText ? "on" : ""}`} onClick={() => { const n = new URLSearchParams(sp); inText ? n.delete("in_text") : n.set("in_text", "1"); setSp(n, { replace: true }); }}>
          {t("Matn ichida ham")}
        </button>
        <Link className="chip" to="/genres">{t("Janrlar")}</Link>
        <Link className="chip" to="/top">TOP</Link>
      </div>
      {q.length < 2 ? (
        <div className="pad mt16">
          {!!recent.data?.length && (
            <>
              <div className="row between">
                <h3>{t("So'nggi qidiruvlar")}</h3>
                <button className="link small" onClick={() => clear()}>{t("Tozalash")}</button>
              </div>
              <div className="list mt8">
                {recent.data.map((r) => (
                  <div key={r.id} className="li">
                    <button className="grow" style={{ textAlign: "left", minHeight: 32 }} onClick={() => setText(r.query)}>{r.query}</button>
                    <button aria-label={t("O'chirish")} className="dim" onClick={() => clear(r.id)}>✕</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : res.isLoading ? (
        <Spinner />
      ) : res.data?.items.length ? (
        <div className="mt16">
          {res.data.fuzzy && <p className="pad small muted">{t("Aniq moslik topilmadi. O'xshash natijalar:")}</p>}
          <Grid items={res.data.items} />
          {res.data.items.some((i) => i.snippet) && (
            <div className="pad mt16 stack">
              {res.data.items.filter((i) => i.snippet).map((i) => (
                <Link key={i.id} to={`/w/${i.code}`} className="panel small"><b>{i.title}</b><div className="muted mt8">{i.snippet}</div></Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Empty icon="🔍" title={t("Hech narsa topilmadi")}>{t("Boshqa so'z bilan yoki lotin/kirillda yozib ko'ring.")}</Empty>
      )}
    </div>
  );
}
