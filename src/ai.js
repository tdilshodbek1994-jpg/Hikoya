import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5"; // ⚡ eng tez model
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "low"; // suhbat uchun tez javob
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
const STT_MODEL = process.env.STT_MODEL || "gpt-4o-transcribe"; // o'zbekchani yaxshiroq taniydi
const TTS_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";
const TTS_VOICE = process.env.TTS_VOICE || "coral";
// Gemini: o'zbekcha qismlar uchun ovoz (kalit bo'lmasa OpenAI ishlatiladi)
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const GEMINI_VOICE = process.env.GEMINI_VOICE || "Kore";
// Microsoft Azure: tayyor o'zbekcha neyron ovozlar (uz-UZ-MadinaNeural — ayol, uz-UZ-SardorNeural — erkak)
const AZURE_KEY = process.env.AZURE_SPEECH_KEY || "";
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || "";
const AZURE_VOICE = process.env.AZURE_VOICE || "uz-UZ-MadinaNeural";

// ANTHROPIC_API_KEY muhit o'zgaruvchisidan o'qiladi. ⏱ 40 s chegara: SDK odatda 10 daqiqa kutadi —
// AI sekinlashsa o'quvchi "Sado o'ylamoqda"da qotib qolmasin (ilova 60 s dan keyin baribir voz kechadi)
const anthropic = new Anthropic({ timeout: 40_000, maxRetries: 1 });

// Server tomonidagi zaxira model (refusal bo'lsa) faqat shu modellarda bor
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(CLAUDE_MODEL);

const FAST_NO_THINKING = /^claude-haiku-5/.test(CLAUDE_MODEL) && ["low", "medium", "high"].includes(CLAUDE_EFFORT);

export const voiceEnabled = Boolean(OPENAI_KEY);
export const geminiEnabled = Boolean(GEMINI_KEY);

// O'quvchi o'zi tanlagan daraja (tanishuv/sozlamalar) — Sado nutqini moslash uchun
export const SELF_LEVEL = {
  beg: "The student says they are a BEGINNER: use very short, simple sentences and common words, speak slowly and help with Uzbek more often.",
  mid: "The student says their English is INTERMEDIATE: use natural everyday English, not too fast.",
  adv: "The student says their English is GOOD: speak naturally, use richer vocabulary and ask follow-up questions that push them further.",
};
function systemPrompt(lesson, selfLevel = "") {
  const list = lesson.phrases.map((p, i) => `${i}. "${p.en}"`).join("\n");
  return `You are Sado, a warm and patient English speaking partner inside a Telegram app for Uzbek students preparing for exams.

Role-play: you are ${lesson.role}. ${lesson.situation}
Student level: about ${lesson.level}.${SELF_LEVEL[selfLevel] ? " " + SELF_LEVEL[selfLevel] : ""} You already opened the conversation by saying: "${lesson.opener}"

Target phrases the student should practise (index. phrase):
${list}

How to behave:
- Stay in character and keep the conversation natural. The English part ("reply") is 1-2 short, simple sentences (max ~30 words), because it is spoken aloud.
- Steer the conversation so the student gets chances to use the target phrases they have not used yet. Never read the list to them.
- The student's words come from speech recognition, so ignore small transcription glitches, punctuation and Cyrillic/Latin spelling differences.
- A target phrase counts as used when the student says it or a clearly equivalent sentence (filled-in blanks like "My name is Aziz" count).

Speaking Uzbek ("uz_say", spoken aloud in Uzbek before your English reply):
- If the student speaks Uzbek (or Russian), answer them in Uzbek in "uz_say": respond to what they said or asked, tell them how to say it in English (include the exact English sentence), and invite them to repeat it in English. Then continue the role-play in English in "reply".
- If the student speaks English but makes a clear grammar, word or meaning mistake, explain it in Uzbek in "uz_say", for example: "Siz '...' dedingiz. To'g'risi: '...'. Chunki ...". Include the correct English sentence. Ignore tiny slips that do not matter.
- If the student's English is fine, "uz_say" is an empty string.
- Write Uzbek in the Latin alphabet, warm and simple, max ~35 words, plain text only (no markdown, no emojis), because it is read aloud.

Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"uz_say": "<Uzbek spoken help or correction, or empty string>", "reply": "<your spoken English reply>", "reply_uz": "<Uzbek translation of reply>", "used_phrases": [<indexes of target phrases the student used in THIS message>], "mood": "<one of: happy, neutral, curious, surprised>"}}`;
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Claude'ga bitta so'rov: o'quvchi gapini tarixga qo'shadi, JSON javobni qaytaradi.
// Refusal bo'lsa null qaytaradi (bosqich tarixdan olib tashlanadi).
async function askClaude(session, system, userContent) {
  session.messages.push({ role: "user", content: userContent });

  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: CLAUDE_EFFORT },
    // ⚡ Haiku'da javobdan oldin "o'ylash"ni o'chiramiz — javob darhol boshlanadi
    ...(FAST_NO_THINKING ? { thinking: { type: "disabled" } } : {}),
    cache_control: { type: "ephemeral" },
    system,
    messages: session.messages,
  };
  if (SUPPORTS_FALLBACKS) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let response;
  try {
    response = await anthropic.beta.messages.create(params);
  } catch (err) {
    session.messages.pop(); // muvaffaqiyatsiz bosqichni tarixdan olib tashlaymiz
    throw err;
  }

  if (response.stop_reason === "refusal") {
    session.messages.pop();
    return null;
  }

  // Javobni (thinking bloklari bilan birga) o'zgartirmasdan tarixga qo'shamiz
  session.messages.push({ role: "assistant", content: response.content });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseJson(text) || { reply: text.trim() };
}

