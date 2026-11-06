import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { Empty, Spinner, TopBar, useToast } from "../../components/ui";
import { api, del, get, patch, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { afterDate, fmtDate, untilDate, useT } from "../../lib/i18n";
import { confirmDialog, shareLink } from "../../lib/tg";
import { upload } from "./WorkEditor";

const aiStatus = () => get<{ enabled: boolean }>("/ai/status");

/** Character cards with a «reveal after chapter» setting (spoiler-safe for readers). */
export function CharactersManager({ workId, chapters }: { workId: number; chapters: { id: number; title: string }[] }) {
  const t = useT();
  const toast = useToast();
  const q = useQuery({ queryKey: ["studio-chars", workId], queryFn: () => get(`/studio/works/${workId}/characters`) });
  const [edit, setEdit] = useState<any | null>(null);
  const save = async () => {
    try {
      const body = { name: edit.name, description: edit.description || "", reveal_chapter_id: edit.reveal_chapter_id || null, avatar_asset_id: edit.avatar_asset_id ?? undefined };
      if (edit.id) await patch(`/studio/characters/${edit.id}`, body);
      else await post(`/studio/works/${workId}/characters`, body);
      setEdit(null);
      q.refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  const remove = async (id: number) => {
    if (!(await confirmDialog(t("Qahramon kartasi o'chirilsinmi?")))) return;
    await del(`/studio/characters/${id}`);
    q.refetch();
  };
  const onAvatar = async (f?: File) => {
    if (!f) return;
    try {
      const a = await upload(f, "avatar", true);
      setEdit({ ...edit, avatar_asset_id: a.asset_id, avatar_url: a.url });
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <>
      <div className="row between mt16"><h2>{t("Qahramonlar")}</h2><button className="btn" style={{ minHeight: 36 }} onClick={() => setEdit({ name: "", description: "", reveal_chapter_id: null })}>+ {t("Qahramon")}</button></div>
      <p className="tiny dim">{t("«Ochiladi» bobini tanlasangiz, karta o'quvchiga faqat shu bobni o'qib bo'lgach ko'rinadi.")}</p>
      <div className="list">
        {(q.data?.items || []).map((c: any) => (
          <div key={c.id} className="li">
            <div className="char-card grow">{c.avatar_url ? <img src={c.avatar_url} alt="" /> : <div className="ph">{c.name[0]}</div>}
              <div><b>{c.name}</b><div className="tiny dim">{c.reveal_chapter_title ? `🔒 ${c.reveal_chapter_title}` : t("Darhol ko'rinadi")}</div></div>
            </div>
            <button className="tiny link" onClick={() => setEdit({ ...c })}>{t("Tahrirlash")}</button>
            <button className="tiny link" onClick={() => remove(c.id)}>✕</button>
          </div>
        ))}
        {q.data && !q.data.items.length && <div className="li small muted">{t("Hali qahramon kartasi yo'q")}</div>}
      </div>
      {edit && (
        <div className="panel stack mt8">
          <div className="field"><label>{t("Ism")}</label><input className="input" maxLength={120} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field"><label>{t("Tavsif")}</label><textarea className="textarea" maxLength={2000} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          <div className="field"><label>{t("Qachon ochiladi")}</label>
            <select className="select" value={edit.reveal_chapter_id || 0} onChange={(e) => setEdit({ ...edit, reveal_chapter_id: Number(e.target.value) || null })}>
              <option value={0}>{t("Darhol")}</option>
              {chapters.map((c) => <option key={c.id} value={c.id}>{t("O'qilgandan keyin")}: {c.title}</option>)}
            </select>
          </div>
          <label className="btn ghost" style={{ minHeight: 36 }}>🖼 {t("Rasm")}<input type="file" hidden accept="image/*" onChange={(e) => onAvatar(e.target.files?.[0])} /></label>
          <div className="row"><button className="btn primary grow" disabled={!edit.name?.trim()} onClick={save}>{t("Saqlash")}</button><button className="btn ghost" onClick={() => setEdit(null)}>{t("Bekor")}</button></div>
        </div>
      )}
    </>
  );
}

/** Personal beta-reader links for unpublished drafts. Beta reads are not counted in stats. */
export function BetaInvites({ workId, chapters }: { workId: number; chapters: { id: number; title: string }[] }) {
  const t = useT();
  const toast = useToast();
  const q = useQuery({ queryKey: ["beta", workId], queryFn: () => get(`/studio/works/${workId}/beta-invites`) });
  const [chapter, setChapter] = useState(0);
  const [days, setDays] = useState(14);
  const [note, setNote] = useState("");
  const create = async () => {
    try {
      const inv = await post(`/studio/works/${workId}/beta-invites`, { chapter_id: chapter || null, days, note });
      shareLink(inv.link, t("Qoralamamni o'qib, fikr bildirasizmi?"));
      setNote("");
      q.refetch();
    } catch (e: any) { toast(e.message, true); }
  };
  const revoke = async (id: number) => { await del(`/studio/beta-invites/${id}`); q.refetch(); };
  return (
    <>
      <h2 className="mt16">{t("Beta-o'quvchilar")}</h2>
      <p className="tiny dim">{t("Har havola bitta odam uchun: birinchi ochgan kishiga biriktiriladi. Fikrlar bob muharririda «[Beta]» belgisi bilan chiqadi.")}</p>
      <div className="panel stack">
        <select className="select" value={chapter} onChange={(e) => setChapter(Number(e.target.value))}>
          <option value={0}>{t("Barcha boblar")}</option>
          {chapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <div className="row"><label className="small grow">{t("Muddat (kun)")}</label><input className="input" style={{ width: 80 }} type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
        <input className="input" maxLength={500} placeholder={t("O'quvchiga izoh (ixtiyoriy)")} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" onClick={create}>🔗 {t("Havola yaratish va ulashish")}</button>
      </div>
      <div className="list mt8">
        {(q.data?.items || []).map((i: any) => (
          <div key={i.id} className="li">
            <div className="grow small">{i.reader || t("Hali ochilmagan")} <span className="tiny dim">· {i.active ? untilDate(i.expires_at) : t("faol emas")}</span></div>
            {i.active && <button className="tiny link" onClick={() => navigator.clipboard?.writeText(i.link).then(() => toast(t("Nusxalandi")))}>⧉</button>}
            {i.active && <button className="tiny link" onClick={() => revoke(i.id)}>{t("Bekor")}</button>}
          </div>
        ))}
      </div>
    </>
  );
}

/** AI synopsis variants: suggestions only, the author picks and edits. */
export function AiSynopsis({ workId, onPick }: { workId: number; onPick: (text: string) => void }) {
  const t = useT();
  const toast = useToast();
  const st = useQuery({ queryKey: ["ai-status"], queryFn: aiStatus, staleTime: 600_000 });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  if (!st.data?.enabled) return null;
  const run = async () => {
    setBusy(true);
    try { setRes(await post(`/studio/ai/works/${workId}/synopsis`)); } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <button className="btn ghost" disabled={busy} onClick={run}>{busy ? t("Tayyorlanmoqda…") : "✨ " + t("AI annotatsiya variantlari")}</button>
      {res?.status === "refused" && <p className="small muted">{res.message}</p>}
      {res?.variants?.map((v: any, i: number) => (
        <div key={i} className="panel small">
          <div className="tiny dim">{v.tone}</div>
          <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{v.text}</p>
          <button className="tiny link" onClick={() => onPick(v.text)}>{t("Annotatsiyaga qo'yish")}</button>
        </div>
      ))}
    </div>
  );
}

/** AI proofreading: each suggestion is accepted or skipped by the author; accepted ones become a new draft revision. */
export function AiProofread({ chapterId, onApplied }: { chapterId: number; onApplied: () => void }) {
  const t = useT();
  const toast = useToast();
  const st = useQuery({ queryKey: ["ai-status"], queryFn: aiStatus, staleTime: 600_000 });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  if (!st.data?.enabled) return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await post(`/studio/ai/chapters/${chapterId}/proofread`);
      setRes(r);
      setPicked(new Set((r.suggestions || []).map((s: any) => s.index)));
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await post(`/studio/ai/proofread/${res.request_id}/apply`, { accepted: [...picked] });
      toast(`${t("Qabul qilindi")}: ${r.applied.length}`);
      setRes(null);
      onApplied();
    } catch (e: any) {
      toast(e.code === "revision_conflict" ? t("Matn o'zgargan. Takliflarni qayta so'rang.") : e.message, true);
    } finally { setBusy(false); }
  };
  const toggle = (i: number) => setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <div className="panel stack mt16">
      {!res ? (
        <button className="btn ghost" disabled={busy} onClick={run}>{busy ? t("Tekshirilmoqda…") : "✨ " + t("AI imlo tekshiruvi (saqlangan matn)")}</button>
      ) : res.status !== "ok" ? (
        <p className="small muted">{res.message}</p>
      ) : !res.suggestions.length ? (
        <p className="small">✓ {t("Taklif yo'q")}</p>
      ) : (
        <>
          <b className="small">{t("Takliflar")}: {res.suggestions.length}</b>
          {res.suggestions.map((s: any) => (
            <label key={s.index} className="row small" style={{ alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={picked.has(s.index)} onChange={() => toggle(s.index)} />
              <span className="grow"><span className="diff-del">{s.original}</span> → <span className="diff-ins">{s.replacement}</span><br /><span className="tiny dim">{s.reason}</span></span>
            </label>
          ))}
          <div className="row"><button className="btn primary grow" disabled={busy || !picked.size} onClick={apply}>{t("Tanlanganlarni qo'llash")}</button><button className="btn ghost" onClick={() => setRes(null)}>{t("Yopish")}</button></div>
          <p className="tiny dim">{t("Qo'llash yangi qoralama versiyasini yaratadi. Nashr qilingan matn o'zgarmaydi.")}</p>
        </>
      )}
    </div>
  );
}

/** Author earnings ledger (model A: share of single-work sales). */
export function Royalties() {
  const t = useT();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ["royalties"], enabled: !!me?.author, queryFn: () => get("/studio/royalties") });
  const d = q.data;
  const STATE: Record<string, string> = { pending: t("Kutilmoqda"), available: t("To'lashga tayyor"), paid: t("To'langan"), reversed: t("Qaytarilgan") };
  return (
    <div className="page no-nav">
      <TopBar title={t("Daromad")} />
      {!me?.author ? <Empty icon="💰" title={t("Muallif profili kerak")} /> : !d ? <Spinner /> : !d.enabled && !d.entries.length ? (
        <Empty icon="💰" title={t("Mualliflik ulushi hali yoqilmagan")}>{t("Platforma egasi yoqqanda alohida sotilgan asarlaringizdan ulush shu yerda ko'rinadi.")}</Empty>
      ) : (
        <div className="pad stack">
          <div className="kpis">
            {(["pending", "available", "paid"] as const).map((k) => <div key={k} className="kpi"><b>{d.by_state[k]?.stars || 0} ⭐</b><span>{STATE[k]}</span></div>)}
          </div>
          <p className="tiny dim">{t("Ulush")}: {d.share_percent}% · {t("kutish muddati")}: {d.hold_days} {t("kun")}. {d.note}</p>
          {d.debt_stars > 0 && <div className="panel small">{t("Qaytarilgan to'lovlar bo'yicha keyingi to'lovdan ushlanadi")}: {d.debt_stars} ⭐</div>}
          <h3>{t("Yozuvlar")}</h3>
          <div className="list">
            {d.entries.map((e: any) => (
              <div key={e.id} className="li"><div className="grow small">#{e.payment_id} · {e.gross} ⭐ → <b>{e.amount} ⭐</b><div className="tiny dim">{fmtDate(e.created_at)}{e.state === "pending" ? ` · ${afterDate(e.available_at)}` : ""}</div></div><span className="pill">{STATE[e.state]}</span></div>
            ))}
          </div>
          {!!d.payouts.length && (<><h3>{t("To'lovlar")}</h3><div className="list">{d.payouts.map((p: any) => <div key={p.id} className="li small"><span className="grow">{fmtDate(p.created_at)} · {p.note}</span><b>{p.amount} ⭐</b></div>)}</div></>)}
        </div>
      )}
    </div>
  );
}

/** Branching: up to 4 choices at the end of this chapter, each leading to another chapter of the work. */
export function ChoicesManager({ chapterId, workId }: { chapterId: number; workId: number }) {
  const t = useT();
  const toast = useToast();
  const work = useQuery({ queryKey: ["studio-work", String(workId)], queryFn: () => get(`/studio/works/${workId}`) });
  const q = useQuery({ queryKey: ["choices", chapterId], queryFn: () => get(`/studio/chapters/${chapterId}/choices`) });
  const [items, setItems] = useState<{ label: string; target_chapter_id: number; picks?: number }[] | null>(null);
  type ChoiceRow = { label: string; target_chapter_id: number; picks?: number };
  const list: ChoiceRow[] = items ?? q.data?.items ?? [];
  const others = (work.data?.chapters || []).filter((c: any) => c.id !== chapterId);
  const save = async () => {
    try {
      const r = await api(`/studio/chapters/${chapterId}/choices`, { method: "PUT", body: { items: list.map(({ label, target_chapter_id }) => ({ label, target_chapter_id })) } });
      setItems(null);
      q.refetch();
      toast(r.items.length ? t("Tanlovlar saqlandi") : t("Bob yana oddiy (chiziqli) bo'ldi"));
    } catch (e: any) { toast(e.message, true); }
  };
  const upd = (i: number, patch_: any) => setItems(list.map((x, j) => (j === i ? { ...x, ...patch_ } : x)));
  return (
    <div className="field">
      <label>🔀 {t("Bob oxiridagi tanlovlar (tarmoqlanuvchi hikoya)")}</label>
      {list.map((c, i) => (
        <div key={i} className="stack" style={{ gap: 4, marginBottom: 8 }}>
          <input className="input" maxLength={120} placeholder={t("Tanlov matni, masalan: «Eshikni ochish»")} value={c.label} onChange={(e) => upd(i, { label: e.target.value })} />
          <div className="row">
            <select className="select grow" value={c.target_chapter_id || 0} onChange={(e) => upd(i, { target_chapter_id: Number(e.target.value) })}>
              <option value={0}>— {t("qaysi bobga")} —</option>
              {others.map((o: any) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
            <button className="btn ghost" style={{ minHeight: 36 }} onClick={() => setItems(list.filter((_, j) => j !== i))}>✕</button>
          </div>
          {c.picks != null && items === null && <span className="tiny dim">{t("Tanlaganlar")}: {c.picks}</span>}
        </div>
      ))}
      <div className="row">
        {list.length < 4 && <button className="btn ghost" style={{ minHeight: 36 }} onClick={() => setItems([...list, { label: "", target_chapter_id: 0 }])}>+ {t("Tanlov")}</button>}
        {items !== null && <button className="btn primary" style={{ minHeight: 36 }} disabled={list.some((c) => !c.label.trim() || !c.target_chapter_id)} onClick={save}>{t("Tanlovlarni saqlash")}</button>}
      </div>
      <span className="tiny dim">{t("Tanlov bo'lsa, o'quvchiga «Keyingi bob» o'rniga shu tugmalar chiqadi.")}</span>
    </div>
  );
}

/** Audio ↔ text sync: play the chapter audio and tap each paragraph when its narration starts. */
export function AudioSyncPage() {
  const { chapterId } = useParams();
  const t = useT();
  const toast = useToast();
  const q = useQuery({ queryKey: ["audio-sync", chapterId], queryFn: () => get(`/studio/chapters/${chapterId}/audio-sync`), staleTime: Infinity });
  const audio = useRef<HTMLAudioElement>(null);
  const [marks, setMarks] = useState<Record<string, number> | null>(null);
  const m = marks ?? Object.fromEntries((q.data?.marks || []).map((x: any) => [x.bid, x.t]));
  if (!q.data) return <div className="page no-nav"><TopBar /><Spinner /></div>;
  const d = q.data;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const tap = (bid: string) => {
    const now = audio.current?.currentTime ?? 0;
    setMarks({ ...m, [bid]: Math.round(now * 100) / 100 });
  };
  const save = async () => {
    try {
      const r = await api(`/studio/chapters/${chapterId}/audio-sync`, { method: "PUT", body: { marks: Object.entries(m).map(([bid, tt]) => ({ bid, t: tt })) } });
      setMarks(null);
      q.refetch();
      toast(`${t("Saqlandi")}: ${r.marks.length}`);
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="page no-nav">
      <TopBar title={t("Audio va matn sinxroni")} />
      <div className="pad stack">
        {!d.audio_url ? <p className="small muted">{t("Avval bob sozlamalarida audio biriktiring.")}</p> : (
          <>
            <audio ref={audio} src={d.audio_url} controls style={{ width: "100%" }} />
            <p className="tiny dim">{t("Audioni yoqing va har xatboshi o'qila boshlaganda unga bosing. Belgini olib tashlash uchun ✕.")}</p>
          </>
        )}
        <div className="list">
          {d.blocks.map((b: any) => (
            <div key={b.bid} className="li" style={{ alignItems: "flex-start" }}>
              <button className="grow small" style={{ textAlign: "left" }} disabled={!d.audio_url} onClick={() => tap(b.bid)}>{b.text}</button>
              {m[b.bid] != null ? (
                <span className="row" style={{ gap: 4 }}>
                  <button className="pill" onClick={() => { if (audio.current) audio.current.currentTime = m[b.bid]; }}>{fmt(m[b.bid])}</button>
                  <button className="tiny link" onClick={() => { const n = { ...m }; delete n[b.bid]; setMarks(n); }}>✕</button>
                </span>
              ) : <span className="tiny dim">—</span>}
            </div>
          ))}
        </div>
        <button className="btn primary block" disabled={marks === null} onClick={save}>{t("Saqlash")}</button>
      </div>
    </div>
  );
}
