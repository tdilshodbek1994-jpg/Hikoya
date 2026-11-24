import "./src/env.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { LESSONS, getLesson, publicLesson } from "./src/lessons.js";
import { verifyInitData } from "./src/telegram.js";
import { WebSocketServer } from "ws";
import { liveEnabled, runLive, liveStats, toLatin } from "./src/live.js";
import { chatTurn, tutorTurn, freeTurn, FREE_OPENER, FREE_CONT_OPENER, deferParts, tutorOpener, transcribe, speakParts, voiceEnabled, lessonReport, suggestReplies, translateUz, sampleAnswer, samplePhrases, samplePhraseUz, sampleStats, sampleCount, ttsStats } from "./src/ai.js";
import { recordSession, touchDay, summary, adminStats, startedToday, countStart, refundStart, startsTodayTotal, deleteUser, markFixed, addWord, removeWord, setRemind, remindTargets, markReminded } from "./src/store.js";

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

// 🔤 Inglizcha so'zlarni sanash: o'zbekcha (lotin) gaplar ham A–Z harflarda yoziladi, shuning uchun gap
// inglizcha ekanini tez-tez uchraydigan inglizcha so'zlar ulushidan aniqlaymiz; o'zbekcha gap — 0 so'z
const EN_COMMON = new Set("i you he she it we they me my your his her our their is am are was were be been being do does did have has had can could will would should may might must a an the to of in on at for with from by and or but not no yes this that these those what where when why how who which like love want go going get got make know think good very really so too also just about some any there here because if than then all more much many one two time day people thing things please thank thanks hello hi okay ok well sure let's lets i'm don't it's that's i'd i'll can't didn't name favourite favorite play playing study work school english learn".split(" "));
function enWordCount(text) {
  // gapma-gap: aralash gapda ("Salom! I love football") faqat inglizcha qismi sanaladi
  return String(text || "").split(/[.!?;\n]+/).reduce((n, part) => {
    const t = part.toLowerCase().match(/[a-z']+/g) || [];
    if (!t.length) return n;
    const hits = t.filter((w) => EN_COMMON.has(w)).length;
    return n + (hits / t.length >= 0.25 || (t.length <= 2 && hits >= 1) ? t.length : 0);
  }, 0);
}

// 💬 Erkin suhbat statistikasi (admin uchun): AI javob vaqti va xatolar — sekinlik yoki "qotish"ni ko'rish uchun
const freeStats = { turns: 0, totalMs: 0, maxMs: 0, slow: 0, errors: 0, recent: [], lastErrors: [] };
function noteFree(ms) {
  freeStats.turns++;
  freeStats.totalMs += ms;
  freeStats.maxMs = Math.max(freeStats.maxMs, ms);
  if (ms > 7000) freeStats.slow++;
  freeStats.recent.unshift(ms);
  freeStats.recent.length = Math.min(freeStats.recent.length, 20);
}

// ⚡ fast=1 bo'lsa: ovoz keyin, gapma-gap (/api/audio) — matn darhol qaytadi
const voiceParts = (req, s, parts, opts = {}) => {
  const o = { ...opts, voice: s?.voice || "f" }; // 🗣 o'quvchi tanlagan Sado ovozi
  return req.query.fast === "1" && voiceEnabled && s ? deferParts(s, parts, o) : speakParts(parts, o);
};

function getSession(req, res) {
  const s = sessions.get(String(req.query.session || req.body?.session || ""));
  if (!s || s.userId !== req.userId) {
    res.status(404).json({ error: "Sessiya topilmadi. Qaytadan boshlang." });
    return null;
  }
  if (Date.now() > s.expiresAt) {
    res.status(410).json({ error: "Vaqt tugadi. Qaytadan boshlang." });
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
  // Hali tuzatilmagan xatolar birinchi navbatda
  const all = (summary(userId).words || []).filter((w) => w.type === "fix" && w.en);
  const fixes = [...all.filter((w) => !w.fixed), ...all.filter((w) => w.fixed)].slice(0, 6);
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
// Darslar ro'yxati server ishlaguncha o'zgarmaydi — bir marta tayyorlab, siqib qo'yamiz (~80 KB → ~15 KB)
let lessonsCache = null;
// 🏷 Server versiyasi (git commit + sana) — ilovada «⚙️ Sozlamalar» ostida ko'rinadi
let APP_VERSION = "", APP_UPDATED = "";
try {
  const head = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".git", "HEAD"), "utf8").trim();
  const gitDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".git");
  const ref = head.startsWith("ref:") ? head.slice(5).trim() : "";
  let sha = head;
  if (ref) {
    try { sha = fs.readFileSync(path.join(gitDir, ref), "utf8").trim(); }
    catch { sha = (fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(" " + ref)) || "").split(" ")[0]; }
  }
  APP_VERSION = sha.slice(0, 7);
  // Yangilanish vaqti: update-sado.sh (git reset) HEAD/ref faylini yangilaydi — shu vaqt (Toshkent)
  const refFile = ref && fs.existsSync(path.join(gitDir, ref)) ? path.join(gitDir, ref) : path.join(gitDir, "HEAD");
  const t = new Date(Math.max(fs.statSync(refFile).mtimeMs, fs.statSync(path.join(gitDir, "HEAD")).mtimeMs) + 5 * 3600_000);
  APP_UPDATED = `${String(t.getUTCDate()).padStart(2, "0")}.${String(t.getUTCMonth() + 1).padStart(2, "0")} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
} catch {}
// Ilova versiyasi (index.html dagi app.js?v=...) — telefondagi eski nusxa o'zini yangilashi uchun
const appBuild = () => { try { return Number((fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "index.html"), "utf8").match(/app\.js\?v=(\d+)/) || [])[1]) || 0; } catch { return 0; } };
app.get("/api/version", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ version: APP_VERSION, updated: APP_UPDATED, build: appBuild() }); });

// 🧹 Telefonda keshda qolib ketgan ESKI ilova (X-Sado-Build yubormaydi) — brauzerga keshni tozalashni
// buyuramiz: keyingi ochilishda yangi versiya yuklanadi. (Faqat HTTP kesh; localStorage, kirish ma'lumotlari saqlanadi)
const clearStale = (req, res) => { if (!req.get("X-Sado-Build")) res.setHeader("Clear-Site-Data", '"cache"'); };

// 💬 Faqat Erkin suhbat ko'rsatiladi (darslar yashirin). Hamma darslarni qaytarish: .env ga FREE_ONLY=0
const FREE_ONLY = process.env.FREE_ONLY !== "0";

app.get("/api/lessons", (req, res) => {
  clearStale(req, res);
  if (!lessonsCache) {
    const body = Buffer.from(JSON.stringify({ lessons: (FREE_ONLY ? LESSONS.filter((l) => l.liveOnly) : LESSONS).map(publicLesson), freeOnly: FREE_ONLY, voiceEnabled, liveEnabled, sessionMinutes: SESSION_MINUTES, shareUrl: process.env.SHARE_URL || "", version: APP_VERSION, updated: APP_UPDATED }));
    lessonsCache = { body, gz: zlib.gzipSync(body, { level: 9 }), etag: `"l-${crypto.createHash("sha1").update(body).digest("hex").slice(0, 16)}"` };
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("ETag", lessonsCache.etag);
  if (req.headers["if-none-match"] === lessonsCache.etag) return res.status(304).end();
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.setHeader("Content-Encoding", "gzip");
    return res.end(lessonsCache.gz);
  }
  res.end(lessonsCache.body);
});

app.post("/api/session", express.json(), auth, async (req, res) => {
  const lesson = String(req.body?.lessonId) === "review" ? reviewLesson(req.userId) : getLesson(String(req.body?.lessonId || ""));
  if (!lesson)
    return res.status(400).json({
      error: req.body?.lessonId === "review" ? "Hali xatolar yetarli emas — avval bir nechta dars o'ting." : "Bunday dars yo'q.",
    });

  const count = startedToday(req.userId);
  if (req.userId !== "dev" && DAILY_SESSIONS > 0 && count >= DAILY_SESSIONS) {
    return res.status(429).json({ error: `Bugungi limit tugadi (${DAILY_SESSIONS} ta dars). Ertaga davom etamiz!` });
  }
  countStart(req.userId);

  // "tutor" - o'zbekcha ustoz (standart), "chat" - inglizcha suhbat
  const wanted = req.body?.mode;
  const mode = wanted === "live" && liveEnabled ? "live" : lesson.free ? "free" : wanted === "chat" ? "chat" : "tutor";
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
    voice: req.body?.voice === "m" ? "m" : "f",
    selfLevel: ["beg", "mid", "adv"].includes(req.body?.level) ? req.body.level : "",
    startedAt: Date.now(),
    expiresAt: Date.now() + (lesson.minutes || SESSION_MINUTES) * 60_000,
  });

  try {
    if (mode === "live") {
      // Jonli suhbat: ovoz WebSocket orqali (/api/live) keladi
      return res.json({ session: id, mode, lesson: publicLesson(lesson), seconds: (lesson.minutes || SESSION_MINUTES) * 60 });
    }
    if (mode === "free") {
      // 💬 Erkin suhbat (jonli qo'ng'iroqsiz): Sado salomlashib, mavzuni o'quvchidan so'raydi.
      // ↩️ «Davom ettirish»: oldingi suhbatning oxirgi qismi (o'quvchi telefonidan) — Sado shu joydan davom etadi
      const ctx = Array.isArray(req.body?.context) ? req.body.context.slice(-8) : [];
      const recap = ctx
        .filter((t) => t && typeof t.text === "string" && t.text.trim())
        .map((t) => `${t.who === "student" ? "STUDENT" : "SADO"}: ${t.text.replace(/\s+/g, " ").trim().slice(0, 200)}`)
        .join("\n")
        .slice(0, 1500);
      const opener = recap.includes("STUDENT:") ? FREE_CONT_OPENER : FREE_OPENER;
      if (opener === FREE_CONT_OPENER) sessions.get(id).recap = recap;
      const say = [{ lang: "uz", text: opener }];
      sessions.get(id).transcript.push({ who: "sado", text: opener });
      const parts = await voiceParts(req, sessions.get(id), say, { slow: Boolean(req.body?.slow) });
      return res.json({ session: id, mode, lesson: publicLesson(lesson), seconds: (lesson.minutes || SESSION_MINUTES) * 60, reply: opener, reply_uz: "", say, parts });
    }
    if (mode === "tutor") {
      const say = tutorOpener(lesson);
      // 📜 Sado birinchi gapi ham suhbat matnida (hisobot va «Suhbat matni» uchun)
      sessions.get(id).transcript.push({ who: "sado", text: say.map((x) => x.text).join(" ") });
      const parts = await voiceParts(req, sessions.get(id), say, { slow: Boolean(req.body?.slow) });
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
    sessions.get(id).transcript.push({ who: "sado", text: lesson.opener });
    const tr = req.body?.translate !== false;
    const parts = await voiceParts(req, sessions.get(id), [
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
    if (req.query.voice) s.voice = req.query.voice === "m" ? "m" : "f"; // 🗣 suhbat o'rtasida ovoz almashtirilsa ham
    s.busy = true;
    try {
      let text = "";
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        if (req.body.length < 1500) return res.json({ heard: "", empty: true });
        // 🔤 O'zbekcha nutq ba'zan kirillda tanib olinadi — ilova lotin yozuvida ishlaydi
        text = toLatin(await transcribe(req.body, req.get("Content-Type") || "audio/webm", lesson));
      } else if (typeof req.body?.text === "string") {
        text = req.body.text.trim().slice(0, 500);
      }
      if (!text) return res.json({ heard: "", empty: true });

      s.turns += 1;
      if (s.mode === "free") {
        const tStart = Date.now();
        const t = await freeTurn(s, lesson, text);
        noteFree(Date.now() - tStart);
        // 🔤 Sado javobidagi o'zbekcha qism ham doim lotinda bo'lsin (model ba'zan kirillda yozadi)
        t.say = t.say.map((x) => (x.lang === "uz" ? { ...x, text: toLatin(x.text) } : x));
        const reply = t.say.map((x) => x.text).join(" ");
        // 🔊 Sado aytgan inglizcha gaplarni pufakchadan bosib qayta eshitish mumkin bo'lsin
        s.sayable ||= new Set();
        for (const x of t.say) if (x.lang === "en") s.sayable.add(x.text);
        if (s.sayable.size > 300) s.sayable = new Set([...s.sayable].slice(-200));
        s.transcript.push({ who: "student", text }, { who: "sado", text: reply });
        const parts = await voiceParts(req, s, t.say, { slow: s.slow });
        return res.json({ heard: text, reply, reply_uz: "", say: t.say, uz_say: "", used_phrases: [], mood: t.mood, used: [], parts });
      }
      if (s.mode === "tutor") {
        const t = await tutorTurn(s, lesson, text);
        t.say = t.say.map((x) => (x.lang === "uz" ? { ...x, text: toLatin(x.text) } : x));
        s.sayable ||= new Set();
        for (const x of t.say) if (x.lang === "en") s.sayable.add(x.text);
        s.transcript.push({ who: "student", text }, { who: "sado", text: t.say.map((x) => x.text).join(" ") });
        for (const i of t.used_phrases) s.used.add(i);
        s.current = t.current;
        const parts = await voiceParts(req, s, t.say, { slow: s.slow });
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
      const parts = await voiceParts(req, s, [
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
      if (s.mode === "free") {
        freeStats.errors++;
        // 🩺 Oxirgi xatolar (admin): qachon va qisqa sababi — muammoni tez topish uchun (shaxsiy ma'lumotsiz)
        const at = new Date(Date.now() + 5 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
        freeStats.lastErrors.unshift(`${at} · ${String(err?.message || err).slice(0, 90)}`);
        freeStats.lastErrors.length = Math.min(freeStats.lastErrors.length, 8);
      }
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
  const key = String(req.query.id || "");
  const job = s.audio?.get(key);
  if (!job) return res.status(404).json({ error: "Ovoz topilmadi." });
  const a = await job;
  s.audio.delete(key);
  res.json({ audio: a?.audio || null, mime: a?.mime || "audio/mpeg" });
});

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
  // 🔁 Takrorlash darsida ishlatilgan (to'g'ri aytilgan) iboralar — tuzatilgan xato
  const fixedNow = s.lessonId === "review" ? markFixed(req.userId, [...s.used].map((i) => lesson.phrases[i]?.en).filter(Boolean)) : 0;
  const prevMaxWords = summary(req.userId).maxWords || 0;
  const words = s.transcript.filter((t) => t.who === "student").reduce((n, t) => n + enWordCount(t.text), 0);
  const score = recordSession(req.userId, {
    words,
    lessonId: s.lessonId,
    mode: s.mode,
    used,
    total,
    seconds: (Date.now() - s.startedAt) / 1000,
    report,
  });
  res.json({ ok: true, used: [...s.used], score, report, fixedNow, prevMaxWords, progress: summary(req.userId), transcript: s.transcript.slice(-60) });
});

// 🔊 Iborani to'g'ri talaffuz bilan eshittirish (faqat darslardagi iboralar, keshlanadi)
const PHRASES = new Set(LESSONS.flatMap((l) => l.phrases.map((p) => p.en)));
// Grammatika qoidalaridagi inglizcha misollar ham ovozga aylantirilishi mumkin
for (const l of LESSONS) for (const m of (l.rule || "").matchAll(/[A-Z][A-Za-z0-9' ,]*[A-Za-z0-9][.?!]/g)) if (m[0].split(" ").length >= 2) PHRASES.add(m[0]);
// IELTS Part 1/3 savollari va grammatika mashqining to'g'ri gaplari ham (ilova ularni eshittiradi)
for (const l of LESSONS) {
  const pub = publicLesson(l);
  for (const q of pub.questions || []) PHRASES.add(q);
  for (const q of pub.quiz || []) PHRASES.add(q.text.replace("___", q.answer === "—" ? "" : q.answer).replace(/\s+/g, " ").replace(/«[^»]*»\s*→\s*/, "").trim());
}
const sayCache = new Map();
// 🔊 Sozlamalardagi «Ovozni tekshirish»: o'zbekcha (Azure) va inglizcha ovozning qisqa namunasi
const SOUND_TEST = { uz: "Salom! Men Sado. Ovozim yaxshi eshitilyaptimi?", en: "Hello! I'm Sado. Nice to meet you." };
app.get("/api/say", auth, async (req, res) => {
  const test = SOUND_TEST[req.query.test];
  const text = test || String(req.query.text || "");
  const lang = req.query.test === "uz" ? "uz" : "en";
  // Faqat darslardagi iboralar yoki o'quvchining o'z lug'atidagi so'zlar (TTS xarajatini cheklash uchun)
  const own = () => text.length <= 120 && (summary(req.userId).words || []).some((w) => w.en === text);
  // Joriy darsda AI aytgan/taklif qilgan inglizcha gaplar (namunalar, ustoz misollari)
  const sess = sessions.get(String(req.query.session || ""));
  const inSession = () => sess && sess.userId === req.userId && sess.sayable?.has(text);
  if (!test && !PHRASES.has(text) && !own() && !inSession() && !samplePhrases().has(text)) return res.status(400).json({ error: "Noma'lum ibora" });
  const slow = req.query.slow === "1";
  const voice = req.query.voice === "m" ? "m" : "f";
  const key = (slow ? "slow:" : "") + voice + ":" + lang + ":" + text;
  try {
    if (!sayCache.has(key)) {
      const [part] = await speakParts([{ lang, text: text.replace(/\.\.\./g, "something") }], { slow, voice });
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
  featStats.hint++;
  if (s.hints > 20) return res.status(429).json({ error: "Bu darsda yordam soni tugadi." });
  const lastSado = [...s.transcript].reverse().find((t) => t.who === "sado")?.text;
  try {
    const hints = await suggestReplies(lessonOf(s), lastSado, s.used);
    // Shu sessiyada bu namunalarni Sado ovozida eshitish mumkin
    s.sayable ||= new Set();
    for (const h of hints || []) if (h?.en) s.sayable.add(String(h.en).slice(0, 200));
    res.json({ hints });
  } catch (err) {
    sendError(res, err);
  }
});

// 🇺🇿 Sado aytgan gapning tarjimasi — faqat shu sessiyada Sado aytgan gaplar uchun (bepul tarjimon bo'lib qolmasin)
const featStats = { translate: 0, hint: 0 }; // 📊 admin: yangi imkoniyatlardan foydalanish (server ishga tushgandan beri)
const normTr = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
app.post("/api/translate", express.json(), auth, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const text = String(req.body?.text || "").trim().slice(0, 600);
  const said = (s.transcript || []).filter((t) => t.who === "sado").map((t) => normTr(t.text));
  if (!text || !said.some((t) => t.includes(normTr(text)))) return res.status(400).json({ error: "Bu gap darsda aytilmagan" });
  s.translates = (s.translates || 0) + 1;
  featStats.translate++;
  if (s.translates > 40) return res.status(429).json({ error: "Bu darsda tarjima soni tugadi." });
  try {
    res.json({ uz: await translateUz(text) });
  } catch (err) {
    sendError(res, err);
  }
});

// 📒 Dars iborasini shaxsiy lug'atga saqlash (faqat darslardagi iboralar)
const PHRASE_UZ = new Map(LESSONS.flatMap((l) => l.phrases.map((p) => [p.en, p.uz])));
app.post("/api/word", express.json(), auth, (req, res) => {
  const en = String(req.body?.en || "");
  // Dars iboralari yoki namunaviy javobdagi foydali iboralar
  const uz = PHRASE_UZ.has(en) ? PHRASE_UZ.get(en) : samplePhraseUz(en);
  if (uz == null) return res.status(400).json({ error: "Noma'lum ibora" });
  const added = addWord(req.userId, en, uz);
  res.json({ ok: true, added, progress: summary(req.userId) });
});

app.delete("/api/word", express.json(), auth, (req, res) => {
  removeWord(req.userId, String(req.body?.en || ""));
  res.json({ ok: true, progress: summary(req.userId) });
});

// 📝 IELTS Part 2 namunaviy javobi (faqat kartochkali darslar; natija keshlanadi)
app.post("/api/sample", express.json(), auth, async (req, res) => {
  const lesson = getLesson(String(req.body?.lessonId || ""));
  const pub = lesson && publicLesson(lesson);
  // CEFR topshiriqlari (to'liq sinovdan tashqari) — topshiriq matni Sado ochilish gapidan olinadi
  const task = /^cefr-\d+$/.test(lesson?.id || "") && lesson.id !== "cefr-8" ? lesson.opener : null;
  if (!pub?.cue && !pub?.questions && !task) return res.status(400).json({ error: "Bu dars uchun namunaviy javob yo'q" });
  try {
    const out = await sampleAnswer(lesson.id, pub.cue, pub.questions, task);
    if (!out) return res.status(503).json({ error: "Namuna tayyorlab bo'lmadi" });
    res.json(out);
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
  s.reminders = { enabled: REMINDERS, ...remindStats };
  s.samples = { ready: sampleCount(), ...sampleStats };
  s.startsToday = startsTodayTotal();
  s.ttsCache = ttsStats;
  s.features = { ...featStats, topic: liveStats.topicSwitches };
  s.free = { turns: freeStats.turns, avgMs: freeStats.turns ? Math.round(freeStats.totalMs / freeStats.turns) : 0, maxMs: freeStats.maxMs, slow: freeStats.slow, errors: freeStats.errors, recent: freeStats.recent, lastErrors: freeStats.lastErrors };
  s.liveEnabled = liveEnabled;
  s.live = { calls: liveStats.calls, ready: liveStats.ready, ends: liveStats.ends, noReply: liveStats.noReply, nudges: liveStats.nudges, recent: liveStats.recent };
  res.json(s);
});

app.delete("/api/progress", auth, (req, res) => {
  deleteUser(req.userId);
  res.json({ ok: true });
});

// 🔔 Kechki eslatma (Telegram bot orqali). Standart holatda o'chiq: .env da REMINDERS=1 bo'lsa ishlaydi.
const REMINDERS = process.env.REMINDERS === "1" && Boolean(BOT_TOKEN);
const REMIND_HOUR = Number(process.env.REMIND_HOUR || 20); // Toshkent vaqti
const TG_API = process.env.TELEGRAM_API || "https://api.telegram.org";
app.post("/api/remind", express.json(), auth, (req, res) => {
  if (!REMINDERS) return res.status(400).json({ error: "Eslatmalar serverda yoqilmagan" });
  setRemind(req.userId, req.body?.on, Number(req.body?.hour));
  res.json({ ok: true, remind: Boolean(req.body?.on) });
});
const remindStats = { sent: 0, off: 0 };
// 🌟 Kun iborasi — ilovadagi bilan bir xil hisoblanadi (Toshkent kuni bo'yicha)
function dailyPhrase() {
  const pool = LESSONS.filter((l) => !l.liveOnly).flatMap((l) => l.phrases.filter((p) => !p.en.includes("...")));
  const dayNo = Math.floor((Date.now() + 5 * 3600_000) / 86400_000);
  // Ilovadagi dailyPick bilan bir xil: "kun|ibora" FNV-1a xeshi eng kichigi
  const hash = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  let best = null, bestH = Infinity;
  for (const p of pool) {
    const h = hash(`${dayNo}|${p.en}`);
    if (h < bestH) (bestH = h), (best = p);
  }
  return best;
}
async function sendReminders() {
  const hour = new Date(Date.now() + 5 * 3600_000).getUTCHours();
  for (const t of remindTargets(hour, REMIND_HOUR)) {
    markReminded(t.id); // xato bo'lsa ham qayta-qayta yubormaymiz
    const body = {
      chat_id: t.id,
      text: `🔥 Sizda ${t.streak} kunlik seriya bor! Bugun hali Sado bilan gaplashmadingiz — 5 daqiqalik bitta dars seriyani saqlab qoladi 💪${(() => { const d = dailyPhrase(); return d ? `\n\n🌟 Kun iborasi: ${d.en}\n🇺🇿 ${d.uz}` : ""; })()}`,
    };
    if (process.env.WEBAPP_URL) body.reply_markup = { inline_keyboard: [[{ text: "🎤 Darsni boshlash", web_app: { url: process.env.WEBAPP_URL } }]] };
    try {
      const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      remindStats.sent += j.ok ? 1 : 0;
      // Bot bloklangan yoki chat yo'q — bu o'quvchiga boshqa urinmaymiz
      if (!j.ok && (j.error_code === 403 || j.error_code === 400)) {
        setRemind(t.id, false);
        remindStats.off++;
      }
    } catch (e) {
      console.error("Eslatma yuborilmadi:", e?.message || e);
    }
    await new Promise((r) => setTimeout(r, 60)); // Telegram limitlariga rioya
  }
}
if (REMINDERS) {
  setInterval(sendReminders, 10 * 60_000).unref();
  setTimeout(sendReminders, 60_000).unref(); // server qayta yoqilganda ham o'tkazib yubormaslik uchun
  console.log(`🔔 Kechki eslatmalar yoqilgan (soat ${REMIND_HOUR}:00, Toshkent)`);
}

app.get("/api/progress", auth, (req, res) => {
  clearStale(req, res);
  const used = startedToday(req.userId);
  res.json({ ...summary(req.userId), limit: req.userId === "dev" || DAILY_SESSIONS <= 0 ? 0 : DAILY_SESSIONS, startedToday: used, remindAvailable: REMINDERS, remindDefault: REMIND_HOUR });
});

// ⚡ Gzip: JS/CSS/HTML ~4 marta kichikroq yuboriladi (sekin mobil internet uchun).
// "?v=..." versiyali fayllar uzoq keshlanadi — versiya o'zgarsa, telefon yangisini oladi.
const PUB = path.join(here, "public");
const gzCache = new Map();

// 🔖 Avtomatik kesh-buster: "fayl.js?v=13" havolalariga fayl mazmunining qisqa xeshi qo'shiladi
// ("?v=13.a1b2c3d4"). Fayl o'zgarsa — manzil ham o'zgaradi, telefon eskisini ishlatmaydi (versiyani
// qo'lda oshirishni unutish xavfi yo'q). Xesh ichma-ich (app.js → live.js → pcm-worklet.js) hisoblanadi.
const REF = /([\w-]+\.(?:js|css))\?v=(\d+)(?:\.[0-9a-f]+)?/g;
const rendered = new Map(); // rel -> { stamp, body, hash }
const pubStamp = () => fs.readdirSync(PUB).map((f) => { try { return f + fs.statSync(path.join(PUB, f)).mtimeMs; } catch { return f; } }).join("|");
function renderAsset(rel, stamp = pubStamp(), depth = 0) {
  const hit = rendered.get(rel);
  if (hit && hit.stamp === stamp) return hit;
  let body = fs.readFileSync(path.join(PUB, rel), "utf8");
  if (depth < 4) body = body.replace(REF, (m, name, num) => {
    try { return `${name}?v=${num}.${renderAsset("/" + name, stamp, depth + 1).hash}`; } catch { return m; }
  });
  const out = { stamp, body, hash: crypto.createHash("sha1").update(body).digest("hex").slice(0, 8) };
  rendered.set(rel, out);
  return out;
}

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const rel = req.path === "/" ? "/index.html" : req.path;
  if (!/\.(js|css|html|json|svg)$/.test(rel) || !/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return next();
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB + path.sep)) return next();
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return next();
  }
  if (!st.isFile()) return next();
  const asset = renderAsset(rel);
  const key = file + ":" + asset.hash;
  let gz = gzCache.get(key);
  if (!gz) {
    gz = zlib.gzipSync(Buffer.from(asset.body), { level: 9 });
    for (const k of gzCache.keys()) if (k.startsWith(file + ":")) gzCache.delete(k); // eski versiyani o'chiramiz
    gzCache.set(key, gz);
  }
  const etag = `"gz-${asset.hash}"`;
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("ETag", etag);
  // ⚠️ HTML hech qachon uzoq keshlanmaydi: UzDTM Sado'ni "/speaking/?v=7" bilan ochadi — avval bu
  // index.html'ni telefonda 1 yilga muzlatib qo'yardi va yangilanishlar yetib bormasdi
  res.setHeader("Cache-Control", req.query.v && !rel.endsWith(".html") ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.type(path.extname(file));
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Length", gz.length);
  res.end(req.method === "HEAD" ? undefined : gz);
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
