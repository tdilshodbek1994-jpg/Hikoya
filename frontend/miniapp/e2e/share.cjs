// Share sheet check (360 px): opens from the work page, creates a tracked link, shows options.
// usage: node e2e/share.cjs [baseUrl] [outDir]   (dev auth)
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:5173";
const out = process.argv[3] || "./e2e-shots";
require("fs").mkdirSync(out, { recursive: true });
const results = [];
const check = (n, ok, i = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n} ${i}`); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.route(/telegram\.org/, (r) => r.abort());
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(base + "/");
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("hk_dev_id", String(7300000 + Math.floor(Math.random() * 1e5))); });
  await p.goto(base + "/catalog");
  await p.waitForSelector(".grid .card");
  await p.locator(".grid .card").first().click();
  await p.waitForSelector(".hero");
  await p.getByRole("button", { name: "Ulashish" }).click();
  await p.waitForSelector(".share-grid");
  await p.waitForTimeout(500);
  const opts = await p.locator(".share-opt").allInnerTexts();
  check("share sheet options", opts.some((o) => o.includes("Chatga yuborish")) && opts.some((o) => o.includes("Havolani nusxalash")), opts.join(" | ").replace(/\n/g, " "));
  await p.screenshot({ path: `${out}/s1-share-sheet.png` });
  await p.getByText("Havolani nusxalash").click();
  await p.waitForTimeout(800);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  check("copied link carries share id", /startapp=w_[a-z0-9]+__s\d+/.test(clip), clip);
  check("no overflow / no JS errors", (await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) && errs.length === 0, errs.join(";"));
  await b.close();
  const f = results.filter((x) => !x).length;
  console.log(`\n${results.length - f}/${results.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
