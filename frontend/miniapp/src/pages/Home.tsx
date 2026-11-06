import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Cover, Empty, ErrorBox, HomeHeader, Rail, Section, Seg, Spinner } from "../components/ui";
import { get, post, type Card } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";

type Sec = { key: string; kind: string; title: string; items: Card[] | null; see_all?: Record<string, unknown> | null; empty?: boolean; empty_hint?: string; starter?: boolean; basis?: string; period_note?: string };

function seeAllUrl(f?: Record<string, unknown> | null) {
  if (!f) return null;
  const q = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => v !== undefined && v !== null && q.set(k, String(v)));
  return `/catalog?${q}`;
}

export function StoriesRow() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["storis-feed"], queryFn: () => get<any[]>("/storis/feed") });
  const { me } = useAuth();
  if (!data) return <div className="stories" style={{ height: 92 }} />;
  if (!data.length && !me?.author) return null;
  return (
    <div className="stories" aria-label={t("Mualliflar storisi")}>
      {me?.author && (
        <Link to="/studio/stories/new" className="story">
          <div className="ring">
            <div className="av" style={{ fontSize: 26 }}>+</div>
          </div>
          <div className="n">{t("Storis")}</div>
        </Link>
      )}
      {data.map((s, i) => (
        <Link key={s.author.id} to={`/stories/${i}`} className="story" aria-label={`${s.author.pen_name}${s.unseen ? ", " + t("ko'rilmagan") : ""}`}>
          <div className={`ring ${s.unseen ? "unseen" : ""}`}>
            <div className="av">{s.author.avatar_url ? <img src={s.author.avatar_url} alt="" /> : s.author.pen_name.slice(0, 1)}</div>
          </div>
          <div className="n">{s.author.pen_name}</div>
        </Link>
      ))}
    </div>
  );
}

const QUICK = [
  ["", "Barchasi"],
  ["access:premium", "Premium"],
  ["access:free", "Bepul"],
  ["genre:hayotiy", "Hayotiy"],
  ["genre:sevgi", "Sevgi"],
  ["genre:ibratli", "Ibratli"],
  ["genre:detektiv", "Detektiv"],
  ["genre:sarguzasht", "Sarguzasht"],
];

function GenreRow() {
  const t = useT();
  const nav = useNavigate();
  return (
    <div className="chips" role="toolbar" aria-label={t("Janrlar")}>
      {QUICK.map(([k, l]) => (
        <button key={k} className={`chip ${k === "" ? "on" : ""} ${k === "access:premium" ? "premium" : ""}`} onClick={() => {
          if (!k) return nav("/catalog");
          const [a, b] = k.split(":");
          nav(`/catalog?${a}=${b}`);
        }}>
          {t(l)}
        </button>
      ))}
      <Link className="chip" to="/genres">{t("Barcha janrlar")} →</Link>
    </div>
  );
}

