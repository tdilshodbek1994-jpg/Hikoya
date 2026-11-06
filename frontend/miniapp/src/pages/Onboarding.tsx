import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Seg, Spinner } from "../components/ui";
import { get, patch, type Me } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { haptic } from "../lib/tg";

/** E-01/E-02: optional script and up to 3 favourite genres. «Hozircha o'tkazish» opens the catalogue. */
export default function Onboarding() {
  const { me, setMe } = useAuth();
  const t = useT();
  const nav = useNavigate();
  const [script, setScript] = useState<"latn" | "cyrl">(me?.script || "latn");
  const [picked, setPicked] = useState<number[]>(me?.favorite_genre_ids || []);
  const [busy, setBusy] = useState(false);
  const { data: genres } = useQuery({ queryKey: ["genres"], queryFn: () => get<any[]>("/genres") });

  const finish = async (save: boolean) => {
    setBusy(true);
    try {
      const m = await patch<Me>("/me/preferences", save ? { script, favorite_genre_ids: picked, onboarding_done: true } : { onboarding_done: true });
      setMe(m);
      nav("/", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => {
    haptic.pick();
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 3 ? [...p, id] : p));
  };

  return (
    <div className="page no-nav">
      <div className="pad stack" style={{ paddingTop: 24 }}>
        <div className="logo" style={{ fontSize: 22 }}>
          HIKOYA <b>PRO</b>
        </div>
        <h1>{t("Xush kelibsiz!")}</h1>
        <p className="muted">{t("Telefon raqami yoki parol kerak emas. Xohlasangiz, yozuv va sevimli janrlaringizni tanlang — tavsiyalar aniqroq bo'ladi.")}</p>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>{t("Yozuv")}</div>
          <Seg value={script} onChange={setScript} options={[["latn", "Lotin"], ["cyrl", "Кирилл"]]} />
        </div>
        <div className="small muted">{t("3 tagacha janr")} ({picked.length}/3)</div>
      </div>
      {!genres ? (
        <Spinner />
      ) : (
        <div className="pad row wrap mt8" style={{ gap: 8 }}>
          {genres.map((g) => (
            <button key={g.id} className={`chip ${picked.includes(g.id) ? "on" : ""}`} aria-pressed={picked.includes(g.id)} onClick={() => toggle(g.id)}>
              <span aria-hidden>{g.emoji}</span> {g.name}
            </button>
          ))}
        </div>
      )}
      <div className="pad stack mt24">
        <button className="btn primary big block" disabled={busy} onClick={() => finish(true)}>
          {t("Davom etish")}
        </button>
        <button className="btn ghost block" disabled={busy} onClick={() => finish(false)}>
          {t("Hozircha o'tkazish")}
        </button>
      </div>
    </div>
  );
}
