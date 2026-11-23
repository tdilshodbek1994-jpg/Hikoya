// Ovoz xizmatini tekshirish: node scripts/test-voice.js
// Kalitlarning o'zini ko'rsatmaydi, faqat bor-yo'qligi va xato sababini chiqaradi.
import "../src/env.js";
import { ttsRequest, geminiTts } from "../src/ai.js";

const key = process.env.OPENAI_API_KEY || "";
console.log("OPENAI_API_KEY:", key ? `bor (${key.length} belgi)` : "YO'Q!");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "bor" : "YO'Q!");
console.log("GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? "bor" : "yo'q (o'zbekcha ovoz OpenAI orqali)");
if (process.env.GEMINI_API_KEY) {
  try {
    const g = await geminiTts("Assalomu alaykum! Men Sado, ingliz tili ustozingizman.", "uz");
    console.log(`Gemini (${process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts"}):`, g.audio ? `ISHLAYAPTI ✅ (${g.mime}, ${g.audio.length})` : `XATO ❌ ${g.error}`);
  } catch (e) {
    console.log("Gemini: ULANISH XATOSI ❌", e.message);
  }
}
if (!key) process.exit(1);

const tests = [
  { name: process.env.TTS_MODEL || "gpt-4o-mini-tts", body: { model: process.env.TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.TTS_VOICE || "coral", input: "Hello, this is a test." } },
  { name: "tts-1 (zaxira)", body: { model: "tts-1", voice: "nova", input: "Hello, this is a test." } },
];
for (const t of tests) {
  try {
    const r = await ttsRequest(t.body);
    console.log(`${t.name}:`, r.audio ? `ISHLAYAPTI ✅ (${r.audio.length})` : `XATO ❌ ${r.error}`);
  } catch (e) {
    console.log(`${t.name}: ULANISH XATOSI ❌ ${e.message}`);
  }
}
