// 📞 Jonli suhbat: telefon <-> bizning server <-> Gemini Live (ovozdan ovozga, real vaqtda).
// Gemini kaliti faqat serverda turadi; telefon bizning serverga WebSocket orqali ulanadi.
//
// Telefon -> server:  binary = 16 kHz mono PCM16 mikrofon ovozi; text JSON = {type:"end"}
// Server -> telefon:  binary = 24 kHz mono PCM16 Sado ovozi;
//                     text JSON = {type:"ready"|"user"|"sado"|"turn"|"interrupted"|"used"|"error"|"closed", ...}

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
  const names = await listLiveModels();
  const score = (n) =>
    (/native-audio/.test(n) ? 100 : 0) +
    (/live/.test(n) ? 50 : 0) +
    (/flash/.test(n) ? 10 : 0) -
    (/preview|exp/.test(n) ? 1 : 0) +
    Number((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]); // yangi versiya afzal
  names.sort((a, b) => score(b) - score(a));
  if (!names.length) throw new Error("Jonli suhbatni qo'llaydigan Gemini modeli topilmadi");
  cachedModel = names[0];
  console.log("Gemini Live modeli:", cachedModel);
  return cachedModel;
}

// ---- Sado'ning xulqi ----
function livePrompt(lesson) {
  const phrases = lesson.phrases.map((p) => `"${p.en}" (${p.uz})`).join("; ");
  return `You are Sado, a warm, friendly English speaking partner for Uzbek students preparing for exams. This is a LIVE VOICE conversation on the phone: speak naturally, like a real person.

Role-play: you are ${lesson.role}. ${lesson.situation}
Student level: about ${lesson.level}.

Rules:
- You lead the conversation. Speak mostly English, in short turns (1-3 sentences), then ask a question so the student keeps talking. Never give long monologues.
- Be patient: if the student is silent or stuck, gently help or rephrase the question more simply.
- If the student speaks Uzbek, answer briefly in Uzbek, show how to say it in English, ask them to try it in English, then continue in English.
- If the student makes a clear grammar or word mistake, correct it in one short Uzbek sentence with the correct English version, then continue the conversation in English. Do not correct tiny slips.
- Naturally give the student chances to use these useful phrases: ${phrases}.
- When the student says "tugatdim", "finish" or "stop", or after about 8 minutes, wrap up warmly: in Uzbek, say what they did well and 2 things to improve.
- Start the conversation yourself now with: "${lesson.opener}"`;
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
export async function runLive(client, session, lesson, { maxMs }) {
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

  const timer = setTimeout(() => close("vaqt tugadi"), maxMs);
  client.on("close", () => {
    clearTimeout(timer);
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
  let ready = false; // Gemini sozlamani qabul qilguncha ovoz yubormaymiz

  upstream.on("open", () => {
    upstream.send(
      JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } },
          },
          systemInstruction: { parts: [{ text: livePrompt(lesson) }] },
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
        userTurn += sc.inputTranscription.text;
        send({ type: "user", text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) send({ type: "sado", text: sc.outputTranscription.text });
      if (sc.interrupted) send({ type: "interrupted" });
      if (sc.turnComplete || sc.generationComplete) {
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
    } catch {}
  });
}
