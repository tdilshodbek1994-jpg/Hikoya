import { useQuery } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Sheet, Spinner, TopBar, useToast } from "../../components/ui";
import { ApiError, api, get, patch, post } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { closingConfirmation } from "../../lib/tg";
import { countWords, fromEditor, kit, newBid, toEditor } from "./editorKit";
import { AiProofread } from "./Extras";
import { upload } from "./WorkEditor";

type SaveState = "saved" | "dirty" | "saving" | "offline" | "conflict" | "error";
const LOCAL = (id: string) => `hk_editor_draft_${id}`;

/** E-21/E-23: structured editor with autosave on base_revision; 409 keeps the user's text (T-32). */
export default function ChapterEditor() {
  const { chapterId } = useParams();
  const t = useT();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ["editor", chapterId], queryFn: () => get(`/studio/chapters/${chapterId}`), staleTime: Infinity, gcTime: 0 });
  const [state, setState] = useState<SaveState>("saved");
  const [words, setWords] = useState(0);
  const [meta, setMeta] = useState(false);
  const [notes, setNotes] = useState(false);
  const base = useRef<number | null>(null);
  const timer = useRef<number>(0);
  const imgRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: kit,
    content: "",
    onUpdate: ({ editor }) => {
      setState("dirty");
      setWords(countWords(editor.getJSON()));
      localStorage.setItem(LOCAL(chapterId!), JSON.stringify({ base: base.current, doc: editor.getJSON(), at: Date.now() }));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(), 2500);
    },
  });

  useEffect(() => {
    if (!data || !editor) return;
    base.current = data.base_revision_id;
    const local = JSON.parse(localStorage.getItem(LOCAL(chapterId!)) || "null");
    if (local && local.base === data.base_revision_id) {
      editor.commands.setContent(local.doc, { emitUpdate: false });
      setState("dirty");
      toast(t("Saqlanmagan lokal nusxa tiklandi"));
    } else {
      editor.commands.setContent(toEditor(data.content, data.images || {}), { emitUpdate: false });
    }
    setWords(countWords(editor.getJSON()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, editor]);

  useEffect(() => {
    closingConfirmation(state !== "saved");
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (state !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      closingConfirmation(false);
    };
  }, [state]);

  const save = useCallback(
    async (force = false) => {
      if (!editor) return;
      window.clearTimeout(timer.current);
      setState("saving");
      try {
        if (force) {
          const fresh = await get(`/studio/chapters/${chapterId}`);
          base.current = fresh.base_revision_id;
        }
        const r = await post(`/studio/chapters/${chapterId}/revisions`, { content: fromEditor(editor.getJSON()), base_revision_id: base.current, change_note: force ? "Ziddiyatdan keyin ustidan saqlandi" : "" });
        base.current = r.revision_id;
        localStorage.removeItem(LOCAL(chapterId!));
        setState("saved");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setState("conflict");
        else if (e instanceof ApiError && e.status === 0) setState("offline");
        else {
          setState("error");
          toast(e instanceof Error ? e.message : "Xato", true);
        }
      }
    },
    [editor, chapterId, toast],
  );

  useEffect(() => {
    const on = () => state === "offline" && save();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [state, save]);

  const insertImage = async (f?: File) => {
    if (!f || !editor) return;
    try {
      const a = await upload(f, "image", true);
      editor.chain().focus().insertContent({ type: "image", attrs: { bid: newBid(), asset_id: a.asset_id, caption: "", src: a.url } }).run();
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  if (!data || !editor) return <Spinner />;
  const label: Record<SaveState, string> = { saved: "✓ Saqlandi", dirty: "• O'zgarish bor", saving: "Saqlanmoqda...", offline: "⚠ Tarmoq yo'q — lokal saqlandi", conflict: "⚠ Ziddiyat", error: "⚠ Saqlanmadi" };
  const B = (name: string, label: string, action: () => void, attrs?: any) => (
    <button className={editor.isActive(name, attrs) ? "on" : ""} aria-pressed={editor.isActive(name, attrs)} onMouseDown={(e) => e.preventDefault()} onClick={action} aria-label={name}>{label}</button>
  );
  return (
    <div className="page no-nav">
      <TopBar
        title={<span>{data.chapter.title}<div className={`save-state ${state === "saved" ? "dim" : ""}`} style={{ color: state === "conflict" || state === "error" ? "var(--danger)" : undefined }}>{t(label[state])}</div></span>}
        right={<button className="btn primary" style={{ minHeight: 36 }} disabled={state === "saved" || state === "saving"} onClick={() => save()}>{t("Saqlash")}</button>}
      />
      <div className="pad">
        <div className="row wrap small" style={{ gap: 10, marginBottom: 8 }}>
          <span className="dim">{words} {t("so'z")} · ~{Math.max(1, Math.round(words / 180))} {t("daq")}</span>
          <Link className="link small" to={`/studio/p/${chapterId}`}>👁 {t("Mobil preview")}</Link>
          <Link className="link small" to={`/studio/h/${chapterId}`}>🕓 {t("Tarix va farq")}</Link>
          <button className="link small" onClick={() => setMeta(true)}>⚙ {t("Bob sozlamalari")}</button>
          <button className="link small" onClick={() => setNotes(true)}>💬 {t("Izohlar")} ({data.notes.length + data.issues.length})</button>
          <Link className="link small" to={`/studio/w/${data.work.id}`}>{t("Asar")}</Link>
        </div>
        {state === "conflict" && (
          <div className="panel stack" style={{ borderColor: "var(--danger)", marginBottom: 10 }}>
            <b>{t("Matn boshqa joyda o'zgartirilgan")}</b>
            <span className="small muted">{t("Sizning matningiz shu qurilmada saqlangan, yo'qolmaydi.")}</span>
            <div className="row wrap">
              <button className="btn" onClick={() => save(true)}>{t("Mening nusxamni yangi versiya qilib saqlash")}</button>
              <button className="btn ghost" onClick={async () => { localStorage.removeItem(LOCAL(chapterId!)); await refetch(); setState("saved"); }}>{t("Serverdagi nusxani ochish")}</button>
            </div>
          </div>
        )}
        <div className="editor-wrap">
          <div className="toolbar" role="toolbar" aria-label={t("Formatlash")}>
            {B("bold", "B", () => editor.chain().focus().toggleBold().run())}
            {B("italic", "I", () => editor.chain().focus().toggleItalic().run())}
            {B("heading", "H2", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), { level: 2 })}
            {B("heading", "H3", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), { level: 3 })}
            {B("blockquote", "❝", () => editor.chain().focus().toggleBlockquote().run())}
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().setHorizontalRule().run()} aria-label={t("Ajratgich")}>—</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => imgRef.current?.click()} aria-label={t("Rasm")}>🖼</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().undo().run()} aria-label={t("Bekor qilish")}>↶</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().redo().run()} aria-label={t("Qaytarish")}>↷</button>
          </div>
          <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => insertImage(e.target.files?.[0])} />
          <EditorContent editor={editor} />
        </div>
        <p className="tiny dim mt8">{t("Avtomatik saqlanadi. Nashr qilingan matn faqat «Nashr» bosilganda yangilanadi.")}</p>
        <AiProofread chapterId={Number(chapterId)} onApplied={async () => { localStorage.removeItem(LOCAL(chapterId!)); await refetch(); setState("saved"); }} />
      </div>
      <ChapterMeta open={meta} onClose={() => setMeta(false)} data={data} onSaved={refetch} />
      <Sheet open={notes} onClose={() => setNotes(false)} label={t("Izohlar")}>
        <NotesPanel data={data} onChange={refetch} />
      </Sheet>
    </div>
  );
}

