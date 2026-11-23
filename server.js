import "./src/env.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { LESSONS, getLesson, publicLesson } from "./src/lessons.js";
import { verifyInitData } from "./src/telegram.js";
import { WebSocketServer } from "ws";
import { liveEnabled, runLive } from "./src/live.js";
import { chatTurn, tutorTurn, tutorOpener, transcribe, speakParts, voiceEnabled, lessonReport, suggestReplies, ttsStats } from "./src/ai.js";
import { recordSession, touchDay, summary, adminStats, startedToday, countStart, refundStart, startsTodayTotal, deleteUser } from "./src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ALLOW_DEV = process.env.ALLOW_DEV === "1"; // Telegram'siz brauzerda sinash uchun
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 10);
const DAILY_SESSIONS = Number(process.env.DAILY_SESSIONS || 10);
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


setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt + 60_000 >= now) continue;
    sessions.delete(id);
    // 📝 "Tugatish" bosilmay yopilgan dars: o'quvchi gapirgan bo'lsa, progress (seriya, daqiqalar) baribir yoziladi.
    // AI hisobot so'ralmaydi — ball ishlatilgan iboralar ulushidan hisoblanadi.
    if (!s.ended && s.transcript.some((t) => t.who === "student" && t.text.trim())) {
      try {
        const lesson = lessonOf(s);
        const secs = (Math.min(now, s.expiresAt) - s.startedAt) / 1000;
        // Iborasiz (erkin) suhbatda ball hisoblab bo'lmaydi — lekin seriya va daqiqalar saqlanadi
        if (!lesson?.phrases?.length || lesson.liveOnly) {
          touchDay(s.userId, secs);
          continue;
        }
        recordSession(s.userId, {
          lessonId: s.lessonId,
          mode: s.mode,
          used: s.used.size,
          total: lesson.phrases.length,
          seconds: (Math.min(now, s.expiresAt) - s.startedAt) / 1000,
          report: null,
        });
      } catch (e) {
        console.error("Yopilgan darsni yozib bo'lmadi:", e?.message || e);
      }
    }
  }
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

// 🔁 Shaxsiy dars: o'quvchining saqlangan xatolaridan tuziladi
function reviewLesson(userId) {
  const fixes = (summary(userId).words || []).filter((w) => w.type === "fix" && w.en).slice(0, 6);
  if (fixes.length < 2) return null;
  return {
    id: "review",
    category: "Shaxsiy",
    title: "Xatolarim ustida ishlash",
    emoji: "🔁",
    level: "Shaxsiy",
    role: "a kind personal English tutor reviewing the student's own past mistakes",
    situation: `Help the student fix their own past mistakes. For each one, show the wrong version, explain briefly in Uzbek, and have them say the correct sentence and then use it in a new sentence of their own. Past mistakes: ${fixes.map((f) => `"${f.wrong}" -> "${f.en}"`).join("; ")}.`,
    opener: `Let's practise the sentences you found tricky before. First: how do we say this correctly — "${fixes[0].wrong}"?`,
    openerUz: "Keling, avval qiynalgan gaplaringizni mashq qilamiz.",
    phrases: fixes.map((f) => ({ en: f.en, uz: f.wrong ? `Xato edi: ${f.wrong}` : f.uz })),
  };
}
const lessonOf = (s) => s.custom || getLesson(s.lessonId);

// ---- API ----
app.get("/api/lessons", (req, res) => {
  res.json({ lessons: LESSONS.map(publicLesson), voiceEnabled, liveEnabled, sessionMinutes: SESSION_MINUTES, shareUrl: process.env.SHARE_URL || "" });
});

