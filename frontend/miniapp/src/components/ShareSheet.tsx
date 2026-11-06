import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../lib/api";
import { useT } from "../lib/i18n";
import { canShareMessage, canShareToStory, haptic, shareLink, shareMessage, shareToStory } from "../lib/tg";
import { Sheet, useToast } from "./ui";

export type ShareTarget = { type: "work" | "chapter" | "author" | "app"; id: number; title: string; cover?: string | null };

type Prepared = { share_id: number; link: string; text: string; image_url: string | null; prepared_message_id: string | null; bot_username: string };

/** One sharing sheet for the whole app: card message, story card, link, other apps, inline hint. */
export function ShareSheet({ open, onClose, target }: { open: boolean; onClose: () => void; target: ShareTarget }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [bot, setBot] = useState("");
  const stats = useQuery({ queryKey: ["my-shares"], enabled: open, queryFn: () => get<{ shares: number; opens: number; new_users: number; bot_username: string }>("/me/shares") });
  const prep = (channel: string) => post<Prepared>("/share/prepare", { target_type: target.type, target_id: target.id, channel }).then((p) => { setBot(p.bot_username); return p; });
  const run = async (channel: string, fn: (p: Prepared) => Promise<void> | void) => {
    setBusy(channel);
    haptic.tap();
    try {
      await fn(await prep(channel));
    } catch (e: any) { toast(e.message, true); } finally { setBusy(null); }
  };
  const toChat = () => run("message", async (p) => {
    if (p.prepared_message_id && canShareMessage()) {
      const sent = await shareMessage(p.prepared_message_id);
      if (sent) { haptic.ok(); toast(t("Yuborildi")); onClose(); }
      return;
    }
    shareLink(p.link, p.text);
  });
  const toStory = () => run("story", (p) => { shareToStory(p.image_url || "", p.text, p.link); onClose(); });
  const copy = () => run("link", async (p) => { await navigator.clipboard?.writeText(p.link); toast(t("Havola nusxalandi")); });
  const native = () => run("native", async (p) => { await navigator.share?.({ url: p.link, text: p.text }).catch(() => {}); });
  const s = stats.data;
  return (
    <Sheet open={open} onClose={onClose} label={t("Ulashish")}>
      <div className="share-head">
        {target.cover ? <img src={target.cover} alt="" /> : <div className="ph">📖</div>}
        <div className="grow"><b>{target.title}</b><div className="tiny dim">{t("Do'stingiz bir bosishda shu sahifani ochadi")}</div></div>
      </div>
      <div className="share-grid mt16">
        <button className="share-opt" disabled={!!busy} onClick={toChat}><span>💬</span>{busy === "message" ? "…" : t("Chatga yuborish")}</button>
        {canShareToStory() && target.type === "work" && <button className="share-opt" disabled={!!busy} onClick={toStory}><span>📸</span>{busy === "story" ? "…" : t("Storisga")}</button>}
        <button className="share-opt" disabled={!!busy} onClick={copy}><span>🔗</span>{t("Havolani nusxalash")}</button>
        {typeof navigator !== "undefined" && "share" in navigator && <button className="share-opt" disabled={!!busy} onClick={native}><span>📱</span>{t("Boshqa ilovalar")}</button>}
      </div>
      {target.type === "work" && (
        <p className="tiny dim mt16">💡 {t("Istalgan chatda {bot} deb yozib, hikoya nomini kiriting — kartasi bilan yuboriladi.").replace("{bot}", `@${bot || stats.data?.bot_username || "…"}`)}</p>
      )}
      {s && s.shares > 0 && <p className="tiny dim">{t("Ulashishlaringiz orqali ochildi")}: <b>{s.opens}</b> · {t("yangi o'quvchilar")}: <b>{s.new_users}</b></p>}
    </Sheet>
  );
}