function cleanUsed(list, lesson) {
  return Array.isArray(list)
    ? list.filter((i) => Number.isInteger(i) && i >= 0 && i < lesson.phrases.length)
    : [];
}

const MOODS = ["happy", "neutral", "curious", "surprised"];

// 🇬🇧 Suhbat rejimi: inglizcha rolli suhbat
export async function chatTurn(session, lesson, studentText) {
  const remaining = lesson.phrases.map((_, i) => i).filter((i) => !session.used.has(i));
  const data = await askClaude(
    session,
    systemPrompt(lesson, session.selfLevel),
    `Student said: "${studentText}"\n(Target phrases not used yet: ${remaining.length ? remaining.join(", ") : "none - all done, you can wrap up warmly"})`,
  );
  if (!data) {
    return {
      reply: "Sorry, let's get back to our conversation. Could you say that another way?",
      reply_uz: "Kechirasiz, suhbatimizga qaytaylik. Buni boshqacha ayta olasizmi?",
      used_phrases: [],
      uz_say: "",
      mood: "neutral",
    };
  }
  return {
    reply: String(data.reply || "").slice(0, 600) || "Sorry, could you repeat that?",
    reply_uz: String(data.reply_uz || ""),
    used_phrases: cleanUsed(data.used_phrases, lesson),
    uz_say: String(data.uz_say || "").slice(0, 600),
    mood: MOODS.includes(data.mood) ? data.mood : "neutral",
  };
}

// 🇺🇿 Ustoz rejimi: Sado o'zbekcha gapirib, iboralarni birma-bir o'rgatadi
export function tutorOpener(lesson) {
  const p = lesson.phrases[0];
  const n = lesson.phrases.length; // takrorlash darsida 6 tadan kam bo'lishi mumkin
  if (lesson.id === "review") {
    // 🔁 Xatolar ustida ishlash: avval o'quvchining o'z xatosi, keyin to'g'risi
    const wrong = String(p.uz || "").replace(/^Xato edi:\s*/, "");
    // Inglizcha qismlar alohida — ular inglizcha talaffuz bilan o'qiladi
    return [
      { lang: "uz", text: `Assalomu alaykum! Bugun oldingi darslarda qiyin bo'lgan ${n} ta gap ustida ishlaymiz. Birinchisi: siz shunday degan edingiz:` },
      ...(wrong ? [{ lang: "en", text: wrong, wrong: true }] : []),
      { lang: "uz", text: "To'g'risi esa bunday:" },
      { lang: "en", text: p.en },
      { lang: "uz", text: "Qani, to'g'ri variantni ovoz chiqarib ayting!" },
    ];
  }
  if (lesson.category === "Bolalar uchun") {
    // 🧒 Bolaga "sen" deb, quvnoq salomlashish
    return [
      { lang: "uz", text: `Salom, do'stim! Men Sado! Bugun "${lesson.title}" haqida ${n} ta qiziq so'z o'rganamiz. Birinchisi: "${p.uz}". Inglizcha bunday:` },
      { lang: "en", text: p.en },
      { lang: "uz", text: "Qani, baland ovozda takrorla!" },
    ];
  }
  return [
    {
      lang: "uz",
      text: `Assalomu alaykum! Men Sado, ingliz tili ustozingizman. Bugun "${lesson.title}" mavzusida ${n} ta ibora o'rganamiz. Birinchi ibora: "${p.uz}". Inglizcha bunday deyiladi:`,
    },
    { lang: "en", text: p.en },
    { lang: "uz", text: "Qani, ovoz chiqarib takrorlang!" },
  ];
}

