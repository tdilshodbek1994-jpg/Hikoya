import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IStar } from "../components/icons";
import { Sheet, Spinner, TopBar, useToast } from "../components/ui";
import { ApiError, api, get, post, uuid } from "../lib/api";
import { fmtDate, useT } from "../lib/i18n";
import { confirmDialog, haptic, openInvoice } from "../lib/tg";

type Product = { id: number; sku: string; title: string; description: string; pricing_type: string; access_scope: string; amount: number; duration_days: number | null; is_demo: boolean; purchasable: boolean; covers: string };

/** E-16 (offer) + E-17 (purchase / subscription status). Access is granted only after the server confirms. */
export default function Premium() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const workId = sp.get("work");
  const [busy, setBusy] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [gift, setGift] = useState<Product | null>(null);
  const [giftTo, setGiftTo] = useState("");
  const products = useQuery({ queryKey: ["products"], queryFn: () => get<Product[]>("/billing/products") });
  const workProducts = useQuery({ queryKey: ["products", workId], enabled: !!workId, queryFn: () => get<Product[]>("/billing/products", { work_id: workId }) });
  const subs = useQuery({ queryKey: ["subs"], queryFn: () => get("/billing/subscriptions") });

  const buy = async (p: Product, giftTelegramId?: number) => {
    setBusy(p.id);
    setStatus(null);
    const idemKey = `hk_idem_${p.id}${giftTelegramId ? `_g${giftTelegramId}` : ""}`;
    const key = sessionStorage.getItem(idemKey) || uuid();
    sessionStorage.setItem(idemKey, key);
    try {
      const order = await api("/billing/orders", { method: "POST", body: { product_id: p.id, gift_to_telegram_id: giftTelegramId ?? null }, idem: key });
      const res = await openInvoice(order.invoice_link);
      if (res === "cancelled") { setStatus(t("To'lov bekor qilindi")); return; }
      if (res === "failed") { setStatus(t("To'lov amalga oshmadi")); haptic.err(); return; }
      // "paid" from the client is not trusted: wait for the server confirmation
      setStatus(t("Tasdiqlanmoqda..."));
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const o = await get(`/billing/orders/${order.id}`);
        if (o.status === "paid") {
          setStatus(giftTelegramId ? t("Sovg'a yuborildi! Do'stingizga xabar boradi.") : t("Premium faol"));
          haptic.ok();
          sessionStorage.removeItem(idemKey);
          qc.invalidateQueries();
          return;
        }
        if (o.status === "expired" || o.status === "failed") { setStatus(o.status_text); return; }
      }
      setStatus(t("To'lov hali tasdiqlanmadi. Bir necha daqiqadan keyin bu sahifani yangilang yoki /paysupport ga yozing."));
    } catch (e) {
      if (e instanceof ApiError && e.code === "already_subscribed") setStatus(t("Sizda faol obuna bor"));
      else if (e instanceof ApiError && e.code === "already_purchased" && giftTelegramId) setStatus(t("Bu do'stingizda allaqachon ochiq"));
      else toast(e instanceof Error ? e.message : t("Xatolik"), true);
    } finally {
      setBusy(null);
    }
  };

  const renewal = async (sub: any, cancel: boolean) => {
    if (cancel && !(await confirmDialog(t("Avtomatik yangilanish o'chirilsinmi? To'langan muddat oxirigacha Premium ishlaydi.")))) return;
    try {
      await post(`/billing/subscriptions/${sub.id}/${cancel ? "cancel" : "resume"}-renewal`);
      subs.refetch();
    } catch (e: any) { toast(e.message, true); }
  };

  const premium = subs.data?.premium;
  const activeSubs = (subs.data?.subscriptions || []).filter((s: any) => s.active);
  return (
    <div className="page no-nav">
      <TopBar title="HIKOYA PRO Premium" />
      <div className="pad stack">
        <div className="panel" style={{ background: "linear-gradient(150deg, rgba(214,182,106,.22), var(--surface) 70%)", borderColor: "rgba(214,182,106,.5)" }}>
          <div className="row"><span style={{ color: "var(--premium)" }}><IStar /></span><h2>{premium ? t("Premium faol") : t("Premium hikoyalarni oching")}</h2></div>
          {premium ? (
            <p className="small muted mt8">{subs.data?.premium_until ? `${t("Amal qiladi")}: ${fmtDate(subs.data.premium_until)} ${t("gacha")}` : t("Muddatsiz")}</p>
          ) : (
            <ul className="small muted" style={{ paddingLeft: 18, marginBottom: 0 }}>
              <li>{t("Premium katalogdagi barcha asarlar va yangi boblar")}</li>
              <li>{t("Sotib olishdan oldin bepul namuna")}</li>
              <li>{t("Kutubxona, xatcho'p va progress muddat tugasa ham saqlanadi")}</li>
            </ul>
          )}
          <p className="tiny dim mt8">{t("Bu ilovamizning obunasi. Telegram Premium belgisi bilan bog'liq emas.")}</p>
        </div>

        {status && <div className="panel center" role="status">{status}</div>}

        {activeSubs.map((s: any) => (
          <div key={s.id} className="panel stack" style={{ gap: 8 }}>
            <b>{s.status_text}</b>
            {s.next_charge_at && <span className="small muted">{t("Keyingi yechish")}: {fmtDate(s.next_charge_at)}</span>}
            {s.renewal_state === "active" ? (
              <button className="btn ghost" onClick={() => renewal(s, true)}>{t("Avtomatik yangilanishni o'chirish")}</button>
            ) : (
              <button className="btn" onClick={() => renewal(s, false)}>{t("Yangilanishni qayta yoqish")}</button>
            )}
          </div>
        ))}

        {workProducts.data?.map((p) => <ProductCard key={p.id} p={p} busy={busy === p.id} onBuy={() => buy(p)} onGift={() => setGift(p)} note={t("Premium katalogdan tashqari, alohida xarid")} />)}
        {products.isLoading ? <Spinner /> : products.data?.filter((p) => !(premium && p.pricing_type === "subscription" && activeSubs.length)).map((p) => <ProductCard key={p.id} p={p} busy={busy === p.id} onBuy={() => buy(p)} onGift={p.pricing_type === "one_time" ? () => setGift(p) : undefined} />)}

        <Sheet open={!!gift} onClose={() => setGift(null)} label={t("Sovg'a qilish")}>
          <h2>🎁 {t("Sovg'a qilish")}</h2>
          <p className="small muted">{gift?.title} · {gift?.amount} ⭐</p>
          <div className="field mt8">
            <label>{t("Do'stingizning Telegram ID raqami")}</label>
            <input className="input" inputMode="numeric" value={giftTo} onChange={(e) => setGiftTo(e.target.value.replace(/\D/g, ""))} placeholder="123456789" />
            <span className="tiny dim">{t("Do'stingiz ilovani kamida bir marta ochgan bo'lishi kerak. ID'ni u Profil sahifasidan ko'chirib beradi.")}</span>
          </div>
          <button className="btn premium block mt16" disabled={!giftTo || busy !== null} onClick={() => { const p = gift!; setGift(null); buy(p, Number(giftTo)); }}>{t("To'lash va sovg'a qilish")}</button>
        </Sheet>

        {!!subs.data?.orders?.length && (
          <div className="mt16">
            <h3>{t("Xaridlar tarixi")}</h3>
            <div className="list mt8">
              {subs.data.orders.map((o: any) => (
                <div key={o.id} className="li"><div className="grow"><div className="small">{o.terms.title}</div><div className="tiny dim">{o.terms.amount} ⭐ · {fmtDate(o.paid_at || o.expires_at)}</div></div><span className="pill">{o.status_text}</span></div>
              ))}
            </div>
          </div>
        )}
        <p className="tiny dim">{t("Narxlar Telegram Stars'da. Stars→so'm kursi va'da qilinmaydi.")} <Link to="/support?category=payment" className="link tiny">{t("To'lov bo'yicha yordam")}</Link></p>
      </div>
    </div>
  );
}

