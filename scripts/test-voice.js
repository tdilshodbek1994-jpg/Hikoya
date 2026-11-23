// Ovoz xizmatini tekshirish: node scripts/test-voice.js
// Kalitlarning o'zini ko'rsatmaydi, faqat bor-yo'qligi va xato sababini chiqaradi.
import "../src/env.js";
import { ttsRequest } from "../src/ai.js";

const key = process.env.OPENAI_API_KEY || "";
console.log("OPENAI_API_KEY:", key ? `bor (${key.length} belgi)` : "YO'Q!");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "bor" : "YO'Q!");
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