// Ustoz rejimi uchun darajaga mos sur'at
const TUTOR_LEVEL = {
  beg: "The student is a complete BEGINNER: explain every word slowly in Uzbek, break long phrases into 2-3 word chunks and praise every small success.",
  adv: "The student says their English is GOOD: keep Uzbek explanations very short, move faster, and after each phrase ask them to make their own new sentence with it.",
};
function tutorPrompt(lesson, selfLevel = "") {
  const list = lesson.phrases.map((p, i) => `${i}. "${p.en}" = "${p.uz}"`).join("\n");
  const opener = tutorOpener(lesson).map((s) => s.text).join(" ");
  return `You are Sado, a warm, patient English teacher for Uzbek students inside a Telegram app. You speak UZBEK as your main language and teach English phrases one by one. Everything you say is read aloud.${TUTOR_LEVEL[selfLevel] ? "\n" + TUTOR_LEVEL[selfLevel] : ""}${lesson.category === "Bolalar uchun" ? "\nThe student is a CHILD (about 7-12 years old): use very simple Uzbek, say \"sen\", be playful and cheerful, keep every message very short, use fun comparisons and praise a lot (Zo'r!, Barakalla!, Ofarin!). Never criticise — gently say the right version and ask to repeat." : ""}

Lesson topic: ${lesson.title} (${lesson.situation}) Level: about ${lesson.level}.
Phrases to teach (index. English = Uzbek):
${list}

You already started the lesson by saying: "${opener}"

How to teach:
- Speak simple, friendly Uzbek in the Latin alphabet. Short sentences.
- Teach one phrase at a time: say what it means and when to use it (in Uzbek), say the English phrase, then ask the student to repeat it.
- When the student says the current phrase correctly (small speech-recognition differences are fine; for phrases with "..." any sensible filled-in words are fine), praise them briefly, mark it as used, and introduce the next phrase that is not used yet.
- When they say it with a mistake, explain kindly in Uzbek exactly what was wrong (missing word, wrong word, word order), say the correct English again and ask them to repeat. After 3 unsuccessful tries, encourage them and move on to the next phrase.
- If the student speaks or asks something in Uzbek, answer in Uzbek (briefly), then continue the lesson.
- If the student says the phrase well, you may sometimes add a tiny real-life example in English, but keep the lesson moving.
- When all phrases are used, congratulate them warmly in Uzbek and briefly list what they learned.

Output format - put every English word or sentence in its own segment with "lang": "en" so it is pronounced in English; Uzbek goes in "lang": "uz" segments. Never mix English sentences inside an Uzbek segment. Use at most 5 segments and about 60 words in total. Plain text only (no markdown, no emojis).

Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"say": [{"lang": "uz", "text": "..."}, {"lang": "en", "text": "..."}], "used_phrases": [<indexes of phrases the student said correctly in THIS message>], "current_phrase": <index of the phrase you are teaching now>, "mood": "<one of: happy, neutral, curious, surprised>"}`;
}

export async function tutorTurn(session, lesson, studentText) {
  const remaining = lesson.phrases.map((_, i) => i).filter((i) => !session.used.has(i));
  const data = await askClaude(
    session,
    tutorPrompt(lesson, session.selfLevel),
    `Student said: "${studentText}"\n(Phrase being taught: ${session.current ?? 0}. Phrases not used yet: ${remaining.length ? remaining.join(", ") : "none - all done, congratulate and finish"})`,
  );
  if (!data) {
    return {
      say: [{ lang: "uz", text: "Kechirasiz, darsimizga qaytaylik. Iborani yana bir bor aytib ko'ring." }],
      used_phrases: [],
      current: session.current ?? 0,
      mood: "neutral",
    };
  }
  let say = Array.isArray(data.say) ? data.say : [];
  say = say
    .filter((x) => x && typeof x.text === "string" && x.text.trim())
    .slice(0, 6)
    .map((x) => ({ lang: x.lang === "en" ? "en" : "uz", text: x.text.slice(0, 400) }));
  if (!say.length) say = [{ lang: "uz", text: String(data.reply || "Yana bir bor aytib ko'ring.").slice(0, 400) }];
  const cur = Number.isInteger(data.current_phrase) && data.current_phrase >= 0 && data.current_phrase < lesson.phrases.length
    ? data.current_phrase
    : session.current ?? 0;
  return {
    say,
    used_phrases: cleanUsed(data.used_phrases, lesson),
    current: cur,
    mood: MOODS.includes(data.mood) ? data.mood : "neutral",
  };
}