function ProductCard({ p, busy, onBuy, onGift, note }: { p: Product; busy: boolean; onBuy: () => void; onGift?: () => void; note?: string }) {
  const t = useT();
  return (
    <div className="panel stack" style={{ gap: 6 }}>
      <div className="row between"><b>{p.title}</b><span style={{ color: "var(--premium)", fontWeight: 800, whiteSpace: "nowrap" }}>{p.amount} ⭐</span></div>
      <span className="small muted">{p.description}</span>
      <span className="tiny dim">{p.covers}{note ? ` · ${note}` : ""}</span>
      {p.pricing_type === "subscription" && <span className="tiny dim">{t("Har 30 kunda avtomatik yangilanadi, istalgan vaqtda o'chirish mumkin.")}</span>}
      {p.pricing_type === "one_time" && p.access_scope === "premium" && <span className="tiny dim">{t("Bir martalik paket, avtomatik yangilanmaydi.")}</span>}
      {p.purchasable ? (
        <>
          <button className="btn premium block mt8" disabled={busy} onClick={onBuy}>{busy ? t("Kuting...") : t("Sotib olish")}</button>
          {onGift && <button className="btn ghost block" disabled={busy} onClick={onGift}>🎁 {t("Do'stga sovg'a qilish")}</button>}
        </>
      ) : (
        <span className="pill warn mt8" style={{ alignSelf: "flex-start" }}>{p.is_demo ? t("Demo narx — to'lov hali yoqilmagan") : t("Hozircha mavjud emas")}</span>
      )}
    </div>
  );
}
