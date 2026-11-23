// Jonli suhbatni tekshirish: node scripts/test-live.js
// Gemini Live modellarini topadi, ulanadi va Sado'dan qisqa salom aytishini so'raydi.
import "../src/env.js";
import WebSocket from "ws";
import { listLiveModels, pickLiveModel } from "../src/live.js";

if (!process.env.GEMINI_API_KEY) {
  console.log("GEMINI_API_KEY yo'q ❌");
  process.exit(1);
}
try {
  const all = await listLiveModels();
  console.log("Jonli suhbat modellari:", all.length ? all.join(", ") : "YO'Q ❌");
} catch (e) {
  console.log("Modellar ro'yxati XATO ❌", e.message);
}
const model = await pickLiveModel().catch((e) => {
  console.log("Model tanlanmadi ❌", e.message);
  process.exit(1);
});
console.log("Tanlangan model:", model);

const url =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
  encodeURIComponent(process.env.GEMINI_API_KEY);
const ws = new WebSocket(url);
let audioBytes = 0;
let text = "";
const done = (msg) => {
  console.log(msg);
  console.log("Sado aytdi:", text || "(matn yo'q)");
  try { ws.close(); } catch {}
  process.exit(0);
};
setTimeout(() => done(audioBytes ? `Ovoz keldi ✅ (${audioBytes} bayt), lekin turn tugamadi` : "Javob kelmadi ❌ (20 soniya)"), 20000);
ws.on("open", () =>
  ws.send(JSON.stringify({
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      outputAudioTranscription: {},
    },
  })),
);
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.setupComplete) {
    console.log("Ulanish ✅");
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Say a short hello in Uzbek and then in English." }] }], turnComplete: true } }));
  }
  for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData?.data) audioBytes += Buffer.from(p.inlineData.data, "base64").length;
  if (m.serverContent?.outputTranscription?.text) text += m.serverContent.outputTranscription.text;
  if (m.serverContent?.turnComplete) done(audioBytes ? `JONLI SUHBAT ISHLAYAPTI ✅ (${audioBytes} bayt ovoz)` : "Turn tugadi, lekin ovoz yo'q ❌");
});
ws.on("close", (code, reason) => done(`Ulanish yopildi ❌ ${code} ${reason}`));
ws.on("error", (e) => done(`Ulanish xatosi ❌ ${e.message}`));
