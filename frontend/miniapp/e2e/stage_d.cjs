// Stage D mobile check (360 px): branching choices, audio-sync page, Russian interface.
// Needs a dev API with HIKOYA_DEV_AUTH_ENABLED=true. usage: node e2e/stage_d.cjs [baseUrl] [outDir]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:5173";
const out = process.argv[3] || "./e2e-shots";
const fs = require("fs");
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, info = "") => { results.push({ ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${info}`); };
async function api(path, { token, method = "GET", body } = {}) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const login = async (id) => (await api("/auth/dev", { method: "POST", body: { telegram_user_id: id, first_name: "E2E" } })).token;
async function page(browser, tgId) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route(/telegram\.org/, (r) => r.abort());
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(base + "/");
  await p.evaluate((id) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("hk_dev_id", String(id)); }, tgId);
  return { p, errors };
}

(async () => {
  const owner = await login(1000);
  const rnd = Math.floor(Math.random() * 1e6);
  const demo = (await api("/works?limit=1")).items[0];
  const authorId = (await api(`/works/${demo.code}`)).contributors[0].id;
  const para = (s) => Array.from({ length: 8 }, (_, i) => `${s} ${i + 1}. Tun sokin edi, faqat shamol eshik tirqishidan hushtak chalardi.`).join("\n\n");
  const w = await api("/studio/works", { token: owner, method: "POST", body: { title: `Tanlov sinovi ${rnd}`, synopsis: "Tarmoqlanuvchi hikoya", author_id: authorId } });
  const a = await api(`/studio/works/${w.id}/chapters`, { token: owner, method: "POST", body: { title: "Ikki eshik", text: para("Boshlanish") } });
  const b = await api(`/studio/works/${w.id}/chapters`, { token: owner, method: "POST", body: { title: "Qizil eshik", text: para("Qizil") } });
  const c = await api(`/studio/works/${w.id}/chapters`, { token: owner, method: "POST", body: { title: "Ko'k eshik", text: para("Ko'k") } });
  await api(`/studio/works/${w.id}/publish`, { token: owner, method: "POST", body: {} });
  await api(`/studio/chapters/${a.id}/choices`, { token: owner, method: "PUT", body: { items: [{ label: "Qizil eshikni ochish", target_chapter_id: b.id }, { label: "Ko'k eshikni ochish", target_chapter_id: c.id }] } });

  const browser = await chromium.launch();
  const tg = 7200000 + (rnd % 100000);
  const { p, errors } = await page(browser, tg);
  await p.goto(`${base}/read/${a.id}`);
  await p.waitForSelector(".btn.choice");
  const labels = await p.locator(".btn.choice").allInnerTexts();
  check("choices replace «Keyingi bob»", labels.length === 2 && labels[0].includes("Qizil") && (await p.getByText("Keyingi bob:").count()) === 0, labels.join(" | "));
  await p.locator(".btn.choice").last().scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${out}/d1-choices.png` });
  await p.locator(".btn.choice").nth(1).click();
  await p.waitForURL(new RegExp(`/read/${c.id}`));
  check("choice opens the target chapter", p.url().includes(`/read/${c.id}`));
  await p.goto(`${base}/read/${a.id}`);
  await p.waitForSelector(".btn.choice.primary");
  check("after choosing: own pick marked and percent shown", (await p.locator(".btn.choice.primary").innerText()).includes("100%"));

  // studio: choices manager + audio sync page render for the owner
  const o = await page(browser, 1000);
  await o.p.goto(`${base}/studio/sync/${a.id}`);
  await o.p.waitForSelector(".page h1, .page .list, .page p");
  await o.p.waitForTimeout(500);
  check("audio sync page renders (no audio yet → hint)", (await o.p.content()).includes("audio biriktiring"));

  // Russian interface
  const ru = await login(tg);
  await api("/me/preferences", { token: ru, method: "PATCH", body: { language: "ru" } });
  await p.goto(`${base}/profile`);
  await p.waitForTimeout(1200);
  const txt = await p.locator("body").innerText();
  check("Russian UI on profile", /Язык|Русский/.test(txt) && !txt.includes("Ilova tili"), txt.split("\n").slice(0, 6).join(" / "));
  await p.screenshot({ path: `${out}/d2-profile-ru.png` });
  await api("/me/preferences", { token: ru, method: "PATCH", body: { onboarding_done: true } });
  await p.goto(`${base}/`);
  await p.waitForSelector(".section");
  await p.screenshot({ path: `${out}/d3-home-ru.png` });
  check("no horizontal overflow (ru home)", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await api("/me/preferences", { token: ru, method: "PATCH", body: { language: "uz" } });
  check("no JS errors", errors.length === 0 && o.errors.length === 0, [...errors, ...o.errors].join(" ; "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
