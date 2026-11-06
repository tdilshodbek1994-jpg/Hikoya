import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { BottomNav, Sheet, Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { useT } from "./lib/i18n";
import { flush, onProgressConflict, queueProgress, type ConflictInfo } from "./lib/offline";
import { routeForParam } from "./lib/routes";
import { inTelegram } from "./lib/tg";
import Authors from "./pages/Authors";
import AuthorPage from "./pages/AuthorPage";
import Catalog from "./pages/Catalog";
import Comments from "./pages/Comments";
import Genres from "./pages/Genres";
import Home from "./pages/Home";
import Library, { CollectionPage } from "./pages/Library";
import Notifications from "./pages/Notifications";
import Onboarding from "./pages/Onboarding";
import Premium from "./pages/Premium";
import Profile from "./pages/Profile";
import Reader from "./pages/Reader";
import Search from "./pages/Search";
import StoryViewer from "./pages/StoryViewer";
import Support from "./pages/Support";
import Top from "./pages/Top";
import WorkPage from "./pages/WorkPage";

// Studio and admin are loaded only for authorised users (and never block the reader bundle).
const Studio = lazy(() => import("./pages/studio/Studio"));
const Admin = lazy(() => import("./pages/admin/Admin"));

const NAV_ROUTES = ["/", "/search", "/library", "/authors", "/profile", "/genres", "/catalog", "/top", "/notifications"];

function DevLogin() {
  const { devLogin, error } = useAuth();
  const [id, setId] = useState("1000");
  return (
    <div className="page no-nav pad stack" style={{ paddingTop: 60 }}>
      <h1>HIKOYA PRO</h1>
      <p className="muted">Bu sahifa faqat brauzerdagi lokal ishlab chiqish uchun. Telegram ichida kirish avtomatik bo'ladi.</p>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      <div className="field">
        <label htmlFor="dev-id">Telegram ID (dev)</label>
        <input id="dev-id" className="input" value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" />
      </div>
      <button className="btn primary big" onClick={() => devLogin(Number(id))}>
        Kirish
      </button>
    </div>
  );
}

function ConflictDialog() {
  const t = useT();
  const nav = useNavigate();
  const [c, setC] = useState<ConflictInfo | null>(null);
  useEffect(() => onProgressConflict(setC), []);
  if (!c) return null;
  return (
    <Sheet open onClose={() => setC(null)} label={t("Boshqa qurilma")}>
      <h2>{t("Boshqa qurilmada uzoqroq o'qigansiz")}</h2>
      <p className="muted">
        {t("Boshqa qurilmada")} «{c.other.chapter_title}» ({Math.round(c.other.ratio * 100)}%) {t("gacha yetgansiz. Qaysi joydan davom etamiz?")}
      </p>
      <div className="stack mt16">
        <button className="btn primary block" onClick={() => { setC(null); nav(`/read/${c.other.chapter_id}`); }}>
          {t("O'sha joyga o'tish")}
        </button>
        <button className="btn block" onClick={() => { queueProgress({ ...c.mine, force: true }); flush(); setC(null); }}>
          {t("Shu qurilmadagi joyni saqlash")}
        </button>
      </div>
    </Sheet>
  );
}

export default function App() {
  const { me, loading, error, startParam } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const routed = useRef(false);

  useEffect(() => {
    if (me && !routed.current) {
      routed.current = true;
      const target = routeForParam(startParam);
      if (target && loc.pathname === "/") nav(target, { replace: true });
    }
  }, [me, startParam, nav, loc.pathname]);

  useEffect(() => {
    if (me) flush();
  }, [me]);

  if (loading) return <Spinner />;
  if (!me) {
    if (!inTelegram) return <DevLogin />;
    return (
      <div className="page no-nav pad" style={{ paddingTop: 80 }}>
        <h2>Kirib bo'lmadi</h2>
        <p className="muted">{error || "Ilovani bot orqali qayta oching."}</p>
      </div>
    );
  }
  if (!me.onboarding_done && loc.pathname === "/" && !startParam) return <Onboarding />;
  const showNav = NAV_ROUTES.includes(loc.pathname);

  return (
    <>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/genres" element={<Genres />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/search" element={<Search />} />
          <Route path="/top" element={<Top />} />
          <Route path="/w/:code" element={<WorkPage />} />
          <Route path="/w/:code/comments" element={<Comments />} />
          <Route path="/read/:chapterId" element={<Reader />} />
          <Route path="/a/:id" element={<AuthorPage />} />
          <Route path="/authors" element={<Authors />} />
          <Route path="/s/:storyId" element={<StoryViewer />} />
          <Route path="/stories/:authorIndex" element={<StoryViewer />} />
          <Route path="/h/:highlightId" element={<StoryViewer />} />
          <Route path="/library" element={<Library />} />
          <Route path="/collection/:id" element={<CollectionPage />} />
          <Route path="/premium" element={<Premium />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/support" element={<Support />} />
          <Route path="/studio/*" element={<Studio />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {showNav && <BottomNav />}
      <ConflictDialog />
    </>
  );
}