// Ovoz -> matn (OpenAI transcription)
export async function transcribe(buffer, mimeType, lesson) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY sozlanmagan: ovozni tanib bo'lmaydi");
  const ext = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a"
    : mimeType.includes("ogg") ? "ogg"
    : mimeType.includes("wav") ? "wav"
    : "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `speech.${ext}`);
  form.append("model", STT_MODEL);
  // Til avtomatik aniqlanadi: o'quvchi inglizcha yoki o'zbekcha gapirishi mumkin
  form.append(
    "prompt",
    "An Uzbek student practising English; they may speak English or Uzbek. Write Uzbek in the Latin alphabet (Salom, men maktabda o'qiyman, rahmat). " +
      lesson.phrases.map((p) => p.en).join(" "),
  );

  const res = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000), // ⏱ ovozni matnga aylantirish
  });
  if (!res.ok) throw new Error(`Transcription xatosi: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return String(json.text || "").trim();
}

// Matn -> ovoz (mp3, base64). Kalit bo'lmasa null - brauzer o'zi o'qiydi.
const TTS_STYLE = {
  en: "Speak clearly, warmly and a little slower than normal, like a friendly English teacher.",
  uz: "Speak in the Uzbek language with natural Uzbek pronunciation, warmly and clearly, like a friendly teacher. Pronounce any English words inside quotes in clear English.",
};

// 16-bit PCM (mono) ni WAV fayliga o'raydi - brauzer to'g'ridan-to'g'ri ijro eta olishi uchun
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const GEMINI_STYLE = {
  uz: "Read the following text aloud in the Uzbek language (O'zbek tili) with natural, native Uzbek pronunciation, in a warm, clear and friendly teacher's voice, at a calm pace:",
  en: "Read the following text aloud in clear English, in a warm, friendly teacher's voice, a little slower than normal:",
};

// Gemini TTS so'rovi. Muvaffaqiyatda { audio (base64 wav), mime }, aks holda { error }.
const SLOW_NOTE = " Speak slowly and very clearly, with small pauses between phrases, for a beginner learner.";

export async function geminiTts(text, lang = "uz", slow = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000), // ⏱ ovoz yaratish
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${GEMINI_STYLE[lang] || GEMINI_STYLE.uz}${slow ? SLOW_NOTE : ""}\n\n${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } },
      },
    }),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  const json = await res.json();
  const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) return { error: "javobda audio yo'q: " + JSON.stringify(json).slice(0, 200) };
  const mime = part.inlineData.mimeType || "";
  const pcm = Buffer.from(part.inlineData.data, "base64");
  if (/wav|mpeg|mp3|ogg/i.test(mime)) return { audio: pcm.toString("base64"), mime };
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  return { audio: pcmToWav(pcm, rate).toString("base64"), mime: "audio/wav" };
}

// OpenAI'ga bitta TTS so'rovi. Muvaffaqiyatda base64 mp3, aks holda { error } qaytaradi.
export async function ttsRequest(body) {
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/v1/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ response_format: "mp3", ...body }),
      signal: AbortSignal.timeout(30_000), // ⏱ ovoz yaratish
    });
  } catch (e) {
    return { error: e.name === "TimeoutError" ? "TTS 30 s ichida javob bermadi" : e.message }; // shartnoma: xato qaytaradi, otmaydi
  }
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  return { audio: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

// Asosiy model ishlamasa, zaxira "tts-1" modeliga o'tamiz va keyingi safar to'g'ridan-to'g'ri o'shani ishlatamiz
let useFallbackTts = false;
const FALLBACK_TTS = { model: "tts-1", voice: process.env.TTS_FALLBACK_VOICE || "nova" };

// Gemini xato bersa, har gapda kutib o'tirmaslik uchun 10 daqiqa unga murojaat qilmaymiz
let geminiPausedUntil = 0;
function pauseGemini(reason) {
  geminiPausedUntil = Date.now() + 10 * 60_000;
  console.error(`Gemini TTS xatosi (${GEMINI_TTS_MODEL}): ${reason} — 10 daqiqa OpenAI ovozi ishlatiladi`);
}

// 💾 Ovoz keshi: bir xil gap (dars kirish gaplari, iboralar) qayta yaratilmaydi
const ttsCache = new Map();
const TTS_CACHE_MAX = Number(process.env.TTS_CACHE_MAX || 500);
export const ttsStats = { hits: 0, misses: 0, uz: { n: 0, ms: 0, err: 0, via: {} }, en: { n: 0, ms: 0, err: 0, via: {} } };

export async function speak(text, lang = "en", slow = false) {
  if (!text) return null;
  const key = `${lang}|${slow ? 1 : 0}|${text}`;
  if (ttsCache.has(key)) {
    ttsStats.hits++;
    const v = ttsCache.get(key);
    ttsCache.delete(key);
    ttsCache.set(key, v); // eng yangi deb belgilaymiz (LRU)
    return v;
  }
  ttsStats.misses++;
  // ⏱ Ovoz yaratish vaqti (admin: o'zbekcha/inglizcha ovoz qancha kechikyapti, qaysi xizmat ishlatildi)
  const t0 = Date.now();
  const v = await speakUncached(text, lang, slow);
  const st = ttsStats[lang === "uz" ? "uz" : "en"];
  st.n++;
  st.ms += Date.now() - t0;
  if (!v?.audio) st.err++;
  else st.via[v.via || "openai"] = (st.via[v.via || "openai"] || 0) + 1;
  if (v?.audio && text.length <= 400) {
    ttsCache.set(key, v);
    if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
  }
  return v;
}

let azurePausedUntil = 0;
// Azure TTS so'rovi (o'zbekcha). Muvaffaqiyatda { audio (base64 mp3), mime }, aks holda { error }.
const xmlEscape = (t) => t.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
export async function azureTts(text, slow = false) {
  const body = xmlEscape(text);
  const res = await fetch(`https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "sado-speaking",
    },
    body: `<speak version="1.0" xml:lang="uz-UZ"><voice name="${AZURE_VOICE}">${slow ? `<prosody rate="-15%">${body}</prosody>` : body}</voice></speak>`,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  return { audio: Buffer.from(await res.arrayBuffer()).toString("base64"), mime: "audio/mpeg" };
}

