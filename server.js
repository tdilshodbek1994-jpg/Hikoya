import "./src/env.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { LESSONS, getLesson, publicLesson } from "./src/lessons.js";
import { verifyInitData } from "./src/telegram.js";
import { chatTurn, tutorTurn, freeTurn, tutorOpener, transcribe, speakParts, speak, voiceEnabled } from "./src/ai.js";

// ⚡ Tez javob: matn darhol qaytadi, ovoz esa bo'laklab (gapma-gap) parallel tayyorlanadi.
// Telefon birinchi bo'lak tayyor bo'lishi bilan uni ijro etadi, qolganlari shu paytda tayyorlanadi.
function splitSentences(text) {
  const raw = String(text || "").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const out = [];
  for (const t of raw) {
    // juda qisqa bo'laklarni oldingisiga qo'shamiz (masalan "Ok." alohida so'rov bo'lmasin)
    if (out.length && (out[out.length - 1].length < 25 || t.length < 12)) out[out.length - 1] += " " + t;
    else out.push(t);
  }
  return out;
}
function deferParts(s, parts) {
  s.audio ||= new Map();
  if (s.audio.size > 200) s.audio.clear();
  const list = [];
  for (const p of parts) {
    if (!p.text || !p.text.trim()) continue;
    for (const text of splitSentences(p.text)) {
      const id = String(++s.audioSeq || (s.audioSeq = 1));
      s.audio.set(id, speak(text, p.lang).catch((err) => {
        console.error("TTS xatosi:", err?.message || err);
        return null;
      }));
      list.push({ lang: p.lang, text, id, audio: null });
    }
  }
  return list;
}
const voiceParts = (req, s, parts) => (req.query.fast === "1" && voiceEnabled ? deferParts(s, parts) : speakParts(parts));

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ALLOW_DEV = process.env.ALLOW_DEV === "1"; // Telegram'siz brauzerda sinash uchun
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 10);
const DAILY_SESSIONS = Number(process.env.DAILY_SESSIONS || 0); // 0 = cheksiz (kunlik limit yo'q)
const MAX_TURNS = 60;

if (!BOT_TOKEN && !ALLOW_DEV) {
  console.error("BOT_TOKEN kerak (.env faylga yozing) yoki sinov uchun ALLOW_DEV=1 qo'ying");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// ---- Xotiradagi sessiyalar ----
const sessions = new Map(); // id -> { userId, lessonId, messages, used:Set, turns, expiresAt }
const daily = new Map(); // `${userId}:${sana}` -> soni

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt + 60_000 < now) sessions.delete(id);
  const today = new Date().toISOString().slice(0, 10);
  for (const key of daily.keys()) if (!key.endsWith(today)) daily.delete(key);
}, 60_000).unref();

// ---- Telegram orqali kirishni tekshirish ----
function auth(req, res, next) {
  const user = verifyInitData(req.get("X-Telegram-Init-Data"), BOT_TOKEN);
  if (user) {
    req.userId = String(user.id);
    return next();
  }
  if (ALLOW_DEV) {
    req.userId = "dev";
    return next();
  }
  res.status(401).json({ error: "Iltimos, ilovani Telegram bot orqali oching." });
}

function getSession(req, res) {
  const s = sessions.get(String(req.query.session || req.body?.session || ""));
  if (!s || s.userId !== req.userId) {
    res.status(404).json({ error: "Sessiya topilmadi. Darsni qaytadan boshlang." });
    return null;
  }
  if (Date.now() > s.expiresAt) {
    res.status(410).json({ error: "Dars vaqti tugadi." });
    return null;
  }
  return s;
}

function sendError(res, err) {
  console.error(err);
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: "Hozir juda ko'p so'rov bor. Birozdan keyin urinib ko'ring." });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: "AI xizmatida xatolik. Qaytadan urinib ko'ring." });
  }
  res.status(500).json({ error: "Serverda xatolik yuz berdi." });
}

// ---- API ----
app.get("/api/lessons", (req, res) => {
  res.json({ lessons: LESSONS.map(publicLesson), voiceEnabled, sessionMinutes: SESSION_MINUTES });
});

