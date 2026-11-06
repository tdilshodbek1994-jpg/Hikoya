// Mobile smoke test: 360 px phone, reader + studio paths, overflow and paywall checks.
// usage: node e2e/smoke.cjs [baseUrl] [outDir]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:5173";
const out = process.argv[3] || "./e2e-shots";
const fs = require("fs");
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok, info }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${info}`); };

async function page(browser, tgId, scale = 1) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: scale, isMobile: true, hasTouch: true });
  await ctx.route(/telegram\.org/, (r) => r.abort());
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(base + "/");
  await p.evaluate((id) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("hk_dev_id", String(id)); }, tgId);
  await p.goto(base + "/");
  return { p, ctx, errors };
}

const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const browser = await chromium.launch();
  const tg = 7000000 + Math.floor(Math.random() * 100000);
  const { p, errors } = await page(browser, tg, 2);
  // T-01 onboarding skip
  await p.getByText("Hozircha o'tkazish").click();
  await p.waitForSelector(".stories, .section", { timeout: 10000 });
  await p.waitForTimeout(600);
  check("T-01 onboarding skip opens catalog", await p.locator(".section").count() > 0);
  // T-02 360px home: stories + genres at top, no horizontal overflow, nav does not hide content
  check("T-02 no horizontal overflow on home", await noOverflow(p));
  const order = await p.evaluate(() => [...document.querySelectorAll(".page > *")].map((e) => e.className).slice(0, 4).join("|"));
  check("T-02 stories and genre row at top", /stories/.test(order) && /chips/.test(order), order);
  const padBottom = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".page")).paddingBottom));
  check("T-02 bottom padding ≥ nav height", padBottom >= 64, String(padBottom));
  await p.screenshot({ path: `${out}/01-home.png`, fullPage: false });
  await p.screenshot({ path: `${out}/01-home-full.png`, fullPage: true });
  // tap targets
  const small = await p.evaluate(() => [...document.querySelectorAll(".nav a, .btn, .icon-btn")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5); }).length);
  check("tap targets ≥ 44px (nav/buttons)", small === 0, `small=${small}`);
  // catalogue filter T-03/T-04
  await p.goto(base + "/catalog?access=premium&genre=detektiv&status=ongoing");
  await p.waitForSelector(".grid, .empty");
  const titles = await p.locator(".grid .card .t").allTextContents();
  check("T-03 Premium+Detektiv+Ongoing filter", titles.length === 1 && titles[0].includes("Yettinchi"), titles.join(","));
  await p.screenshot({ path: `${out}/02-catalog.png` });
  // search T-05
  await p.goto(base + "/search");
  await p.fill(".search input", "карвонсарой");
  await p.waitForTimeout(900);
  const s = await p.locator(".grid .card .t").allTextContents();
  check("T-05 Cyrillic search finds work", s.length >= 1, s.join(","));
  // work page + premium paywall (T-52 in UI)
  await p.goto(base + "/catalog?access=premium&genre=detektiv");
  await p.locator(".grid .card").first().click();
  await p.waitForSelector(".hero");
  await p.screenshot({ path: `${out}/03-work.png` });
  check("work page no overflow", await noOverflow(p));
  // chapter 2 is locked → preview + paywall
  const locked = p.locator(".toc a").nth(1);
  await locked.click();
  await p.waitForSelector(".rtext");
  const paywall = await p.locator(".paywall").count();
  const blocks = await p.locator(".rtext [data-bid]").count();
  check("T-52 locked chapter shows preview + paywall only", paywall === 1 && blocks <= 3, `blocks=${blocks}`);
  await p.screenshot({ path: `${out}/04-paywall.png` });
  // free chapter: reader, settings, position restore T-12
  await p.goto(base + "/catalog?genre=oilaviy");
  await p.locator(".grid .card").first().click();
  await p.waitForSelector(".hero");
  await p.locator(".actions .btn.primary").click();
  await p.waitForSelector(".rtext [data-bid]");
  await p.screenshot({ path: `${out}/05-reader-dark.png` });
  await p.mouse.wheel(0, 900);
  await p.waitForTimeout(400);
  await p.evaluate(() => window.scrollTo(0, 900));
  await p.waitForTimeout(2200);
  const url = p.url();
  await p.click(".r-top [aria-label='Sozlamalar']").catch(async () => { await p.click(".rtext"); await p.click(".r-top [aria-label='Sozlamalar']"); });
  await p.getByRole("radio", { name: "Sepia" }).click();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/06-reader-sepia.png` });
  await p.goto(base + "/");
  await p.goto(url);
  await p.waitForSelector(".rtext [data-bid]");
  await p.waitForTimeout(800);
  const y = await p.evaluate(() => window.scrollY);
  check("T-12 reopening restores position", y > 300, `scrollY=${y}`);
  check("reader no overflow", await noOverflow(p));
  // like idempotent in UI
  await p.goto(base + "/premium");
  await p.waitForSelector(".panel");
  await p.screenshot({ path: `${out}/07-premium.png` });
  const demo = await p.getByText("Demo narx").count();
  check("demo price is not payable", demo > 0);
  await p.goto(base + "/library");
  await p.waitForSelector(".chips");
  await p.screenshot({ path: `${out}/08-library.png` });
  await p.goto(base + "/profile");
  await p.waitForSelector(".panel");
  await p.screenshot({ path: `${out}/09-profile.png` });
  // storis viewer
  await p.goto(base + "/");
  await p.waitForSelector(".stories .story");
  await p.locator(".stories .story").first().click();
  await p.waitForSelector(".sv-frame");
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/10-storis.png` });
  check("storis viewer opens", true);
  check("no JS errors (reader)", errors.length === 0, errors.join(" | ").slice(0, 300));

  // studio as owner
  const o = await page(browser, 1000, 2);
  await o.p.goto(base + "/studio");
  await o.p.waitForSelector(".lrow, .empty");
  await o.p.screenshot({ path: `${o.p ? out : out}/11-studio.png` });
  await o.p.locator(".lrow").first().click();
  await o.p.waitForSelector(".list");
  await o.p.screenshot({ path: `${out}/12-work-editor.png`, fullPage: true });
  await o.p.locator(".list .li a").first().click();
  await o.p.waitForSelector(".ProseMirror");
  await o.p.click(".ProseMirror");
  await o.p.keyboard.press("End");
  await o.p.keyboard.type(" Yangi gap.");
  await o.p.waitForTimeout(3500);
  const st = await o.p.locator(".save-state").textContent();
  check("editor autosave", /Saqlandi/.test(st || ""), st || "");
  await o.p.screenshot({ path: `${out}/13-editor.png` });
  await o.p.goto(base + "/admin");
  await o.p.waitForSelector(".kpis");
  await o.p.screenshot({ path: `${out}/14-admin.png` });
  check("no JS errors (studio)", o.errors.length === 0, o.errors.join(" | ").slice(0, 300));
  await browser.close();
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