async function speakUncached(text, lang, slow) {
  // O'zbekcha qismlar: avval Azure (tayyor o'zbekcha ovoz, tez)
  if (lang === "uz" && AZURE_KEY && AZURE_REGION && Date.now() > azurePausedUntil) {
    try {
      const a = await azureTts(text, slow);
      if (a.audio) return { ...a, via: "azure" };
      console.error("Azure TTS xatosi:", a.error, "- keyingi ovozga o'tilmoqda");
      // Kalit/obuna xatosi (401/403) bo'lsa — 10 daqiqa Azure'ni chetlab o'tamiz (har gapda behuda kutmaslik uchun)
      if (/^40[13]/.test(String(a.error))) azurePausedUntil = Date.now() + 10 * 60_000;
    } catch (e) {
      console.error("Azure TTS ulanish xatosi:", e.message);
    }
  }
  // Keyin Gemini (o'zbekchani tabiiyroq talaffuz qiladi)
  if (lang === "uz" && GEMINI_KEY && Date.now() > geminiPausedUntil) {
    try {
      const g = await geminiTts(text, "uz", slow);
      if (g.audio) return { audio: g.audio, mime: g.mime, via: "gemini" };
      pauseGemini(`${g.error}`.slice(0, 160));
    } catch (e) {
      pauseGemini(e.message);
    }
  }
  if (!OPENAI_KEY) return null;
  if (!useFallbackTts) {
    const r = await ttsRequest({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      instructions: (TTS_STYLE[lang] || TTS_STYLE.en) + (slow ? SLOW_NOTE : ""),
    });
    if (r.audio) return { audio: r.audio, mime: "audio/mpeg" };
    console.error(`TTS xatosi (${TTS_MODEL}):`, r.error, "- zaxira tts-1 ga o'tilmoqda");
  }
  const f = await ttsRequest({ ...FALLBACK_TTS, input: text, ...(slow ? { speed: 0.8 } : {}) });
  if (f.audio) {
    useFallbackTts = true;
    return { audio: f.audio, mime: "audio/mpeg" };
  }
  console.error("TTS xatosi (tts-1):", f.error);
  return null;
}

export async function speakParts(parts, { slow = false } = {}) {
  const list = parts.filter((p) => p.text && p.text.trim());
  const audios = await Promise.all(
    list.map((p) =>
      speak(p.text, p.lang, slow).catch((err) => {
        console.error("TTS xatosi:", err?.message || err);
        return null;
      }),
    ),
  );
  return list.map((p, i) => ({
    lang: p.lang,
    text: p.text,
    audio: audios[i]?.audio || null,
    mime: audios[i]?.mime || "audio/mpeg",
  }));
}

// 💬 Erkin suhbat (jonli qo'ng'iroqsiz): o'quvchi tanlagan istalgan mavzu, uning tilida
function freePrompt(lesson, selfLevel = "", recap = "", opener = FREE_OPENER) {
  return `You are Sado, a smart, warm and funny bilingual (Uzbek and English) friend for Uzbek students, who can also help with English when asked. This is a spoken conversation: everything you say is read aloud, so talk naturally, like a real friend.

You already started the conversation by saying: "${opener}"${recap ? `

This continues an earlier conversation with the same student. The last part of it was:
${recap}
Continue naturally from where it stopped (same topic unless the student changes it). Do not repeat or summarise it, and do not greet again.` : ""}

Language:
- Mirror the student. If they speak Uzbek, answer in natural Uzbek (Latin alphabet). If they speak English, answer in English. If they mix, you may mix too.

What you do:
- The student chooses the topic, and ANY topic is fine: daily life, studies, exams, work, sport, films, music, technology, science, history, religion, health, relationships, news, advice, homework, jokes. Talk about it fully and helpfully, like a knowledgeable friend: answer their questions directly and honestly, share facts and opinions, and ask follow-up questions about THEIR topic.
- Never choose the topic yourself at the start, and never drag the student back to English lessons or to another subject. Follow the student when they change the subject.
- English help only when it fits naturally or when the student asks: translate, explain a word, or correct a clear mistake briefly. At most once every 4-5 turns you may offer: "Buni inglizcha aytib ko'ramizmi?" - never insist.
- Keep each turn short and spoken: 1-4 sentences, then let the student talk.
- Never repeat your greeting or introduction.${SELF_LEVEL[selfLevel] ? `\n- ${SELF_LEVEL[selfLevel]} Apply this only when you speak English or help with English.` : ""}

Output format - put every English sentence in its own segment with "lang": "en" so it is pronounced in English; Uzbek goes in "lang": "uz" segments. Never put an English sentence inside an Uzbek segment. Use at most 4 segments and about 70 words in total. Plain text only (no markdown, no emojis).

Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"say": [{"lang": "uz", "text": "..."}, {"lang": "en", "text": "..."}], "mood": "<one of: happy, neutral, curious, surprised>"}`;
}
export const FREE_OPENER = "Assalomu alaykum! Men Sado. Men bilan o'zbekcha ham, inglizcha ham gaplashishingiz mumkin. Bugun nima haqida gaplashamiz?";
export const FREE_CONT_OPENER = "Yana salom! Suhbatimizni davom ettiramiz. Qani, gapiring — eshitaman.";

