import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Seg, Spinner, TopBar } from "../../components/ui";
import { get } from "../../lib/api";
import { fmtDate, useT } from "../../lib/i18n";

type Day = { date: string; new_users: number; active_readers: number; qualified_readers: number; stars?: number };

/** One measure per chart (no dual axis). Bars anchored to the baseline, 2px gaps, tap/hover shows the value. */
function DayBars({ title, data, field }: { title: string; data: Day[]; field: keyof Day }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = data.map((d) => Number(d[field] || 0));
  const max = Math.max(1, ...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  const h = hover ?? vals.length - 1;
  return (
    <div className="panel">
      <div className="row between"><b className="small">{title}</b><span className="tiny dim">Σ {total}</span></div>
      <div className="tiny" style={{ minHeight: 16, color: "var(--text)" }}>{fmtDate(data[h]?.date)}: <b>{vals[h]}</b></div>
      <div className="daybars" role="img" aria-label={`${title}: ${total}`} onMouseLeave={() => setHover(null)}>
        {vals.map((v, i) => (
          <div key={i} className="daybar-hit" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
            <div className={`daybar ${i === h ? "on" : ""}`} style={{ height: `${Math.max(v ? 3 : 1, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="row between tiny dim"><span>{fmtDate(data[0]?.date)}</span><span>{fmtDate(data[data.length - 1]?.date)}</span></div>
    </div>
  );
}

function HBar({ label, value, max, sub }: { label: string; value: number; max: number; sub?: string }) {
  return (
    <div className="hbar">
      <div className="row between small"><span>{label}</span><b>{value}{sub ? <span className="tiny dim"> {sub}</span> : null}</b></div>
      <div className="hbar-track"><div className="hbar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></div>
    </div>
  );
}

export default function Analytics() {
  const t = useT();
  const [days, setDays] = useState("30");
  const [table, setTable] = useState(false);
  const q = useQuery({ queryKey: ["analytics", days], queryFn: () => get("/admin/analytics", { days }) });
  const d = q.data;
  const STEP: Record<string, string> = { joined: t("Ilovaga kirdi"), started_reading: t("O'qishni boshladi"), qualified_read: t("Haqiqatan o'qidi"), paid: t("To'lov qildi") };
  return (
    <div className="page no-nav">
      <TopBar title={t("Analitika")} />
      <div className="pad stack">
        <div className="row between">
          <Seg value={days} onChange={setDays} options={[["7", "7"], ["30", "30"], ["90", "90"]]} />
          <button className="link small" onClick={() => setTable(!table)}>{table ? t("Grafik") : t("Jadval")}</button>
        </div>
        {!d ? <Spinner /> : (
          <>
            <div className="kpis">
              <div className="kpi"><b>{d.totals.new_users}</b><span>{t("Yangi foydalanuvchilar")}</span></div>
              <div className="kpi"><b>{d.funnel.find((f: any) => f.step === "qualified_read")?.users ?? 0}</b><span>{t("Haqiqatan o'qiganlar")}</span></div>
              {d.retention.d1.percent != null && <div className="kpi"><b>{d.retention.d1.percent}%</b><span>{t("Ertasi kuni qaytdi")}</span></div>}
              {d.totals.stars != null && <div className="kpi"><b>{d.totals.stars} ⭐</b><span>{t("Tushum")}</span></div>}
            </div>
            {table ? (
              <div className="panel" style={{ overflowX: "auto" }}>
                <table className="small" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr className="dim"><th align="left">{t("Sana")}</th><th>{t("Yangi")}</th><th>{t("Faol")}</th><th>{t("O'qidi")}</th>{d.totals.stars != null && <th>⭐</th>}</tr></thead>
                  <tbody>{[...d.daily].reverse().map((r: Day) => <tr key={r.date}><td>{fmtDate(r.date)}</td><td align="center">{r.new_users}</td><td align="center">{r.active_readers}</td><td align="center">{r.qualified_readers}</td>{d.totals.stars != null && <td align="center">{r.stars}</td>}</tr>)}</tbody>
                </table>
              </div>
            ) : (
              <>
                <DayBars title={t("Faol o'quvchilar")} data={d.daily} field="active_readers" />
                <DayBars title={t("Yangi foydalanuvchilar")} data={d.daily} field="new_users" />
                {d.totals.stars != null && <DayBars title={t("Tushum (Stars)")} data={d.daily} field="stars" />}
              </>
            )}
            <div className="panel stack">
              <b className="small">{t("Voronka: shu davrda kelganlar")}</b>
              {d.funnel.map((f: any) => <HBar key={f.step} label={STEP[f.step] || f.step} value={f.users} max={d.funnel[0].users} sub={d.funnel[0].users ? `${Math.round((100 * f.users) / d.funnel[0].users)}%` : ""} />)}
              <span className="tiny dim">{t("Qaytish")}: D1 {d.retention.d1.percent ?? "—"}% · D7 {d.retention.d7.percent ?? "—"}%{d.retention.small_sample ? ` · ${t("kam namuna")}` : ""}</span>
            </div>
            {d.dropoff.map((w: any) => (
              <div key={w.work_id} className="panel stack">
                <b className="small">📉 {w.title}</b>
                <span className="tiny dim">{t("Har bobni ochgan / tugatgan o'quvchilar. Keskin tushish — o'quvchilar shu yerda to'xtayapti.")}</span>
                {w.chapters.map((c: any, i: number) => <HBar key={c.id} label={`${i + 1}. ${c.title}`} value={c.opened} max={w.chapters[0]?.opened || 1} sub={`✓ ${c.completed}`} />)}
              </div>
            ))}
            <p className="tiny dim">{d.note}</p>
          </>
        )}
      </div>
    </div>
  );
}
