import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../lib/api";
import { untilDate, useT } from "../lib/i18n";
import { shareLink } from "../lib/tg";
import { useToast } from "./ui";

/** Premium page: redeem a promo code (N days of Premium). */
export function PromoRedeem() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const redeem = async () => {
    setBusy(true);
    try {
      const r = await post("/promo/redeem", { code });
      toast(`🎉 +${r.days} ${t("kun Premium")} · ${untilDate(r.premium_until)}`);
      setCode("");
      qc.invalidateQueries();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="panel stack" style={{ gap: 8 }}>
      <b className="small">🎟 {t("Promo-kod")}</b>
      <div className="row">
        <input className="input grow" value={code} maxLength={32} autoCapitalize="characters" placeholder="KUZ-2026" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button className="btn" disabled={code.trim().length < 4 || busy} onClick={redeem}>{t("Faollashtirish")}</button>
      </div>
    </div>
  );
}

/** Profile: invite friends; the inviter gets Premium days after the friend's first real read. */
export function InviteFriends() {
  const t = useT();
  const toast = useToast();
  const q = useQuery({ queryKey: ["referrals"], queryFn: () => get("/me/referrals") });
  const d = q.data;
  if (!d?.enabled) return null;
  return (
    <div className="panel stack" style={{ gap: 8 }}>
      <b>🤝 {t("Do'stlarni taklif qiling")}</b>
      <span className="small muted">{t("Do'stingiz havola orqali kirib, birinchi hikoyani o'qisa, sizga {n} kun Premium qo'shiladi.").replace("{n}", String(d.bonus_days))}</span>
      <div className="row">
        <button className="btn primary grow" onClick={() => shareLink(d.link, t("HIKOYA PRO'da zo'r hikoyalar bor, o'qib ko'r!"))}>{t("Havolani ulashish")}</button>
        <button className="btn ghost" aria-label={t("Nusxalash")} onClick={() => navigator.clipboard?.writeText(d.link).then(() => toast(t("Nusxalandi")))}>⧉</button>
      </div>
      <span className="tiny dim">{t("Taklif qilinganlar")}: {d.invited} · {t("o'qishni boshlaganlar")}: {d.rewarded} · +{d.days_earned} {t("kun")}</span>
    </div>
  );
}