export async function freeTurn(session, lesson, studentText) {
  const data = await askClaude(session, freePrompt(lesson, session.selfLevel, session.recap || "", session.recap ? FREE_CONT_OPENER : FREE_OPENER), `Student said: "${studentText}"`);
  let say = Array.isArray(data?.say) ? data.say : [];
  say = say
    .filter((x) => x && typeof x.text === "string" && x.text.trim())
    .slice(0, 5)
    .map((x) => ({ lang: x.lang === "en" ? "en" : "uz", text: x.text.slice(0, 400) }));
  if (!say.length) say = [{ lang: "uz", text: String(data?.reply || "Kechirasiz, yana bir bor ayta olasizmi?").slice(0, 400) }];
  return { say, mood: MOODS.includes(data?.mood) ? data.mood : "neutral" };
}

// ⚡ Tez javob: matn darhol qaytadi, ovoz esa gapma-gap parallel tayyorlanadi (/api/audio orqali olinadi)
function splitSentences(text) {
  const raw = String(text || "").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const out = [];
  for (const t of raw) {
    if (out.length && (out[out.length - 1].length < 25 || t.length < 12)) out[out.length - 1] += " " + t;
    else out.push(t);
  }
  return out;
}
export function deferParts(s, parts, { slow = false } = {}) {
  s.audio ||= new Map();
  if (s.audio.size > 200) s.audio.clear();
  const list = [];
  for (const p of parts) {
    if (!p.text || !p.text.trim()) continue;
    for (const text of splitSentences(p.text)) {
      const id = String((s.audioSeq = (s.audioSeq || 0) + 1));
      s.audio.set(id, speak(text, p.lang, slow).catch((err) => {
        console.error("TTS xatosi:", err?.message || err);
        return null;
      }));
      list.push({ lang: p.lang, text, id, audio: null });
    }
  }
  return list;
}

// ---- 📝 Dars yakunidagi hisobot ----
// transcript: [{ who: "student" | "sado", text }]
export async function lessonReport(lesson, transcript, { used, total, mode }) {
  const lines = transcript
    .filter((t) => t.text && t.text.trim())
    .slice(-80)
    .map((t) => `${t.who === "student" ? "STUDENT" : "SADO"}: ${t.text.trim().slice(0, 400)}`)
    .join("\n");
  if (!lines.includes("STUDENT:")) return null;
  const isIelts = /ielts/i.test(lesson.id + lesson.title + (lesson.category || ""));
  const isCefr = !isIelts && /^cefr/i.test(lesson.id); // milliy CEFR (Multilevel) imtihoni


  const system = `You are an experienced English speaking examiner for Uzbek students. You write short, kind, practical feedback in simple Uzbek (Latin alphabet). Judge only the STUDENT's English (ignore their Uzbek sentences; speech-recognition may cause small spelling glitches - ignore those).

Answer with ONLY a JSON object, no markdown:
{"score": <0-100 overall speaking score for this lesson>,
 "level": "<${isIelts ? "estimated IELTS Speaking band, e.g. 'IELTS 5.5'" : "estimated CEFR level: A1, A2, B1, B2 or C1"}>",
 "summary_uz": "<1-2 sentences: overall impression>",
 "strengths_uz": ["<up to 2 things done well>"],
 "mistakes": [{"wrong": "<exact student phrase>", "right": "<corrected English>", "why_uz": "<short reason in Uzbek>"}],
 "tips_uz": ["<2 concrete tips for next time>"],
 "new_words": [{"en": "<useful word or phrase from the lesson topic>", "uz": "<translation>"}]${isIelts ? ',\n "criteria": {"fluency": <band 1-9, step 0.5>, "vocabulary": <band>, "grammar": <band>, "pronunciation": <band>}' : ""}${isCefr ? ',\n "ml_score": <estimated Uzbek national CEFR Multilevel speaking score 0-75: below 38 = A2 or lower, 38-50 = B1, 51-64 = B2, 65-75 = C1; must match the level>' : ""}}
Rules: at most 5 mistakes (most important first, only real mistakes), at most 5 new_words. If the student said very little, give a low score and encourage them.${lesson.free ? `
This was a FREE conversation with Sado on a topic the student chose, in Uzbek and/or English. Do not judge which topic they chose. If they spoke mostly Uzbek, do not scold: in summary_uz praise the conversation and kindly invite them to try a few English sentences next time; mistakes only from their English sentences (none if they spoke no English); new_words = useful English words and phrases about the topics THEY talked about, so they can use them next time.` : ""}${lesson.category === "Bolalar uchun" ? `
The student is a CHILD (about 7-12 years old). Write every Uzbek text for a child: very simple words, warm and playful, address them with "sen", praise effort first, one short sentence per item, at most 2 mistakes (only the most important), at most 3 very simple new_words. Be generous with the score.` : ""}`;

  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    output_config: { effort: "low" },
    ...(FAST_NO_THINKING ? { thinking: { type: "disabled" } } : {}), // ⚡ yordamchi so'rovlar ham tezroq
    system,
    messages: [
      {
        role: "user",
        content: `Lesson: ${lesson.title} (${lesson.situation || ""}). Mode: ${mode}.${lesson.free ? "" : ` Target phrases used: ${used} of ${total}.`}\n\nTranscript:\n${lines}`,
      },
    ],
  };
  if (SUPPORTS_FALLBACKS) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const response = await anthropic.beta.messages.create(params);
  if (response.stop_reason === "refusal") return null;
  const data = parseJson(
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );
  if (!data) return null;
  const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  const str = (x, n = 300) => String(x ?? "").slice(0, n);
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(data.score) || 0))),
    level: str(data.level, 20),
    summary_uz: str(data.summary_uz, 400),
    strengths_uz: arr(data.strengths_uz, 2).map((s) => str(s)),
    mistakes: arr(data.mistakes, 5)
      .filter((m) => m && m.wrong && m.right)
      .map((m) => ({ wrong: str(m.wrong, 200), right: str(m.right, 200), why_uz: str(m.why_uz, 250) })),
    tips_uz: arr(data.tips_uz, 3).map((s) => str(s)),
    criteria: isIelts && data.criteria
      ? Object.fromEntries(
          ["fluency", "vocabulary", "grammar", "pronunciation"].map((k) => [k, Math.max(0, Math.min(9, Math.round((Number(data.criteria[k]) || 0) * 2) / 2))]),
        )
      : null,
    new_words: arr(data.new_words, 5)
      .filter((w) => w && w.en)
      .map((w) => ({ en: str(w.en, 80), uz: str(w.uz, 80) })),
    ml_score: isCefr && Number.isFinite(Number(data.ml_score)) ? Math.max(0, Math.min(75, Math.round(Number(data.ml_score)))) : null,
  };
}

