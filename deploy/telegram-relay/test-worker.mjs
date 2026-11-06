// Local check of the relay's path filter: node deploy/telegram-relay/test-worker.mjs
import worker from "./worker.js";
const calls = [];
globalThis.fetch = async (u, init) => { calls.push([u, init.method]); return new Response('{"ok":true}', { headers: { "content-type": "application/json" } }); };
const env = { ALLOWED_BOT_ID: "12345" };
const req = (p, method = "POST") => new Request("https://r.example.workers.dev" + p, { method, body: method === "POST" ? "{}" : undefined, headers: { "content-type": "application/json" } });
const cases = [
  ["/bot12345:AAH-abc_DEF/getMe", 200],
  ["/bot12345:AAH-abc_DEF/test/sendMessage", 200],
  ["/file/bot12345:AAH-abc/documents/file_1.docx", 200],
  ["/bot99999:OTHER/getMe", 404],
  ["/https://evil.example/", 404],
  ["/bot12345:AAH/../../x", 404],
  ["/", 404],
];
let fail = 0;
for (const [p, want] of cases) {
  const r = await worker.fetch(req(p, p.startsWith("/file") ? "GET" : "POST"), env);
  const ok = r.status === want;
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", want, p);
}
console.log(calls.every(([u]) => u.startsWith("https://api.telegram.org/")) ? "PASS only api.telegram.org was called" : "FAIL foreign host");
process.exit(fail ? 1 : 0);
