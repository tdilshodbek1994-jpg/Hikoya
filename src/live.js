// 📞 Jonli suhbat: telefon <-> bizning server <-> Gemini Live (ovozdan ovozga, real vaqtda).
// Gemini kaliti faqat serverda turadi; telefon bizning serverga WebSocket orqali ulanadi.
//
// Telefon -> server:  binary = 16 kHz mono PCM16 mikrofon ovozi; text JSON = {type:"end"}
// Server -> telefon:  binary = 24 kHz mono PCM16 Sado ovozi;
//                     text JSON = {type:"ready"|"user"|"sado"|"turn"|"interrupted"|"used"|"error"|"closed", ...}

import { SELF_LEVEL } from "./ai.js";
import WebSocket from "ws";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || process.env.GEMINI_VOICE || "Kore";
const API = "https://generativelanguage.googleapis.com/v1beta";
const WS_URL =
  process.env.GEMINI_LIVE_URL ||
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const liveEnabled = Boolean(GEMINI_KEY);

// ---- Jonli suhbatni qo'llaydigan modelni topish ----
let cachedModel = process.env.GEMINI_LIVE_MODEL || "";

export async function listLiveModels() {
  const res = await fetch(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": GEMINI_KEY } });
  if (!res.ok) throw new Error(`Modellar ro'yxati: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
}

export async function pickLiveModel() {
  if (cachedModel) return cachedModel;
  let names = await listLiveModels();
  // Maxsus (tarjima, transkripsiya, robot, uzoq o'ylaydigan) modellarni chiqarib tashlaymiz,
  // qolganlardan eng yangi versiyani tanlaymiz.
  const usable = names.filter((n) => !/transcribe|translate|robotics|genie|thinking/.test(n));
  const version = (n) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const score = (n) =>
    version(n) * 10 + (/native-audio|live/.test(n) ? 5 : 0) + (/latest/.test(n) ? 1 : 0) - (/preview|exp|\d{2}-\d{4}/.test(n) ? 1 : 0);
  names = (usable.length ? usable : names).sort((a, b) => score(b) - score(a));
  if (!names.length) throw new Error("Jonli suhbatni qo'llaydigan Gemini modeli topilmadi");
  cachedModel = names[0];
  console.log("Gemini Live modeli:", cachedModel);
  return cachedModel;
}

// ---- Sado'ning xulqi ----
// Erkin suhbat mavzulari (foydalanuvchi tanlaydi)
export const FREE_TOPICS = {
  football: "football and sport",
  movies: "films, series and cartoons",
  games: "video games and technology",
  future: "dreams, future studies and career",
  travel: "travelling and places to visit",
  music: "music and singers",
  food: "food and cooking",
  ielts: "preparing for IELTS / CEFR exams",
};

function freePrompt(lesson, topic) {
  return `You are Sado, a smart, warm and funny bilingual (Uzbek and English) companion and English teacher inside a Telegram app for Uzbek students. This is a LIVE VOICE conversation: talk naturally, like a real friend on the phone.

Language:
- Mirror the student. If they speak Uzbek, answer in natural Uzbek. If they speak English, answer in English. If they mix, you may mix too.
- Speak Uzbek with natural, native pronunciation; say English words and sentences with clear English pronunciation.

What you do:
- Talk about anything the student wants: daily life, studies, exams, hobbies, news, advice. Answer questions honestly and helpfully.
- Help with English whenever it fits: translate, explain words and grammar simply in Uzbek, give examples, and invite them to say things in English.
- Every few turns, gently encourage some English practice (for example: "Endi buni inglizcha aytib ko'ring!"), but never force it.
- When the student speaks English with a clear mistake, briefly give the correct version (explain in Uzbek if they are a beginner), then continue.
- Keep each turn short: 1-3 sentences, then let the student talk. Ask questions to keep the conversation going.
- Greet the student only once, at the very start. Never repeat your greeting or introduction later, even if the student says hello again: just reply briefly and continue the conversation.
- Start the conversation yourself now with: "${topic ? `Assalomu alaykum! Men Sado. Bugun ${topic} haqida gaplashamizmi? (then ask one short, fun question about it)` : lesson.opener}"${topic ? `\n- The student chose the topic: ${topic}. Begin with it, but follow the student if they change the subject.` : ""}`;
}

function livePrompt(lesson, topic) {
  if (lesson.free) return freePrompt(lesson, topic);
  const phrases = lesson.phrases.map((p) => `"${p.en}" (${p.uz})`).join("; ");
  return `You are Sado, a warm, friendly English speaking partner for Uzbek students preparing for exams. This is a LIVE VOICE conversation on the phone: speak naturally, like a real person.

Role-play: you are ${lesson.role}. ${lesson.situation}
Student level: about ${lesson.level}.

Rules:
- You lead the conversation. Speak mostly English, in short turns (1-3 sentences), then ask a question so the student keeps talking. Never give long monologues.
- Be patient: if the student is silent or stuck, gently help or rephrase the question more simply.
- If the student speaks Uzbek, answer in Uzbek (naturally, like a friend), show how to say it in English, invite them to try it in English, then continue. If they keep speaking Uzbek or ask questions, keep helping in Uzbek - never refuse to speak Uzbek.
- If the student makes a clear grammar or word mistake, correct it in one short Uzbek sentence with the correct English version, then continue the conversation in English. Do not correct tiny slips.
- Naturally give the student chances to use these useful phrases: ${phrases}.
- When the student says "tugatdim", "finish" or "stop", or after about 8 minutes, wrap up warmly: in Uzbek, say what they did well and 2 things to improve.
- Greet the student only once, at the very start. Never repeat your opening line later, even if the student says hello again: just reply briefly and continue.
- Start the conversation yourself now with: "${lesson.opener}"`;
}

// ---- 🔤 Kirill → lotin (o'zbekcha) ----
// Gemini o'zbekcha nutqni ko'pincha kirillda yozadi; ilova va hisobot lotin yozuvida.
const CYR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "'", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ў: "o'", қ: "q", ғ: "g'", ҳ: "h" };
export function toLatin(text, prev = "") {
  if (!/[\u0400-\u04FF]/.test(text)) return text;
  return text.replace(/[\u0400-\u04FF]/g, (ch, i) => {
    const low = ch.toLowerCase();
    let out = CYR[low] ?? ch;
    // So'z boshidagi "е" — "ye" (ер → yer)
    if (low === "е" && !/[\u0400-\u04FFa-z']/i.test(i ? text[i - 1] : prev.slice(-1))) out = "ye";
    if (ch !== low && out) out = out[0].toUpperCase() + out.slice(1);
    return out;
  });
}

// ---- Iboralarni aniqlash (o'quvchi gapidan) ----
const norm = (t) =>
  t
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function detectUsed(lesson, text, used) {
  const words = new Set(norm(text));
  const found = [];
  lesson.phrases.forEach((p, i) => {
    if (used.has(i)) return;
    const pw = norm(p.en.replace(/\.\.\./g, " "));
    if (!pw.length) return;
    const hit = pw.filter((w) => words.has(w)).length;
    if (hit / pw.length >= 0.8) found.push(i);
  });
  return found;
}

// ---- Bitta jonli suhbat ----
// Foydalanuvchi tanlaydigan ovozlar
const VOICES = { f: process.env.GEMINI_LIVE_VOICE_F || "Kore", m: process.env.GEMINI_LIVE_VOICE_M || "Puck" };

export const liveStats = { topicSwitches: 0 }; // 📊 admin uchun
export async function runLive(client, session, lesson, { maxMs, voice, topic }) {
  // ✏️ O'quvchi yozgan mavzu: faqat harf, raqam va oddiy belgilar, 60 belgigacha
  const custom = String(topic || "").startsWith("custom:")
    ? String(topic).slice(7).replace(/[^\p{L}\p{N} ,.'‘’\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60)
    : "";
  topic = custom || FREE_TOPICS[topic] || "";
  const send = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));
  let upstream;
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    send({ type: "closed", reason });
    try { upstream?.close(); } catch {}
    try { client.close(); } catch {}
  };

  let ready = false; // Gemini sozlamani qabul qilguncha ovoz yubormaymiz
  const timer = setTimeout(() => close("vaqt tugadi"), maxMs);
  // Oxirgi daqiqa: Sado suhbatni o'zi chiroyli yakunlasin
  const wrapTimer = setTimeout(() => {
    send({ type: "wrapup" });
    if (upstream?.readyState === WebSocket.OPEN && ready) {
      upstream.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "(System: about one minute is left in this call. After the student finishes their current thought, wrap up warmly: in Uzbek, briefly say what they did well and one thing to practise next time, then say goodbye.)" }] }],
            turnComplete: true,
          },
        }),
      );
    }
  }, Math.max(0, maxMs - 60_000));
  client.on("close", () => {
    clearTimeout(timer);
    clearTimeout(wrapTimer);
    closed = true;
    try { upstream?.close(); } catch {}
  });

  let model;
  try {
    model = await pickLiveModel();
  } catch (e) {
    console.error("Gemini Live:", e.message);
    send({ type: "error", message: "Jonli suhbat hozir ishlamayapti (model topilmadi)." });
    return close("xato");
  }

  upstream = new WebSocket(`${WS_URL}?key=${encodeURIComponent(GEMINI_KEY)}`);
  let userTurn = "";
  let sadoTurn = "";
  let userRaw = "", sadoRaw = ""; // asl (kirill) matn — bo'laklar orasidagi so'z chegarasi uchun

  upstream.on("open", () => {
    upstream.send(
      JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[voice] || LIVE_VOICE } } },
          },
          systemInstruction: { parts: [{ text: livePrompt(lesson, topic) + (SELF_LEVEL[session.selfLevel] ? "\n\n" + SELF_LEVEL[session.selfLevel] : "") }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }),
    );
  });

  upstream.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.setupComplete) {
      ready = true;
      session.liveReady = true; // kunlik limit faqat haqiqiy suhbat uchun hisoblanadi
      send({ type: "ready", model });
      // Sado birinchi bo'lib gapirsin
      upstream.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "(The student has joined the call. Greet them and start now.)" }] }],
            turnComplete: true,
          },
        }),
      );
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      for (const part of sc.modelTurn?.parts || []) {
        const d = part.inlineData;
        if (d?.data && /audio/.test(d.mimeType || "audio")) {
          if (client.readyState === WebSocket.OPEN) client.send(Buffer.from(d.data, "base64"));
        }
      }
      if (sc.inputTranscription?.text) {
        const t = toLatin(sc.inputTranscription.text, userRaw.slice(-1));
        userRaw += sc.inputTranscription.text;
        userTurn += t;
        send({ type: "user", text: t });
      }
      if (sc.outputTranscription?.text) {
        const t = toLatin(sc.outputTranscription.text, sadoRaw.slice(-1));
        sadoRaw += sc.outputTranscription.text;
        sadoTurn += t;
        send({ type: "sado", text: t });
      }
      if (sc.interrupted) send({ type: "interrupted" });
      if (sc.turnComplete || sc.generationComplete) {
        // Bir navbatda avval o'quvchi gapiradi, keyin Sado javob beradi
        if (userTurn) session.transcript?.push({ who: "student", text: userTurn });
        if (sadoTurn) {
          session.transcript?.push({ who: "sado", text: sadoTurn });
          sadoTurn = "";
        }
        if (userTurn) {
          const found = detectUsed(lesson, userTurn, session.used);
          for (const i of found) session.used.add(i);
          if (found.length) send({ type: "used", used: [...session.used].sort((a, b) => a - b), found });
          userTurn = "";
        }
        if (sc.turnComplete) send({ type: "turn" });
      }
    }
    if (msg.goAway) send({ type: "error", message: "Suhbat tez orada tugaydi." });
  });

  upstream.on("close", (code, reason) => {
    if (!closed) {
      console.error("Gemini Live yopildi:", code, reason?.toString().slice(0, 200));
      if (code !== 1000) send({ type: "error", message: `Ulanish uzildi (${code}). Qaytadan boshlang.` });
      close("upstream");
    }
  });
  upstream.on("error", (e) => {
    console.error("Gemini Live xatosi:", e.message);
    send({ type: "error", message: "Gemini bilan ulanishda xato." });
    close("xato");
  });

  client.on("message", (data, isBinary) => {
    if (closed || !ready || upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      upstream.send(
        JSON.stringify({
          realtimeInput: { audio: { data: Buffer.from(data).toString("base64"), mimeType: "audio/pcm;rate=16000" } },
        }),
      );
      return;
    }
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "end") close("foydalanuvchi");
      // 🤫 O'quvchi uzoq jim qoldi — Sado o'zi yordam beradi (bir qo'ng'iroqda 3 martagacha)
      if (m.type === "nudge" && (session.nudges = (session.nudges || 0) + 1) <= 3) {
        upstream.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "(System: the student has been silent for a while — maybe they didn't understand or don't know what to say. Gently help: in Uzbek, briefly repeat or simplify your last question and suggest a short English answer they can say. One or two short sentences.)" }] }],
              turnComplete: true,
            },
          }),
        );
      }
      // 🔀 Erkin suhbat: o'quvchi boshqa mavzu so'radi (bir qo'ng'iroqda 6 martagacha)
      if (m.type === "newtopic" && lesson.liveOnly && (session.topicSwitches = (session.topicSwitches || 0) + 1) <= 6) {
        liveStats.topicSwitches++;
        upstream.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "(System: the student pressed the 'new topic' button. Briefly and warmly move to a completely different everyday topic you haven't discussed yet (for example food, travel, films, sport, music, studies, family, dreams, technology, holidays) and ask one simple, interesting question about it.)" }] }],
              turnComplete: true,
            },
          }),
        );
      }
    } catch {}
  });
}