// ---- 💡 Javob namunalari (o'quvchi nima deyishni bilmasa) ----
// 📝 IELTS Part 2: namunaviy javob (Band 7). Har bir kartochka uchun bir marta yaratilib, hammaga keshdan beriladi
// Diskka saqlanadi — server qayta ishga tushsa ham AI qayta chaqirilmaydi
const SAMPLE_FILE = path.join(process.env.DATA_DIR || path.resolve("data"), "samples.json");
const sampleCache = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SAMPLE_FILE, "utf8")))) sampleCache.set(k, v);
} catch {}
// Namunadagi iboralar Sado ovozida eshittirilishi mumkin
// Ovoz yaratishga ruxsat: namunaning foydali iboralari va javob paragraflari («▶ Namunani tinglash»)
export const samplePhrases = () => new Set([...sampleCache.values()].flatMap((v) => [...(v.phrases || []).map((p) => p.en), ...String(v.answer || "").split(/\n+/).map((x) => x.trim()).filter(Boolean)]));
// 📒 Namunaviy javob iborasining tarjimasi (lug'atga saqlash uchun; faqat keshdagi namunalardan)
export function samplePhraseUz(en) {
  for (const v of sampleCache.values()) for (const p of v.phrases || []) if (p.en === en) return p.uz || "";
  return null;
}
export const sampleStats = { opens: 0, generated: 0 };
export const sampleCount = () => sampleCache.size;
export async function sampleAnswer(lessonId, cue, questions, task) {
  sampleStats.opens++;
  if (sampleCache.has(lessonId)) return sampleCache.get(lessonId);
  sampleStats.generated++;
  // Part 2 — kartochka monologi; Part 1/3 — har savolga qisqa javob (savol: javob ko'rinishida)
  const part1 = /^ielts-p1/.test(lessonId);
  const system = task
    ? `You are an expert coach for the Uzbek national CEFR (Multilevel) speaking exam. Write a natural B2-level sample answer for this exam task, as a student would SAY it (spoken style, 120-180 words, clear structure, good linking words, a personal example). Then list 4 useful phrases from it with Uzbek translations. Answer with ONLY JSON: {"answer":"...","phrases":[{"en":"...","uz":"..."}]}`
    : cue
    ? `You are an IELTS Speaking expert. Write a natural Band 7 sample answer for an IELTS Part 2 cue card, as a student would SAY it (spoken style, 170-220 words, first person, covers every bullet point, uses a few good linking phrases and natural vocabulary, simple paragraphs). Then list 4 useful phrases from it with Uzbek translations. Answer with ONLY JSON: {"answer":"...","phrases":[{"en":"...","uz":"..."}]}`
    : `You are an IELTS Speaking expert. Write natural Band 7 sample answers for these IELTS Part ${part1 ? 1 : 3} questions, as a student would SAY them (spoken style, ${part1 ? "2-3 sentences" : "3-5 sentences with an opinion, a reason and an example"} each). Put each one as a separate paragraph that starts with the question number, e.g. "1) ...". Then list 4 useful phrases from them with Uzbek translations. Answer with ONLY JSON: {"answer":"...","phrases":[{"en":"...","uz":"..."}]}`;
  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    ...(FAST_NO_THINKING ? { thinking: { type: "disabled" } } : {}), // ⚡ yordamchi so'rovlar ham tezroq
    system,
    messages: [{ role: "user", content: task ? task : cue ? `${cue.title}\nYou should say:\n${cue.points.map((p) => "- " + p).join("\n")}` : questions.map((q, i) => `${i + 1}) ${q}`).join("\n") }],
  };
  if (SUPPORTS_FALLBACKS) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const response = await anthropic.beta.messages.create(params);
  if (response.stop_reason === "refusal") return null;
  const data = parseJson(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  if (!data?.answer) return null;
  const out = {
    answer: String(data.answer).slice(0, 2500),
    phrases: (Array.isArray(data.phrases) ? data.phrases : []).filter((x) => x?.en).slice(0, 5).map((x) => ({ en: String(x.en).slice(0, 150), uz: String(x.uz || "").slice(0, 150) })),
  };
  sampleCache.set(lessonId, out);
  try {
    fs.mkdirSync(path.dirname(SAMPLE_FILE), { recursive: true });
    fs.writeFileSync(SAMPLE_FILE, JSON.stringify(Object.fromEntries(sampleCache)));
  } catch (e) {
    console.error("Namunani saqlab bo'lmadi:", e.message);
  }
  return out;
}

