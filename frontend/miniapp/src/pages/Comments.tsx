import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Empty, Seg, Spinner, TopBar, useToast } from "../components/ui";
import { ApiError, del, get, patch, post, put, uuid } from "../lib/api";
import { useAuth } from "../lib/auth";
import { relTime, useT } from "../lib/i18n";
import { ReportSheet } from "./WorkPage";

const DRAFT_KEY = (w: string, c: string | null) => `hk_cdraft_${w}_${c || "w"}`;

/** E-10/E-11: work and chapter discussions. Spoilers hidden by default; text kept on errors (T-21). */
export default function Comments() {
  const { code } = useParams();
  const [sp, setSp] = useSearchParams();
  const chapterId = sp.get("chapter");
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [sort, setSort] = useState<"new" | "helpful">("new");
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY(code!, chapterId)) || "");
  const [spoiler, setSpoiler] = useState(false);
  const [replyTo, setReplyTo] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [pendingKey, setPendingKey] = useState(uuid());
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [report, setReport] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const { data: work } = useQuery({ queryKey: ["work", code], queryFn: () => get(`/works/${code}`) });
  const q = useInfiniteQuery({
    queryKey: ["comments", work?.id, chapterId, sort],
    enabled: !!work,
    queryFn: ({ pageParam }) => get(`/works/${work.id}/comments`, { chapter_id: chapterId, sort, cursor: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (l: any) => l.next_cursor ?? undefined,
  });

  const saveDraft = (v: string) => {
    setText(v);
    localStorage.setItem(DRAFT_KEY(code!, chapterId), v);
  };

  const send = async () => {
    if (!text.trim() || !work) return;
    setSending(true);
    try {
      await post(`/works/${work.id}/comments`, { body: text, chapter_id: chapterId ? Number(chapterId) : null, parent_id: replyTo?.id ?? null, spoiler, client_key: pendingKey });
      localStorage.removeItem(DRAFT_KEY(code!, chapterId));
      setText("");
      setSpoiler(false);
      setReplyTo(null);
      setPendingKey(uuid());
      qc.invalidateQueries({ queryKey: ["comments", work.id] });
    } catch (e) {
      // the text stays in the box and in local storage; no false «sent» message
      toast(e instanceof ApiError ? e.message : t("Yuborilmadi. Matn saqlab qolindi."), true);
    } finally {
      setSending(false);
    }
  };

  const reveal = async (id: number) => {
    try {
      const r = await get(`/comments/${id}/reveal`);
      setRevealed((x) => ({ ...x, [id]: r.body }));
    } catch (e: any) {
      toast(e.message, true);
    }
  };
  const helpful = async (c: any) => {
    try {
      c.voted_helpful ? await del(`/comments/${c.id}/helpful`) : await put(`/comments/${c.id}/helpful`);
      qc.invalidateQueries({ queryKey: ["comments", work.id] });
    } catch (e: any) { toast(e.message, true); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      await patch(`/comments/${editing.id}`, { body: editing.body });
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["comments", work.id] });
    } catch (e: any) { toast(e.message, true); }
  };
  const remove = async (id: number) => {
    await del(`/comments/${id}`);
    qc.invalidateQueries({ queryKey: ["comments", work.id] });
  };

  const items = q.data?.pages.flatMap((p: any) => p.items) || [];
  const roots = items.filter((c: any) => !c.parent_id);
  const replies = (id: number) => items.filter((c: any) => c.parent_id === id);
  const accessErr = q.error instanceof ApiError && q.error.code === "access_required";
  const closed = work?.comments_policy === "closed";

  const renderC = (c: any, isReply = false) => (
    <div key={c.id} className={`cmt ${isReply ? "reply" : ""}`}>
      <div className="row between">
        <span className="who">{c.user.name}{c.is_author_reply && <span className="author-mark">✎ {t("Muallif")}</span>}{c.pinned && " 📌"}</span>
        <span className="tiny dim">{relTime(c.created_at)}{c.edited ? ` · ${t("tahrirlangan")}` : ""}</span>
      </div>
      {c.status === "pending" && <div className="tiny" style={{ color: "var(--premium)" }}>{t("Moderatsiyada — faqat sizga ko'rinadi")}</div>}
      {editing?.id === c.id ? (
        <div className="stack mt8">
          <textarea className="textarea" value={editing?.body ?? ""} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} maxLength={2000} />
          <div className="row"><button className="btn primary" onClick={saveEdit}>{t("Saqlash")}</button><button className="btn" onClick={() => setEditing(null)}>{t("Bekor")}</button></div>
        </div>
      ) : c.spoiler_hidden && !revealed[c.id] ? (
        <button className="spoiler" onClick={() => reveal(c.id)}>⚠️ {c.spoiler ? t("Spoiler. Ko'rish uchun bosing") : t("Siz hali o'qimagan bob haqida. Ko'rish uchun bosing")}</button>
      ) : (
        <div className="body">{revealed[c.id] || c.body}</div>
      )}
      <div className="row mt8" style={{ gap: 14 }}>
        {!isReply && !closed && <button className="tiny muted" style={{ minHeight: 32 }} onClick={() => setReplyTo(c)}>{t("Javob")}</button>}
        <button className={`tiny ${c.voted_helpful ? "" : "muted"}`} style={{ minHeight: 32 }} onClick={() => helpful(c)}>👍 {t("Foydali")} {c.helpful || ""}</button>
        {c.mine && c.editable_until && new Date(c.editable_until) > new Date() && <button className="tiny muted" onClick={() => setEditing({ id: c.id, body: c.body })}>{t("Tahrirlash")}</button>}
        {c.mine && <button className="tiny muted" onClick={() => remove(c.id)}>{t("O'chirish")}</button>}
        {!c.mine && <button className="tiny muted" onClick={() => setReport(c.id)}>{t("Shikoyat")}</button>}
      </div>
      {!isReply && replies(c.id).map((r: any) => renderC(r, true))}
    </div>
  );

  return (
    <div className="page no-nav" style={{ paddingBottom: 0 }}>
      <TopBar title={chapterId ? t("Bob muhokamasi") : t("Sharhlar")} />
      <div className="pad row between">
        <Seg value={sort} onChange={setSort} options={[["new", t("Yangi")], ["helpful", t("Foydali")]]} />
        {chapterId && <button className="link small" onClick={() => setSp({}, { replace: true })}>{t("Umumiy muhokama")}</button>}
      </div>
      {accessErr ? (
        <Empty icon="🔒" title={t("Bu bob muhokamasi bob ochilgandan keyin ko'rinadi")}>
          <Link to="/premium" className="btn premium mt8">{t("Premium")}</Link>
        </Empty>
      ) : q.isLoading ? <Spinner /> : !roots.length ? (
        <Empty icon="💬" title={t("Hali sharh yo'q")}>{t("Birinchi bo'lib fikr bildiring.")}</Empty>
      ) : (
        <div className="mt8" style={{ minHeight: "50vh" }}>
          {roots.map((c: any) => renderC(c))}
          {q.hasNextPage && <div className="pad mt16"><button className="btn block" onClick={() => q.fetchNextPage()}>{t("Yana")}</button></div>}
        </div>
      )}
      {!accessErr && !closed && me && (
        <div className="composer">
          <div className="grow stack" style={{ gap: 6 }}>
            {replyTo && <div className="tiny muted row between">{t("Javob")}: {replyTo.user.name}<button onClick={() => setReplyTo(null)}>✕</button></div>}
            <textarea className="textarea" style={{ minHeight: 44 }} placeholder={t("Fikringiz...")} value={text} maxLength={2000} onChange={(e) => saveDraft(e.target.value)} aria-label={t("Sharh")} />
            <div className="row between">
              <label className="tiny muted row" style={{ gap: 6 }}><input type="checkbox" checked={spoiler} onChange={(e) => setSpoiler(e.target.checked)} /> {t("Spoiler bor")}</label>
              <span className="tiny dim">{text.length}/2000</span>
            </div>
          </div>
          <button className="btn primary" disabled={sending || !text.trim()} onClick={send}>{t("Yuborish")}</button>
        </div>
      )}
      {closed && <p className="pad small muted center">{t("Bu asarda sharhlar yopilgan.")}</p>}
      <ReportSheet open={report !== null} onClose={() => setReport(null)} targetType="comment" targetId={report || 0} />
    </div>
  );
}
