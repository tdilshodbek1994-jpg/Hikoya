import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import type { Access, Card } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ACCESS_LABEL, useT } from "../lib/i18n";
import { backButton, haptic } from "../lib/tg";
import { IBack, IBell, IHome, ILib, ILock, IPen, ISearch, IUser } from "./icons";

/* ---------- generated covers (own design system; no third-party branding) ---------- */

const PALETTES: Record<string, [string, string]> = {
  hayotiy: ["#2f6b4f", "#0f2219"], sevgi: ["#8f2f5c", "#2a0f22"], oilaviy: ["#a0612c", "#2b1709"], ibratli: ["#3b5c9f", "#0f1a33"],
  "ruhiy-psixologik": ["#5b3f8f", "#170f2b"], drama: ["#7a2f2f", "#220c0c"], detektiv: ["#2a3a52", "#06090f"], triller: ["#3d1f4f", "#0b0512"],
  sarguzasht: ["#1f6b6b", "#071f1f"], tarixiy: ["#8a6a2f", "#241a08"], fantastika: ["#2f4f8f", "#05102b"], fentezi: ["#4f2f8f", "#120a2b"],
  mistika: ["#3f2f5c", "#0a0614"], hajviy: ["#c48a1f", "#3b2405"], bolalar: ["#2f8f7a", "#0a2b24"],
};

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Cover({ card, className = "", style }: { card: Pick<Card, "title" | "cover_url" | "genre" | "author" | "access" | "progress" | "is_demo"> & { id?: number }; className?: string; style?: React.CSSProperties }) {
  const t = useT();
  const [c1, c2] = PALETTES[card.genre?.slug || ""] || (["#3a3f5c", "#10121a"] as [string, string]);
  const angle = 120 + (hash(card.title) % 90);
  return (
    <div className={`cover ${className}`} style={style}>
      {card.cover_url ? (
        <img src={card.cover_url} alt="" loading="lazy" decoding="async" />
      ) : (
        <div className="gen-cover" style={{ background: `linear-gradient(${angle}deg, ${c1}, ${c2})` }}>
          <span className="gt">{card.title}</span>
          <span className="ga">{card.author?.pen_name || ""}</span>
        </div>
      )}
      <AccessBadge access={card.access} />
      {card.progress && !card.progress.completed && card.progress.ratio > 0 && (
        <span className="progress-bar" aria-label={t("O'qilgan")}>
          <i style={{ width: `${Math.round(card.progress.ratio * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

export function AccessBadge({ access }: { access: Access }) {
  const t = useT();
  if (access === "FREE") return null;
  const cls = access === "PREMIUM" ? "premium" : access === "PURCHASE" ? "purchase" : "open";
  return (
    <span className={`badge ${cls}`}>
      {(access === "PREMIUM" || access === "PURCHASE") && <ILock />}
      {t(ACCESS_LABEL[access])}
    </span>
  );
}

export function WorkCard({ card, wide }: { card: Card; wide?: boolean }) {
  const t = useT();
  const sub = (card.is_demo ? `${t("Demo")} · ` : "") + (card.new_chapters ? `${card.new_chapters} ${t("ta yangi bob")}` : card.author?.pen_name || "");
  return (
    <Link to={`/w/${card.code}`} className="card" style={wide ? { width: 140 } : undefined} onClick={() => haptic.tap()}>
      <Cover card={card} />
      <div className="t">{card.title}</div>
      <div className="a">{sub}{card.minutes && !card.new_chapters ? ` · ${card.chapters > 1 ? `${card.chapters} ${t("bob")}` : `${card.minutes} ${t("daq")}`}` : ""}</div>
    </Link>
  );
}

export function TopCard({ card }: { card: Card }) {
  return (
    <Link to={`/w/${card.code}`} className="top-card">
      <span className="num" aria-hidden>{card.rank}</span>
      <Cover card={card} />
      <div className="t" style={{ marginTop: 7, fontSize: 13.5, fontWeight: 600, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        <span className="sr">{card.rank}. </span>
        {card.title}
      </div>
    </Link>
  );
}

export function Section({ title, more, children }: { title: string; more?: string | null; children: ReactNode }) {
  const t = useT();
  return (
    <section className="section">
      <div className="section-h">
        <h2>{title}</h2>
        {more && (
          <Link to={more} className="link small">
            {t("Barchasini ko'rish")}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function Rail({ items, top }: { items: Card[]; top?: boolean }) {
  return <div className="rail">{items.map((c) => (top ? <TopCard key={c.id} card={c} /> : <WorkCard key={c.id} card={c} />))}</div>;
}

export function Grid({ items }: { items: Card[] }) {
  return (
    <div className="grid">
      {items.map((c) => (
        <WorkCard key={c.id} card={c} />
      ))}
    </div>
  );
}

export function Spinner() {
  return <div className="spin" role="status" aria-label="Yuklanmoqda" />;
}

export function Empty({ icon = "📚", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="e-i" aria-hidden>{icon}</div>
      <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {children && <div className="mt8">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useT();
  const msg = error instanceof Error ? error.message : t("Xatolik yuz berdi");
  return (
    <Empty icon="⚠️" title={msg}>
      {retry && (
        <button className="btn mt8" onClick={retry}>
          {t("Qayta urinish")}
        </button>
      )}
    </Empty>
  );
}

/* ---------- navigation ---------- */

export function BottomNav() {
  const t = useT();
  const items = [
    { to: "/", label: "Asosiy", icon: <IHome />, end: true },
    { to: "/search", label: "Qidiruv", icon: <ISearch /> },
    { to: "/library", label: "Kutubxonam", icon: <ILib /> },
    { to: "/authors", label: "Mualliflar", icon: <IPen /> },
    { to: "/profile", label: "Profil", icon: <IUser /> },
  ];
  return (
    <nav className="nav" aria-label={t("Asosiy navigatsiya")}>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? "active" : "")} onClick={() => haptic.pick()}>
          {i.icon}
          <span>{t(i.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** Telegram BackButton on nested screens, in-app back arrow otherwise. */
export function useBack(enabled = true, onBack?: () => void) {
  const nav = useNavigate();
  const loc = useLocation();
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!enabled) return backButton(false);
    const handler = () => (cb.current ? cb.current() : history.length > 1 ? nav(-1) : nav("/"));
    return backButton(true, handler);
  }, [enabled, nav, loc.pathname]);
}

export function TopBar({ title, right, back = true, onBack }: { title?: ReactNode; right?: ReactNode; back?: boolean; onBack?: () => void }) {
  const nav = useNavigate();
  useBack(back, onBack);
  const t = useT();
  return (
    <div className="header">
      {back && (
        <button className="icon-btn" aria-label={t("Orqaga")} onClick={() => (onBack ? onBack() : history.length > 1 ? nav(-1) : nav("/"))}>
          <IBack />
        </button>
      )}
      <div className="grow" style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      {right}
    </div>
  );
}

export function HomeHeader() {
  const { me } = useAuth();
  const t = useT();
  return (
    <div className="header">
      <div className="logo grow">
        HIKOYA <b>PRO</b>
      </div>
      <Link to="/search" className="icon-btn" aria-label={t("Qidiruv")}>
        <ISearch />
      </Link>
      <Link to="/notifications" className="icon-btn" aria-label={t("Bildirishnomalar")}>
        <IBell />
        {!!me?.unread_notifications && <span className="dot">{me.unread_notifications > 9 ? "9+" : me.unread_notifications}</span>}
      </Link>
    </div>
  );
}

/* ---------- sheet & toast ---------- */

export function Sheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  useBack(open, onClose);
  if (!open) return null;
  return (
    <div className="sheet-bg" onClick={onClose} role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        {children}
      </div>
    </div>
  );
}

type ToastT = { text: string; err?: boolean } | null;
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastT>(null);
  const timer = useRef<number>(0);
  const show = useCallback((text: string, err?: boolean) => {
    setToast({ text, err });
    if (err) haptic.err();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.err ? "err" : ""}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className="toggle" role="switch" aria-checked={on} onClick={() => onChange(!on)} style={{ width: "100%" }}>
      <span style={{ textAlign: "left" }}>{label}</span>
      <span className={`switch ${on ? "on" : ""}`} />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