export async function suggestReplies(lesson, lastSado, used) {
  const remaining = lesson.phrases.filter((_, i) => !used.has(i)).map((p) => p.en);
  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    output_config: { effort: "low" },
    ...(FAST_NO_THINKING ? { thinking: { type: "disabled" } } : {}), // ⚡ yordamchi so'rovlar ham tezroq
    system: lesson.free
      ? `You help an Uzbek student in a FREE conversation with Sado (an AI friend) who doesn't know what to say next. Suggest 2 short, natural things they could say next in ENGLISH that continue THEIR current topic (if no topic yet, two different everyday topics they might want, e.g. "Let's talk about ..."): one very simple A2 reply, one a bit richer B1-B2 reply. Answer with ONLY JSON: {"hints":[{"en":"...","uz":"<Uzbek translation>"},{"en":"...","uz":"..."}]}`
      : `You help an Uzbek student who doesn't know what to answer in an English speaking lesson. Suggest 2 short, natural replies they could say next (one very simple A2 reply, one a bit richer B1-B2 reply). If it fits, use one of these target phrases: ${remaining.join(" | ") || "(none)"}. Answer with ONLY JSON: {"hints":[{"en":"...","uz":"<Uzbek translation>"},{"en":"...","uz":"..."}]}`,
    messages: [{ role: "user", content: `Lesson: ${lesson.title}. ${lesson.free ? "Sado" : "The teacher (Sado)"} just said: "${lastSado || (lesson.free ? FREE_OPENER : lesson.opener)}"` }],
  };
  if (SUPPORTS_FALLBACKS) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const response = await anthropic.beta.messages.create(params);
  if (response.stop_reason === "refusal") return [];
  const data = parseJson(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  return (Array.isArray(data?.hints) ? data.hints : [])
    .filter((h) => h && h.en)
    .slice(0, 3)
    .map((h) => ({ en: String(h.en).slice(0, 200), uz: String(h.uz || "").slice(0, 200) }));
}

// 🇺🇿 Sado gapining o'zbekcha tarjimasi (jonli suhbatda pufakchani bosganda). Kesh — bir xil gap qayta so'ralmaydi
const trCache = new Map();
export async function translateUz(text) {
  const key = text.trim();
  if (trCache.has(key)) return trCache.get(key);
  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 800,
    output_config: { effort: "low" },
    ...(FAST_NO_THINKING ? { thinking: { type: "disabled" } } : {}), // ⚡ yordamchi so'rovlar ham tezroq
    system: 'Translate the English text into natural, simple Uzbek (Latin script) for a learner. Answer with ONLY JSON: {"uz":"..."}',
    messages: [{ role: "user", content: key }],
  };
  if (SUPPORTS_FALLBACKS) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const response = await anthropic.beta.messages.create(params);
  if (response.stop_reason === "refusal") return "";
  const uz = String(parseJson(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""))?.uz || "").slice(0, 600);
  if (uz) {
    if (trCache.size > 2000) trCache.clear();
    trCache.set(key, uz);
  }
  return uz;
}
