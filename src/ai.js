import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
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

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY muhit o'zgaruvchisidan o'qiladi

// Server tomonidagi zaxira model (refusal bo'lsa) faqat shu modellarda bor
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(CLAUDE_MODEL);

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
  return [
    {
      lang: "uz",
      text: `Assalomu alaykum! Men Sado, ingliz tili ustozingizman. Bugun "${lesson.title}" mavzusida 6 ta ibora o'rganamiz. Birinchi ibora: "${p.uz}". Inglizcha bunday deyiladi:`,
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
  return `You are Sado, a warm, patient English teacher for Uzbek students inside a Telegram app. You speak UZBEK as your main language and teach English phrases one by one. Everything you say is read aloud.${TUTOR_LEVEL[selfLevel] ? "\n" + TUTOR_LEVEL[selfLevel] : ""}

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
    "An Uzbek student practising English; they may speak English or Uzbek. " +
      lesson.phrases.map((p) => p.en).join(" "),
  );

  const res = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
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
  const res = await fetch(`${OPENAI_BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ response_format: "mp3", ...body }),
  });
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
export const ttsStats = { hits: 0, misses: 0 };

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
  const v = await speakUncached(text, lang, slow);
  if (v?.audio && text.length <= 400) {
    ttsCache.set(key, v);
    if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
  }
  return v;
}

async function speakUncached(text, lang, slow) {
  // O'zbekcha qismlar: avval Gemini (o'zbekchani tabiiyroq talaffuz qiladi)
  if (lang === "uz" && GEMINI_KEY && Date.now() > geminiPausedUntil) {
    try {
      const g = await geminiTts(text, "uz", slow);
      if (g.audio) return { audio: g.audio, mime: g.mime };
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

  const system = `You are an experienced English speaking examiner for Uzbek students. You write short, kind, practical feedback in simple Uzbek (Latin alphabet). Judge only the STUDENT's English (ignore their Uzbek sentences; speech-recognition may cause small spelling glitches - ignore those).

Answer with ONLY a JSON object, no markdown:
{"score": <0-100 overall speaking score for this lesson>,
 "level": "<${isIelts ? "estimated IELTS Speaking band, e.g. 'IELTS 5.5'" : "estimated CEFR level: A1, A2, B1, B2 or C1"}>",
 "summary_uz": "<1-2 sentences: overall impression>",
 "strengths_uz": ["<up to 2 things done well>"],
 "mistakes": [{"wrong": "<exact student phrase>", "right": "<corrected English>", "why_uz": "<short reason in Uzbek>"}],
 "tips_uz": ["<2 concrete tips for next time>"],
 "new_words": [{"en": "<useful word or phrase from the lesson topic>", "uz": "<translation>"}]${isIelts ? ',\n "criteria": {"fluency": <band 1-9, step 0.5>, "vocabulary": <band>, "grammar": <band>, "pronunciation": <band>}' : ""}}
Rules: at most 5 mistakes (most important first, only real mistakes), at most 5 new_words. If the student said very little, give a low score and encourage them.${lesson.category === "Bolalar uchun" ? `
The student is a CHILD (about 7-12 years old). Write every Uzbek text for a child: very simple words, warm and playful, address them with "sen", praise effort first, one short sentence per item, at most 2 mistakes (only the most important), at most 3 very simple new_words. Be generous with the score.` : ""}`;

  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    output_config: { effort: "low" },
    system,
    messages: [
      {
        role: "user",
        content: `Lesson: ${lesson.title} (${lesson.situation || ""}). Mode: ${mode}. Target phrases used: ${used} of ${total}.\n\nTranscript:\n${lines}`,
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
  };
}

// ---- 💡 Javob namunalari (o'quvchi nima deyishni bilmasa) ----
export async function suggestReplies(lesson, lastSado, used) {
  const remaining = lesson.phrases.filter((_, i) => !used.has(i)).map((p) => p.en);
  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    output_config: { effort: "low" },
    system: `You help an Uzbek student who doesn't know what to answer in an English speaking lesson. Suggest 2 short, natural replies they could say next (one very simple A2 reply, one a bit richer B1-B2 reply). If it fits, use one of these target phrases: ${remaining.join(" | ") || "(none)"}. Answer with ONLY JSON: {"hints":[{"en":"...","uz":"<Uzbek translation>"},{"en":"...","uz":"..."}]}`,
    messages: [{ role: "user", content: `Lesson: ${lesson.title}. The teacher (Sado) just said: "${lastSado || lesson.opener}"` }],
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
