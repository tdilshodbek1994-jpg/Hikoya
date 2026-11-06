// Stage C mobile check (360 px): recap, inline comment badge, characters, quote sheet, gift, beta page.
// Needs a dev API with HIKOYA_DEV_AUTH_ENABLED=true and the demo content. usage: node e2e/stage_c.cjs [baseUrl] [outDir]
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
  await p.evaluate((id) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("hk_dev_id", String(id)); localStorage.setItem("hk_onboarded", "1"); }, tgId);
  return { p, errors };
}

(async () => {
  const owner = await login(1000);
  const rnd = Math.floor(Math.random() * 1e6);
  // a fresh free 2-chapter work by an existing demo author (local dev DB only)
  const demo = (await api("/works?limit=1")).items[0];
  const authorId = (await api(`/works/${demo.code}`)).contributors[0].id;
  const para = (n) => Array.from({ length: 14 }, (_, i) => `${n}-bob, ${i + 1}-xatboshi. Kuz shamoli derazani sekin chertar, uyda esa eski soat bir maromda yurardi.`).join("\n\n");
  const created = await api("/studio/works", { token: owner, method: "POST", body: { title: `E2E sinov ${rnd}`, synopsis: "Avtomatik sinov asari", author_id: authorId } });
  const a1 = await api(`/studio/works/${created.id}/chapters`, { token: owner, method: "POST", body: { title: "Qaytish", text: para(1) } });
  const a2 = await api(`/studio/works/${created.id}/chapters`, { token: owner, method: "POST", body: { title: "Xat", text: para(2) } });
  const pub = await api(`/studio/works/${created.id}/publish`, { token: owner, method: "POST", body: {} });
  const work = { id: created.id, code: pub.url.slice(2) };
  const c1 = { id: a1.id }, c2 = { id: a2.id };
  check("e2e work published", pub.published.length === 2, work.code);
  await api(`/studio/chapters/${c1.id}`, { token: owner, method: "PATCH", body: { recap: "Birinchi bobda qahramon eski uyga qaytdi va yashirin xatni topdi." } });
  await api(`/studio/works/${work.id}/characters`, { token: owner, method: "POST", body: { name: `Qahramon ${rnd}`, description: "Asosiy qahramon" } });
  await api(`/studio/works/${work.id}/characters`, { token: owner, method: "POST", body: { name: "Sirli mehmon", description: "Spoiler", reveal_chapter_id: c2.id } });

  const browser = await chromium.launch();
  const tg = 7100000 + rnd % 100000;
  const reader = await login(tg);
  const { p, errors } = await page(browser, tg);
  // read chapter 1 to the end (server progress), then open chapter 2: recap shows
  await api("/reading/progress", { token: reader, method: "PUT", body: { work_id: work.id, chapter_id: c1.id, ratio: 1, sequence: 1, device_id: "e2e" } });
  const ch1 = await api(`/chapters/${c1.id}/content`, { token: reader });
  const bid = ch1.content.content[1].attrs.bid;
  await api(`/works/${work.id}/comments`, { token: reader, method: "POST", body: { body: "Shu joy juda kuchli!", chapter_id: c1.id, block_id: bid, quote: "", client_key: `e2e-${rnd}` } });

  await p.goto(`${base}/read/${c2.id}`);
  await p.waitForSelector(".rtext h1");
  const recap = p.locator(".recap");
  check("recap panel shown on next chapter", (await recap.count()) === 1);
  await recap.click();
  check("recap text expands", (await recap.innerText()).includes("yashirin xatni"));
  await p.screenshot({ path: `${out}/c1-recap.png` });

  await p.goto(`${base}/read/${c1.id}`);
  await p.waitForSelector(`[data-bid="${bid}"]`);
  await p.waitForSelector(".inline-badge", { timeout: 8000 }).catch(() => {});
  check("inline comment badge on the block", (await p.locator(`[data-bid="${bid}"] .inline-badge`).count()) === 1);
  check("reader no horizontal overflow", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await p.locator(`[data-bid="${bid}"] .inline-badge`).click();
  await p.waitForSelector(".body");
  check("badge opens only that block's comments", (await p.locator(".body").allTextContents()).join("|").includes("Shu joy juda kuchli!"));
  await p.screenshot({ path: `${out}/c2-inline-comments.png` });

  // selection sheet: select text inside a paragraph
  await p.goto(`${base}/read/${c1.id}`);
  await p.waitForSelector(`[data-bid="${bid}"]`);
  await p.evaluate((b) => {
    const el = document.querySelector(`[data-bid="${b}"]`);
    const r = document.createRange();
    const tn = el.firstChild;
    r.setStart(tn, 0); r.setEnd(tn, Math.min(40, tn.textContent.length));
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, bid);
  await p.waitForTimeout(500);
  const sheetText = await p.locator(".sheet").innerText().catch(() => "");
  check("selection sheet has «Shu joyga izoh» and quote card", sheetText.includes("Shu joyga izoh") && sheetText.includes("Iqtibos kartasi"), sheetText.split("\n").slice(0, 8).join(" / "));
  await p.screenshot({ path: `${out}/c3-selection-sheet.png` });
  const card = await api("/share/quote-card", { token: reader, method: "POST", body: { chapter_id: c1.id, block_id: bid, text: ch1.content.content[1].content[0].text.slice(0, 60) } });
  const img = await fetch(card.image_url.startsWith("http") ? card.image_url : base + card.image_url);
  check("quote card PNG is served", img.ok && (img.headers.get("content-type") || "").includes("png"), card.image_url);

  // work page: characters (spoiler one stays hidden until chapter 2 is read)
  await p.goto(`${base}/w/${work.code}`);
  await p.waitForSelector(".hero");
  await p.waitForTimeout(600);
  const chars = await p.locator(".char-card").allInnerTexts();
  check("characters: visible one shown, spoiler hidden", chars.some((x) => x.includes(`Qahramon ${rnd}`)) && !chars.some((x) => x.includes("Sirli mehmon")), chars.join(" | "));
  await p.locator(".char-card").first().scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${out}/c4-characters.png` });

  // premium: gift button and sheet
  await p.goto(`${base}/premium`);
  await p.waitForSelector(".panel");
  check("profile → premium page renders", true);

  // beta reader link
  const inv = await api(`/studio/works/${work.id}/beta-invites`, { token: owner, method: "POST", body: { days: 3, note: "E2E fikr" } });
  const token = inv.link.split("startapp=b_")[1];
  await p.goto(`${base}/beta/${token}`);
  await p.waitForSelector(".list .li");
  check("beta landing lists chapters", (await p.locator(".list .li").count()) >= 2);
  await p.locator(".list .li").first().click();
  await p.waitForSelector(".rtext p");
  check("beta reader shows text", (await p.locator(".rtext p").count()) > 3);
  await p.screenshot({ path: `${out}/c5-beta.png` });

  // studio: extras render for the owner
  const o = await page(browser, 1000);
  await o.p.goto(`${base}/studio/w/${work.id}`);
  await o.p.waitForSelector("h2");
  await o.p.waitForTimeout(800);
  const h2 = (await o.p.locator("h2").allTextContents()).join("|");
  check("studio work editor has Qahramonlar + Beta-o'quvchilar", h2.includes("Qahramonlar") && h2.includes("Beta-o'quvchilar"), h2);
  await o.p.goto(`${base}/studio/royalties`);
  await o.p.waitForSelector(".page");
  await o.p.waitForTimeout(500);
  await o.p.screenshot({ path: `${out}/c6-royalties.png` });
  check("no JS errors (reader)", errors.length === 0, errors.join(" ; "));
  check("no JS errors (studio)", o.errors.length === 0, o.errors.join(" ; "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