app.post("/api/session", express.json(), auth, async (req, res) => {
  const lesson = String(req.body?.lessonId) === "review" ? reviewLesson(req.userId) : getLesson(String(req.body?.lessonId || ""));
  if (!lesson)
    return res.status(400).json({
      error: req.body?.lessonId === "review" ? "Hali xatolar yetarli emas — avval bir nechta dars o'ting." : "Bunday dars yo'q.",
    });

  const count = startedToday(req.userId);
  if (req.userId !== "dev" && count >= DAILY_SESSIONS) {
    return res.status(429).json({ error: `Bugungi limit tugadi (${DAILY_SESSIONS} ta dars). Ertaga davom etamiz!` });
  }
  countStart(req.userId);

  // "tutor" - o'zbekcha ustoz (standart), "chat" - inglizcha suhbat
  const wanted = req.body?.mode;
  const mode = wanted === "chat" ? "chat" : wanted === "live" && liveEnabled ? "live" : "tutor";
  const id = crypto.randomUUID();
  sessions.set(id, {
    userId: req.userId,
    lessonId: lesson.id,
    messages: [],
    used: new Set(),
    turns: 0,
    mode,
    current: 0,
    transcript: [],
    custom: lesson.id === "review" ? lesson : null,
    slow: Boolean(req.body?.slow),
    selfLevel: ["beg", "mid", "adv"].includes(req.body?.level) ? req.body.level : "",
    startedAt: Date.now(),
    expiresAt: Date.now() + (lesson.minutes || SESSION_MINUTES) * 60_000,
  });

  try {
    if (mode === "live") {
      // Jonli suhbat: ovoz WebSocket orqali (/api/live) keladi
      return res.json({ session: id, mode, lesson: publicLesson(lesson), seconds: (lesson.minutes || SESSION_MINUTES) * 60 });
    }
    if (mode === "tutor") {
      const say = tutorOpener(lesson);
      const parts = await speakParts(say, { slow: Boolean(req.body?.slow) });
      return res.json({
        session: id,
        mode,
        lesson: publicLesson(lesson),
        seconds: (lesson.minutes || SESSION_MINUTES) * 60,
        reply: say.map((x) => x.text).join(" "),
        reply_uz: "",
        say,
        current: 0,
        parts,
      });
    }
    const tr = req.body?.translate !== false;
    const parts = await speakParts([
      { lang: "en", text: lesson.opener },
      ...(tr ? [{ lang: "uz", text: lesson.openerUz }] : []),
    ], { slow: Boolean(req.body?.slow) });
    res.json({
      session: id,
      mode,
      lesson: publicLesson(lesson),
      seconds: (lesson.minutes || SESSION_MINUTES) * 60,
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

    const lesson = lessonOf(s);
    if (req.query.slow !== undefined) s.slow = req.query.slow === "1";
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
      if (s.mode === "tutor") {
        const t = await tutorTurn(s, lesson, text);
        s.transcript.push({ who: "student", text }, { who: "sado", text: t.say.map((x) => x.text).join(" ") });
        for (const i of t.used_phrases) s.used.add(i);
        s.current = t.current;
        const parts = await speakParts(t.say, { slow: s.slow });
        return res.json({
          heard: text,
          reply: t.say.map((x) => x.text).join(" "),
          reply_uz: "",
          say: t.say,
          uz_say: "",
          used_phrases: t.used_phrases,
          current: t.current,
          mood: t.mood,
          used: [...s.used].sort((a, b) => a - b),
          parts,
        });
      }

      const result = await chatTurn(s, lesson, text);
      s.transcript.push({ who: "student", text }, { who: "sado", text: result.reply });
      for (const i of result.used_phrases) s.used.add(i);
      // Tartib: o'zbekcha izoh -> inglizcha javob -> (ixtiyoriy) o'zbekcha tarjima
      const tr = req.query.tr !== "0";
      const parts = await speakParts([
        { lang: "uz", text: result.uz_say },
        { lang: "en", text: result.reply },
        ...(tr ? [{ lang: "uz", text: result.reply_uz }] : []),
      ], { slow: s.slow });

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

app.post("/api/end", express.json(), auth, async (req, res) => {
  const id = String(req.body?.session || "");
  const s = sessions.get(id);
  if (!s || s.userId !== req.userId) return res.json({ ok: true, used: [], report: null, progress: summary(req.userId) });
  sessions.delete(id);
  if (s.ended) return res.json({ ok: true, used: [...s.used], report: null, progress: summary(req.userId) });
  s.ended = true;
  const lesson = lessonOf(s);
  const used = s.used.size;
  const total = lesson.phrases.length;
  // Hech narsa gapirilmagan bo'lsa: hisobot so'ralmaydi (AI xarajati yo'q), kunlik limit qaytariladi
  const spoke = s.transcript.some((t) => t.who === "student" && t.text.trim());
  if (!spoke) {
    if (!s.refunded) {
      s.refunded = true;
      refundStart(req.userId);
    }
    return res.json({ ok: true, empty: true, used: [], score: null, report: null, progress: summary(req.userId), transcript: [] });
  }
  let report = null;
  try {
    if (process.env.ANTHROPIC_API_KEY) report = await lessonReport(lesson, s.transcript, { used, total, mode: s.mode });
  } catch (err) {
    console.error("Hisobot xatosi:", err?.message || err);
  }
  const score = recordSession(req.userId, {
    lessonId: s.lessonId,
    mode: s.mode,
    used,
    total,
    seconds: (Date.now() - s.startedAt) / 1000,
    report,
  });
  res.json({ ok: true, used: [...s.used], score, report, progress: summary(req.userId), transcript: s.transcript.slice(-60) });
});

// 🔊 Iborani to'g'ri talaffuz bilan eshittirish (faqat darslardagi iboralar, keshlanadi)
const PHRASES = new Set(LESSONS.flatMap((l) => l.phrases.map((p) => p.en)));
const sayCache = new Map();
app.get("/api/say", auth, async (req, res) => {
  const text = String(req.query.text || "");
  if (!PHRASES.has(text)) return res.status(400).json({ error: "Noma'lum ibora" });
  const slow = req.query.slow === "1";
  const key = (slow ? "slow:" : "") + text;
  try {
    if (!sayCache.has(key)) {
      const [part] = await speakParts([{ lang: "en", text: text.replace(/\.\.\./g, "something") }], { slow });
      if (!part?.audio) return res.status(503).json({ error: "Ovoz xizmati ishlamayapti" });
      sayCache.set(key, part);
      if (sayCache.size > 400) sayCache.delete(sayCache.keys().next().value);
    }
    res.json(sayCache.get(key));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/hint", express.json(), auth, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  s.hints = (s.hints || 0) + 1;
  if (s.hints > 20) return res.status(429).json({ error: "Bu darsda yordam soni tugadi." });
  const lastSado = [...s.transcript].reverse().find((t) => t.who === "sado")?.text;
  try {
    res.json({ hints: await suggestReplies(lessonOf(s), lastSado, s.used) });
  } catch (err) {
    sendError(res, err);
  }
});

// 📊 Admin statistikasi: /admin.html?key=ADMIN_KEY (kalit .env da)
app.get("/api/admin/stats", (req, res) => {
  const key = process.env.ADMIN_KEY || "";
  const given = String(req.get("X-Admin-Key") || req.query.key || "");
  const ok = key.length >= 8 && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) return res.status(403).json({ error: "Ruxsat yo'q" });
  const s = adminStats();
  s.top = s.top.map(([id, n]) => ({ id, n, title: getLesson(id)?.title || id, emoji: getLesson(id)?.emoji || "" }));
  s.liveNow = [...sessions.values()].filter((x) => Date.now() < x.expiresAt).length;
  s.startsToday = startsTodayTotal();
  s.ttsCache = ttsStats;
  res.json(s);
});

app.delete("/api/progress", auth, (req, res) => {
  deleteUser(req.userId);
  res.json({ ok: true });
});

app.get("/api/progress", auth, (req, res) => {
  const used = startedToday(req.userId);
  res.json({ ...summary(req.userId), limit: req.userId === "dev" ? 0 : DAILY_SESSIONS, startedToday: used });
});

// Telegram WebView eski fayllarni keshda ushlab qolmasligi uchun har safar yangiligini tekshiradi
app.use(
  express.static(path.join(here, "public"), {
    extensions: ["html"],
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

const server = app.listen(PORT, () => {
  console.log(`Sado speaking ishga tushdi: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Diqqat: ANTHROPIC_API_KEY yo'q - AI suhbatdosh javob bera olmaydi.");
  if (!voiceEnabled) console.warn("Diqqat: OPENAI_API_KEY yo'q - ovozni tanish ishlamaydi, faqat yozma rejim.");
});

// ---- 📞 Jonli suhbat (WebSocket) ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/live") return socket.destroy();
  const user = verifyInitData(url.searchParams.get("init") || "", BOT_TOKEN);
  const userId = user ? String(user.id) : ALLOW_DEV ? "dev" : null;
  const s = sessions.get(url.searchParams.get("session") || "");
  if (!userId || !s || s.userId !== userId || s.mode !== "live" || s.liveStarted || Date.now() > s.expiresAt) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  s.liveStarted = true; // bitta sessiya - bitta ulanish
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Sado umuman ulanmagan bo'lsa: kunlik limit qaytariladi, sessiya yopiladi
    ws.on("close", () => {
      if (s.liveReady || s.refunded) return;
      s.refunded = true;
      refundStart(s.userId);
      sessions.delete(url.searchParams.get("session") || "");
    });
    runLive(ws, s, lessonOf(s), { maxMs: s.expiresAt - Date.now(), voice: url.searchParams.get("voice"), topic: url.searchParams.get("topic") }).catch((e) => {
      console.error("Jonli suhbat xatosi:", e);
      try { ws.close(); } catch {}
    });
  });
});