function ChapterMeta({ open, onClose, data, onSaved }: { open: boolean; onClose: () => void; data: any; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [title, setTitle] = useState(data.chapter.title);
  const [override, setOverride] = useState(data.chapter.access_override);
  const [preview, setPreview] = useState(data.chapter.preview_blocks);
  const [recap, setRecap] = useState(data.chapter.recap || "");
  const [audioBusy, setAudioBusy] = useState(false);
  const save = async () => {
    try {
      await patch(`/studio/chapters/${data.chapter.id}`, { title, access_override: override, preview_blocks: preview, recap });
      toast(t("Saqlandi"));
      onSaved();
      onClose();
    } catch (e: any) { toast(e.message, true); }
  };
  const addAudio = async (f?: File) => {
    if (!f) return;
    setAudioBusy(true);
    try {
      const a = await upload(f, "audio");
      await post("/studio/assets/link", { asset_id: a.asset_id, target_type: "chapter", target_id: data.chapter.id, purpose: "audio", title: f.name });
      toast(t("Audio biriktirildi"));
      onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setAudioBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label={t("Bob sozlamalari")}>
      <h2>{t("Bob sozlamalari")}</h2>
      <div className="stack mt16">
        <div className="field"><label>{t("Bob nomi")}</label><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label>{t("Kirish")}</label>
          <select className="select" value={override} onChange={(e) => setOverride(e.target.value)}>
            <option value="inherit">{t("Asar siyosatini olish")}</option>
            <option value="free_sample">{t("Bepul namuna bob")}</option>
            <option value="free_after">{t("Belgilangan sanadan keyin bepul")}</option>
            <option value="locked_until">{t("E'lon sanasigacha faqat preview")}</option>
          </select>
        </div>
        <div className="field"><label>{t("Pulli bobda bepul ko'rinadigan bloklar soni")}</label><input className="input" type="number" min={0} max={30} value={preview} onChange={(e) => setPreview(Number(e.target.value))} /></div>
        <div className="field"><label>{t("«Qayerda to'xtagandim?» qisqa mazmuni")}</label>
          <textarea className="textarea" maxLength={1500} value={recap} onChange={(e) => setRecap(e.target.value)} placeholder={t("Shu bobda nima bo'ldi — 2–4 gap")} />
          <span className="tiny dim">{t("Keyingi bobni ochganda faqat shu bobni o'qib bo'lganlarga ko'rinadi.")}</span>
        </div>
        <div className="field"><label>{t("Bob audiosi (MP3/M4A)")}</label>
          <input type="file" accept="audio/mpeg,audio/mp4,.m4a,.mp3" disabled={audioBusy} onChange={(e) => addAudio(e.target.files?.[0])} />
          {data.attachments.filter((a: any) => a.purpose === "audio").map((a: any) => <div key={a.link_id} className="tiny dim">🎧 {a.title}</div>)}
          <span className="tiny dim">{t("Audio ham shu bobning Premium huquqiga bo'ysunadi.")}</span>
        </div>
        <button className="btn primary block" onClick={save}>{t("Saqlash")}</button>
      </div>
    </Sheet>
  );
}

function NotesPanel({ data, onChange }: { data: any; onChange: () => void }) {
  const t = useT();
  const [body, setBody] = useState("");
  const add = async () => {
    await post(`/studio/chapters/${data.chapter.id}/notes`, { body });
    setBody("");
    onChange();
  };
  return (
    <div className="stack">
      <h2>{t("Muallif va muharrir izohlari")}</h2>
      {data.notes.map((n: any) => (
        <div key={n.id} className="panel small row"><span className="grow">{n.body}</span><button className="link tiny" onClick={async () => { await post(`/studio/notes/${n.id}/resolve`); onChange(); }}>{t("Hal qilindi")}</button></div>
      ))}
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("Izoh yozing")} />
      <button className="btn" disabled={!body.trim()} onClick={add}>{t("Qo'shish")}</button>
      <h3 className="mt16">{t("O'quvchilar topgan xatolar")}</h3>
      {!data.issues.length && <p className="small muted">{t("Yo'q")}</p>}
      {data.issues.map((i: any) => (
        <div key={i.id} className="panel small">
          <div style={{ fontFamily: "var(--font-serif)" }}>«{i.quote}»</div>
          <div className="muted mt8">{i.note}</div>
          <div className="row mt8">
            <button className="link tiny" onClick={async () => { await fetchIssue(i.id, "accepted"); onChange(); }}>{t("Qabul")}</button>
            <button className="link tiny" onClick={async () => { await fetchIssue(i.id, "rejected"); onChange(); }}>{t("Rad")}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function fetchIssue(id: number, status: string) {
  return api(`/studio/issues/${id}`, { method: "POST", query: { status }, body: {} });
}
