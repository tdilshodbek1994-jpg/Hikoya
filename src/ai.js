import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "low"; // suhbat uchun tez javob
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const STT_MODEL = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const TTS_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";
const TTS_VOICE = process.env.TTS_VOICE || "coral";

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY muhit o'zgaruvchisidan o'qiladi

// Server tomonidagi zaxira model (refusal bo'lsa) faqat shu modellarda bor
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(CLAUDE_MODEL);

export const voiceEnabled = Boolean(OPENAI_KEY);

function systemPrompt(lesson) {
  const list = lesson.phrases.map((p, i) => `${i}. "${p.en}"`).join("\n");
  return `You are Sado, a warm and patient English speaking partner inside a Telegram app for Uzbek students preparing for exams.

Role-play: you are ${lesson.role}. ${lesson.situation}
Student level: about ${lesson.level}. You already opened the conversation by saying: "${lesson.opener}"

Target phrases the student should practise (index. phrase):
${list}

How to behave:
- Stay in character and keep the conversation natural. Reply in 1-2 short, simple English sentences (max ~30 words), because your reply is spoken aloud.
- Steer the conversation so the student gets chances to use the target phrases they have not used yet. Never read the list to them.
- The student's words come from speech recognition, so ignore small transcription glitches and punctuation.
- If the student writes or speaks Uzbek or Russian, gently answer in English and encourage them to try in English.
- A target phrase counts as used when the student says it or a clearly equivalent sentence (filled-in blanks like "My name is Aziz" count).

Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"reply": "<your spoken English reply>", "reply_uz": "<Uzbek translation of reply>", "used_phrases": [<indexes of target phrases the student used in THIS message>], "feedback_uz": "<one short friendly correction in Uzbek if the student made a clear grammar or word mistake, otherwise empty string>", "mood": "<one of: happy, neutral, curious, surprised>"}`;
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

// Bir suhbat bosqichi: o'quvchi gapi -> AI javobi
export async function chatTurn(session, lesson, studentText) {
  const remaining = lesson.phrases
    .map((_, i) => i)
    .filter((i) => !session.used.has(i));

  session.messages.push({
    role: "user",
    content: `Student said: "${studentText}"\n(Target phrases not used yet: ${remaining.length ? remaining.join(", ") : "none - all done, you can wrap up warmly"})`,
  });

  const params = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: CLAUDE_EFFORT },
    cache_control: { type: "ephemeral" },
    system: systemPrompt(lesson),
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
    return {
      reply: "Sorry, let's get back to our conversation. Could you say that another way?",
      reply_uz: "Kechirasiz, suhbatimizga qaytaylik. Buni boshqacha ayta olasizmi?",
      used_phrases: [],
      feedback_uz: "",
      mood: "neutral",
    };
  }

  // Javobni (thinking bloklari bilan birga) o'zgartirmasdan tarixga qo'shamiz
  session.messages.push({ role: "assistant", content: response.content });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const data = parseJson(text) || { reply: text.trim() };

  const used = Array.isArray(data.used_phrases)
    ? data.used_phrases.filter((i) => Number.isInteger(i) && i >= 0 && i < lesson.phrases.length)
    : [];

  return {
    reply: String(data.reply || "").slice(0, 600) || "Sorry, could you repeat that?",
    reply_uz: String(data.reply_uz || ""),
    used_phrases: used,
    feedback_uz: String(data.feedback_uz || ""),
    mood: ["happy", "neutral", "curious", "surprised"].includes(data.mood) ? data.mood : "neutral",
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
  form.append("language", "en");
  form.append("prompt", lesson.phrases.map((p) => p.en).join(" "));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription xatosi: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return String(json.text || "").trim();
}

// Matn -> ovoz (mp3, base64). Kalit bo'lmasa null - brauzer o'zi o'qiydi.
export async function speak(text) {
  if (!OPENAI_KEY || !text) return null;
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: "mp3",
      instructions: "Speak clearly, warmly and a little slower than normal, like a friendly English teacher.",
    }),
  });
  if (!res.ok) {
    console.error("TTS xatosi:", res.status, await res.text());
    return null;
  }
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}