function ContinueBlock({ sec }: { sec: Sec }) {
  const t = useT();
  const items = sec.items || [];
  if (!items.length) return null;
  if (sec.starter) {
    return (
      <Section title={t("Boshlash uchun")}>
        <p className="pad small muted" style={{ marginTop: -4 }}>{t(sec.empty_hint || "")}</p>
        <Rail items={items} />
      </Section>
    );
  }
  const [first, ...rest] = items;
  return (
    <Section title={t(sec.title)}>
      <Link to={`/read/${first.continue!.chapter_id}`} className="continue">
        <Cover card={first} />
        <div className="grow stack" style={{ gap: 6 }}>
          <div style={{ fontWeight: 700 }}>{first.title}</div>
          <div className="small muted">{first.continue!.chapter_title}</div>
          <div className="bar"><i style={{ width: `${Math.round((first.continue!.ratio || 0) * 100)}%` }} /></div>
          <span className="btn primary" style={{ alignSelf: "flex-start", minHeight: 38 }}>{t("Davom ettirish")}</span>
        </div>
      </Link>
      {rest.length > 0 && (
        <div className="stack mt8" style={{ gap: 4 }}>
          {rest.map((c) => (
            <Link key={c.id} to={`/read/${c.continue!.chapter_id}`} className="lrow">
              <Cover card={c} />
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div className="small muted">{c.continue!.chapter_title} · {Math.round((c.continue!.ratio || 0) * 100)}%</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

function EditorialBlock({ sec }: { sec: Sec }) {
  const t = useT();
  const items = sec.items || [];
  if (!items.length) return null;
  return (
    <Section title={t(sec.title)}>
      <div className="banners">
        {items.slice(0, 3).map((c) => (
          <Link key={c.id} to={`/w/${c.code}`} className="banner" style={{ marginRight: 0 }}>
            <Cover card={c} />
            <div className="grow stack" style={{ gap: 6 }}>
              {c.sponsored && <span className="pill warn">{t("Homiylik")}</span>}
              <div style={{ fontWeight: 700, fontSize: 17 }}>{c.title}</div>
              <div className="small muted">{c.is_demo ? `${t("Demo")} · ` : ""}{c.author?.pen_name}</div>
              {c.reason && <div className="small">💡 {c.reason}</div>}
            </div>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function TopBlock({ sec }: { sec: Sec }) {
  const t = useT();
  const [period, setPeriod] = useState("week");
  const { data } = useQuery({ queryKey: ["top", period], queryFn: () => get("/rankings", { period, limit: 10 }), initialData: period === "week" ? { items: sec.items || [], period_note: sec.period_note } : undefined });
  const items: Card[] = data?.items || [];
  return (
    <Section title={t(sec.title)} more={`/top?period=${period}`}>
      <div className="pad" style={{ marginBottom: 10 }}>
        <Seg value={period} onChange={setPeriod} options={[["today", t("Bugun")], ["week", t("Hafta")], ["month", t("Oy")], ["all", t("Barchasi")]]} />
        <div className="tiny dim mt8">{data?.period_note}. {t("Noyob malakali o'quvchilar soni bo'yicha.")}</div>
      </div>
      {items.length ? <Rail items={items} top /> : <p className="pad small muted">{t("Bu davrda hali yetarli o'qish yo'q.")}</p>}
    </Section>
  );
}

function ForYouBlock({ sec }: { sec: Sec }) {
  const t = useT();
  const [hidden, setHidden] = useState<number[]>([]);
  const items = (sec.items || []).filter((c) => !hidden.includes(c.id));
  if (!items.length) return null;
  return (
    <Section title={t(sec.title)}>
      {sec.basis !== "history" && <p className="pad tiny dim" style={{ marginTop: -6 }}>{t("Tarix yetarli emas — tahririyat tanlovi va turli janrlar.")}</p>}
      <div className="rail">
        {items.map((c) => (
          <div key={c.id} className="card">
            <Link to={`/w/${c.code}`}>
              <Cover card={c} />
              <div className="t">{c.title}</div>
            </Link>
            <div className="row" style={{ gap: 2 }}>
              <button className="tiny dim" style={{ minHeight: 32 }} onClick={() => { setHidden((h) => [...h, c.id]); post("/recommendations/dismiss", { target_type: "work", target_id: c.id }); }}>
                {t("Qiziq emas")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function LazySection({ sec, exclude }: { sec: Sec; exclude: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { data } = useQuery({ queryKey: ["home-sec", sec.key], enabled: visible, queryFn: () => get(`/home/sections/${sec.key}`, { exclude: exclude.join(",") }) });
  return <div ref={ref}>{data ? <SectionView sec={{ ...sec, ...data }} /> : <div style={{ height: 220 }} />}</div>;
}

function SectionView({ sec }: { sec: Sec }) {
  const t = useT();
  switch (sec.kind) {
    case "continue":
      return <ContinueBlock sec={sec} />;
    case "editorial":
      return <EditorialBlock sec={sec} />;
    case "top":
      return <TopBlock sec={sec} />;
    case "for_you":
      return <ForYouBlock sec={sec} />;
    default:
      if (!sec.items?.length) return null;
      return (
        <Section title={t(sec.title)} more={seeAllUrl(sec.see_all)}>
          <Rail items={sec.items} />
        </Section>
      );
  }
}

export default function Home() {
  const t = useT();
  const { data, error, refetch, isLoading } = useQuery({ queryKey: ["home"], queryFn: () => get<{ sections: Sec[]; genres: any[]; has_stories: boolean }>("/home") });
  if (isLoading) return (<div className="page"><HomeHeader /><Spinner /></div>);
  if (error) return (<div className="page"><HomeHeader /><ErrorBox error={error} retry={refetch} /></div>);
  const sections = data!.sections;
  const loadedIds: number[] = [];
  const anyContent = sections.some((s) => s.items && s.items.length);
  return (
    <div className="page">
      <HomeHeader />
      {sections.map((s) => {
        if (s.kind === "stories") return <StoriesRow key={s.key} />;
        if (s.kind === "genres") return <GenreRow key={s.key} />;
        if (s.items === null) {
          const ex = loadedIds.slice(-24);
          return <LazySection key={s.key} sec={s} exclude={ex} />;
        }
        s.items.forEach((c) => loadedIds.push(c.id));
        return <SectionView key={s.key} sec={s} />;
      })}
      {!anyContent && (
        <Empty icon="📖" title={t("Katalog hozircha bo'sh")}>
          {t("Tez orada hikoyalar qo'shiladi. Janrlarni ko'rib chiqing yoki keyinroq qayting.")}
          <div className="mt16"><Link className="btn" to="/genres">{t("Janrlar")}</Link></div>
        </Empty>
      )}
    </div>
  );
}