app.post("/api/session", express.json(), auth, async (req, res) => {
  const lesson = getLesson(String(req.body?.lessonId || ""));
  if (!lesson) return res.status(400).json({ error: "Bunday dars yo'q." });

  const key = `${req.userId}:${new Date().toISOString().slice(0, 10)}`;
  const count = daily.get(key) || 0;
  if (req.userId !== "dev" && DAILY_SESSIONS > 0 && count >= DAILY_SESSIONS) {
    return res.status(429).json({ error: `Bugungi limit tugadi (${DAILY_SESSIONS} ta dars). Ertaga davom etamiz!` });
  }
  daily.set(key, count + 1);

  // "tutor" - o'zbekcha ustoz (standart), "chat" - inglizcha suhbat, "free" - erkin suhbat
  const mode = lesson.free ? "free" : req.body?.mode === "chat" ? "chat" : "tutor";
  const id = crypto.randomUUID();
  sessions.set(id, {
    userId: req.userId,
    lessonId: lesson.id,
    messages: [],
    used: new Set(),
    turns: 0,
    mode,
    current: 0,
    expiresAt: Date.now() + SESSION_MINUTES * 60_000,
  });

  try {
    if (mode === "free") {
      const say = [{ lang: "uz", text: lesson.opener }];
      const parts = await voiceParts(req, sessions.get(id), say);
      return res.json({ session: id, mode, lesson: publicLesson(lesson), seconds: SESSION_MINUTES * 60, reply: lesson.opener, reply_uz: "", parts });
    }
    if (mode === "tutor") {
      const say = tutorOpener(lesson);
      const parts = await voiceParts(req, sessions.get(id), say);
      return res.json({
        session: id,
        mode,
        lesson: publicLesson(lesson),
        seconds: SESSION_MINUTES * 60,
        reply: say.map((x) => x.text).join(" "),
        reply_uz: "",
        current: 0,
        parts,
      });
    }
    const tr = req.body?.translate !== false;
    const parts = await voiceParts(req, sessions.get(id), [
      { lang: "en", text: lesson.opener },
      ...(tr ? [{ lang: "uz", text: lesson.openerUz }] : []),
    ]);
    res.json({
      session: id,
      mode,
      lesson: publicLesson(lesson),
      seconds: SESSION_MINUTES * 60,
      reply: lesson.opener,
      reply_uz: lesson.openerUz,
      parts,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// O'quvchi gapi: audio (Content-Type: audio/*) yoki JSON {text}
app.post(
  "/api/turn",
  express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "8mb" }),
  express.json(),
  auth,
  async (req, res) => {
    const s = getSession(req, res);
    if (!s) return;
    if (s.busy) return res.status(409).json({ error: "Oldingi javob hali tayyorlanmoqda." });
    if (s.turns >= MAX_TURNS) return res.status(429).json({ error: "Bu darsda gaplar soni tugadi." });

    const lesson = getLesson(s.lessonId);
    s.busy = true;
    try {
      let text = "";
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        if (req.body.length < 1500) return res.json({ heard: "", empty: true });
        text = await transcribe(req.body, req.get("Content-Type") || "audio/webm", lesson);
      } else if (typeof req.body?.text === "string") {
        text = req.body.text.trim().slice(0, 500);
      }
      if (!text) return res.json({ heard: "", empty: true });

      s.turns += 1;
      if (s.mode === "free") {
        const t = await freeTurn(s, lesson, text);
        const parts = await voiceParts(req, s, t.say);
        return res.json({ heard: text, reply: t.say.map((x) => x.text).join(" "), reply_uz: "", uz_say: "", used_phrases: [], mood: t.mood, used: [], parts });
      }
      if (s.mode === "tutor") {
        const t = await tutorTurn(s, lesson, text);
        for (const i of t.used_phrases) s.used.add(i);
        s.current = t.current;
        const parts = await voiceParts(req, s, t.say);
        return res.json({
          heard: text,
          reply: t.say.map((x) => x.text).join(" "),
          reply_uz: "",
          uz_say: "",
          used_phrases: t.used_phrases,
          current: t.current,
          mood: t.mood,
          used: [...s.used].sort((a, b) => a - b),
          parts,
        });
      }

      const result = await chatTurn(s, lesson, text);
      for (const i of result.used_phrases) s.used.add(i);
      // Tartib: o'zbekcha izoh -> inglizcha javob -> (ixtiyoriy) o'zbekcha tarjima
      const tr = req.query.tr !== "0";
      const parts = await voiceParts(req, s, [
        { lang: "uz", text: result.uz_say },
        { lang: "en", text: result.reply },
        ...(tr ? [{ lang: "uz", text: result.reply_uz }] : []),
      ]);

      res.json({
        heard: text,
        ...result,
        used: [...s.used].sort((a, b) => a - b),
        parts,
      });
    } catch (err) {
      sendError(res, err);
    } finally {
      s.busy = false;
    }
  },
);

// ⚡ Bitta bo'lakning ovozi (tayyor bo'lishini kutadi)
app.get("/api/audio", auth, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const job = s.audio?.get(String(req.query.id || ""));
  if (!job) return res.status(404).json({ error: "Ovoz topilmadi." });
  const a = await job;
  s.audio.delete(String(req.query.id));
  res.json({ audio: a?.audio || null, mime: a?.mime || "audio/mpeg" });
});

app.post("/api/end", express.json(), auth, (req, res) => {
  const s = sessions.get(String(req.body?.session || ""));
  if (s && s.userId === req.userId) sessions.delete(String(req.body.session));
  res.json({ ok: true, used: s ? [...s.used] : [] });
});

// Telegram WebView eski fayllarni keshda ushlab qolmasligi uchun har safar yangiligini tekshiradi
app.use(
  express.static(path.join(here, "public"), {
    extensions: ["html"],
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

app.listen(PORT, () => {
  console.log(`Sado speaking ishga tushdi: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Diqqat: ANTHROPIC_API_KEY yo'q - AI suhbatdosh javob bera olmaydi.");
  if (!voiceEnabled) console.warn("Diqqat: OPENAI_API_KEY yo'q - ovozni tanish ishlamaydi, faqat yozma rejim.");
});
