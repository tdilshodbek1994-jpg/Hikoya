import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { TopBar, useToast } from "../components/ui";
import { get, post } from "../lib/api";
import { useT } from "../lib/i18n";

/** E-20: help, payment support and complaints. */
export default function Support() {
  const t = useT();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [category, setCategory] = useState(sp.get("category") || (sp.get("apply") ? "other" : "payment"));
  const [body, setBody] = useState(sp.get("apply") === "author" ? t("Muallif sifatida hikoya joylamoqchiman.") : "");
  const { data, refetch } = useQuery({ queryKey: ["tickets"], queryFn: () => get<any[]>("/support/tickets") });
  const send = async () => {
    try {
      await post("/support/tickets", { category, body, subject: sp.get("apply") ? "Muallif bo'lish arizasi" : "" });
      setBody("");
      toast(t("Murojaat qabul qilindi"));
      refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Yordam")} />
      <div className="pad stack">
        <div className="panel small">
          <b>{t("Tez-tez so'raladi")}</b>
          <details className="mt8"><summary>{t("To'lov qilindi, lekin Premium ochilmadi")}</summary><p className="muted">{t("Tasdiq odatda bir necha soniyada keladi. Premium sahifasini yangilang. Agar 10 daqiqada ochilmasa, quyida murojaat qoldiring yoki botda /paysupport yozing.")}</p></details>
          <details><summary>{t("Obunani qanday o'chiraman?")}</summary><p className="muted">{t("Premium sahifasida «Avtomatik yangilanishni o'chirish». To'langan muddat oxirigacha o'qish davom etadi.")}</p></details>
          <details><summary>{t("O'qish joyim yo'qoldimi?")}</summary><p className="muted">{t("Joy hisobingizda saqlanadi. Boshqa qurilmada o'qigan bo'lsangiz, ilova qaysi joydan davom etishni so'raydi.")}</p></details>
        </div>
        <div className="field"><label>{t("Mavzu")}</label>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="payment">{t("To'lov")}</option><option value="content">{t("Kontent")}</option><option value="account">{t("Hisob")}</option><option value="complaint">{t("Shikoyat")}</option><option value="other">{t("Boshqa")}</option>
          </select>
        </div>
        <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={t("Muammoni yozing")} />
        <button className="btn primary block" disabled={!body.trim()} onClick={send}>{t("Yuborish")}</button>
        {!!data?.length && (
          <>
            <h3 className="mt16">{t("Murojaatlarim")}</h3>
            {data.map((tk) => (
              <div key={tk.id} className="panel small">
                <div className="row between"><b>#{tk.id} {tk.subject}</b><span className="pill">{tk.status}</span></div>
                {tk.messages.map((m: any, i: number) => <div key={i} className={`mt8 ${m.staff ? "" : "muted"}`}>{m.staff ? "🛟 " : ""}{m.body}</div>)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
