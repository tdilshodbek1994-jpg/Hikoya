import { Mascot } from "./mascot.js";
import { LiveCall } from "./live.js?v=13";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg && tg.initData);
const $ = (id) => document.getElementById(id);

// ---------------- Holat ----------------
const state = {
  lessons: [],
  voiceEnabled: true,
  sessionMinutes: 10,
  // joriy dars
  session: null,
  lesson: null,
  used: new Set(),
  phraseIdx: 0,
  seconds: 0,
  left: 0,
  timer: null,
  mode: localStorage.getItem("sado-mode") === "hold" ? "hold" : "auto",
  subs: localStorage.getItem("sado-subs") === "1",
  tr: localStorage.getItem("sado-tr") !== "0", // o'zbekcha tarjimani ovozda aytish
  slow: localStorage.getItem("sado-slow") === "1", // 🐢 sekin gapirish
  phase: "idle", // idle | listening | thinking | speaking | ended
  textOnly: false,
};

const audio = {
  ctx: null,
  stream: null,
  micAnalyser: null,
  outAnalyser: null,
  recorder: null,
  chunks: [],
  mime: "",
  vadRaf: 0,
  source: null,
};

const mascot = new Mascot($("mascot"));
new Mascot($("heroMascot"));
const resultMascot = new Mascot($("resultMascot"));

// ---------------- Telegram ----------------
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.disableVerticalSwipes?.(); } catch {}

  try {
    const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
  } catch {}
  tg.BackButton?.onClick(() => onBack());
}

// Tun/kunduz rejimi: Telegram mavzusiga (yoki telefon sozlamasiga) moslashadi va o'zgarsa darhol yangilanadi
function applyTheme() {
  const pref = localStorage.getItem("sado-theme") || "auto"; // auto | light | dark
  const auto = inTelegram ? tg.colorScheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "auto" ? auto : pref === "dark";
  document.body.classList.toggle("dark", dark);
  try {
    const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
    tg?.setHeaderColor?.(bg);
    tg?.setBackgroundColor?.(bg);
  } catch {}
}
applyTheme();
tg?.onEvent?.("themeChanged", applyTheme);
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

// Aa: matn o'lchami (oddiy → katta → juda katta)
const FONT_STEPS = [1, 1.12, 1.25];
function applyFont() {
  const i = Number(localStorage.getItem("sado-font")) || 0;
  document.documentElement.style.setProperty("--zoom", FONT_STEPS[i % FONT_STEPS.length]);
  return i;
}
applyFont();

function haptic(type = "light") {
  try {
    if (type === "success" || type === "error") tg?.HapticFeedback?.notificationOccurred(type);
    else tg?.HapticFeedback?.impactOccurred(type);
  } catch {}
}

function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

const SADO_BUILD = (document.querySelector('script[src^="app.js"]')?.getAttribute("src") || "").split("v=")[1] || "0";
// ⏱ Har qanday so'rov ko'pi bilan 60 s kutiladi — server yoki AI javob bermasa ilova qotib qolmaydi
async function api(path, { json, body, headers = {}, method = "POST", timeout = 60_000 } = {}) {
  // X-Sado-Build: server yangi ilova ekanini biladi (eski, keshda qolgan nusxalarga kesh tozalash buyrug'i yuboriladi)
  const h = { "X-Telegram-Init-Data": tg?.initData || "", "X-Sado-Build": SADO_BUILD, ...headers };
  if (json) h["Content-Type"] = "application/json";
  let res;
  // ⏱ Cheksiz kutib qolmaslik uchun (masalan hisobot)
  const ac = timeout ? new AbortController() : null;
  const tm = ac && setTimeout(() => ac.abort(), timeout);
  try {
    res = await fetch(path, { method, headers: h, body: json ? JSON.stringify(json) : body, signal: ac?.signal });
  } catch (e) {
    if (e?.name === "AbortError") throw Object.assign(new Error("Server javob bermadi ⏱"), { network: true });
    throw Object.assign(new Error("Internet bilan aloqa yo'q 📶"), { network: true });
  } finally {
    clearTimeout(tm);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Xatolik (${res.status})`), { status: res.status });
  return data;
}

// ---------------- Ekranlar ----------------
// Sado boshqa ilova ichidan (masalan UzDTM sahifasidan) ochilgan bo'lsa,
// bosh sahifada ham "orqaga" tugmasi o'sha ilovaga qaytaradi.
const canExit = history.length > 1 || /^https?:/.test(document.referrer);

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("active", s.id === id);
  // Oldingi ekrandagi xabar yangi ekranga o'tib qolmasin
  clearTimeout(toast.t);
  $("toast").hidden = true;
  const back = id !== "home" || canExit;
  if (inTelegram) back ? tg.BackButton.show() : tg.BackButton.hide();
  else $("backBtn").hidden = !back;
  window.scrollTo(0, 0);
}

$("backBtn").addEventListener("click", () => onBack());


function onBack() {
  // Ochiq oyna (masalan ⚙️ Sozlamalar) bo'lsa — avval uni yopamiz, darsni emas
  const open = [...document.querySelectorAll(".sheet")].filter((s) => !s.hidden);
  if (open.length) return void (open[open.length - 1].hidden = true);
  if ($("lesson").classList.contains("active")) {
    confirmEnd();
  } else if ($("home").classList.contains("active")) {
    if (canExit) history.back();
  } else {
    show("home");
  }
}

function confirmEnd() {
  const ask = "Darsni tugatasizmi?";
  if (inTelegram && tg.showConfirm) tg.showConfirm(ask, (ok) => ok && finish());
  else if (confirm(ask)) finish();
}

// ---------------- Darslar ro'yxati ----------------
// 🆕 Oxirgi kirishdan keyin qo'shilgan darslar (birinchi kirishda hech narsa "yangi" emas)
function trackNewLessons(lessons) {
  const ids = lessons.map((l) => l.id);
  let known = null;
  try { known = JSON.parse(localStorage.getItem("sado-known") || "null"); } catch {}
  if (!Array.isArray(known)) {
    localStorage.setItem("sado-known", JSON.stringify(ids));
    state.newIds = new Set();
    addDated(lessons);
    return;
  }
  const k = new Set(known);
  // Yangi darslar 14 kun davomida "yangi" bo'lib turadi
  let fresh = {};
  try { fresh = JSON.parse(localStorage.getItem("sado-fresh") || "{}"); } catch {}
  const now = Date.now();
  for (const id of ids) if (!k.has(id) && !fresh[id]) fresh[id] = now;
  for (const id of Object.keys(fresh)) if (now - fresh[id] > 14 * 86400_000 || !ids.includes(id)) delete fresh[id];
  localStorage.setItem("sado-fresh", JSON.stringify(fresh));
  localStorage.setItem("sado-known", JSON.stringify(ids));
  state.newIds = new Set(Object.keys(fresh));
  addDated(lessons);
}
// Serverda qo'shilgan sanasi ko'rsatilgan darslar — 14 kun davomida hammaga "yangi"
// Faqat foydalanuvchi birinchi kirgan kundan KEYIN qo'shilganlari — yangi o'quvchiga hamma dars "yangi" ko'rinmasin
function addDated(lessons) {
  let first = localStorage.getItem("sado-first");
  if (!first) localStorage.setItem("sado-first", (first = new Date().toISOString().slice(0, 10)));
  for (const l of lessons) if (l.added && l.added > first && Date.now() - Date.parse(l.added) < 14 * 86400_000) state.newIds.add(l.id);
}

function applyLessons(data) {
  trackNewLessons(data.lessons);
  state.lessons = data.lessons;
  if (!$("newsSheet").hidden) showNews(); // darslar yuklangach — yangiliklardagi sonlar aniq bo'ladi
  state.voiceEnabled = data.voiceEnabled;
  state.liveEnabled = Boolean(data.liveEnabled);
  state.sessionMinutes = data.sessionMinutes;
  state.shareUrl = data.shareUrl || "";
  if (data.version) $("appVer").textContent = `${$("appVer").textContent.split(" · ")[0]} · server ${data.version}`;
  renderChips();
  renderLessons();
}
async function loadLessons() {
  // ⚡ Oldingi safar saqlangan ro'yxat darhol chiqadi, yangisi fonda yuklanadi
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem("sado-lessons") || "null");
  } catch {}
  let progStarted = false;
  if (cached?.lessons?.length && !state.lessons.length) {
    applyLessons(cached);
    progStarted = true;
    loadProgress(); // statistika ham darslar bilan parallel yuklanadi
  }
  // ⚡ Birinchi kirishda ham statistika so'rovi darslar bilan bir vaqtda yuboriladi (javobi keyin qo'llanadi)
  const progEarly = progStarted ? null : api("api/progress", { method: "GET" });
  progEarly?.catch(() => {}); // xato loadProgress ichida ko'riladi
  try {
    const data = await api("api/lessons", { method: "GET" });
    const fresh = JSON.stringify(data);
    if (fresh !== JSON.stringify(cached)) {
      applyLessons(data);
      try { localStorage.setItem("sado-lessons", fresh); } catch {}
    }
    if (!progStarted) loadProgress(progEarly);
    if (!inTelegram) $("homeNote").textContent = "Eslatma: ilova Telegram bot orqali ochilganda to'liq ishlaydi.";
  } catch (e) {
    if (state.lessons.length) return toast("📶 Internet sekin — saqlangan ro'yxat ko'rsatilmoqda", 3000);
    $("lessonList").innerHTML = "";
    $("homeNote").textContent = "Darslarni yuklab bo'lmadi. Internetni tekshiring.";
  }
  // Yuklanish paytida bosilgan "Gaplashishni boshlash" — endi bajariladi
  if (state.pendingFree) {
    state.pendingFree = false;
    $("freeHero").click();
  }
}

const tashDay = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
async function loadProgress(early) {
  // ⚡ Saqlangan statistika darhol ko'rinadi (faqat shu foydalanuvchiniki), yangisi keyin keladi
  const uid = String(tg?.initDataUnsafe?.user?.id || "dev");
  if (!state.progress) {
    try {
      const c = JSON.parse(localStorage.getItem("sado-progress") || "null");
      if (c?.uid === uid && c.data) {
        state.progress = c.data;
        // Kesh kechagi bo'lsa — "bugungi" hisoblagichlar nolga tushadi (limit noto'g'ri ko'rinmasin)
        if (c.day !== tashDay()) Object.assign(state.progress, { startedToday: 0, today: 0 });
        renderChips();
        renderLessons();
      }
    } catch {}
  }
  try {
    state.progress = await (early || api("api/progress", { method: "GET" }));
    try { localStorage.setItem("sado-progress", JSON.stringify({ uid, day: tashDay(), data: state.progress })); } catch {}
    if (!localStorage.getItem("sado-badges")) localStorage.setItem("sado-badges", JSON.stringify(BADGES.filter((b) => b[3](state.progress)).map((b) => b[1])));
    renderChips();
    renderLessons();
  } catch {
    // Telegram'siz ochilgan bo'lsa progress ko'rsatilmaydi
  }
}

// 🎯 Kunlik maqsad: bugun nechta dars (maqsadni bosib 1 → 2 → 3 ga almashtirish mumkin)
// 🔧 Oldingi versiyada tanishuvdagi maqsad (bo'lim nomi) ham "sado-goal"ga yozilgan edi — "sado-aim"ga ko'chiramiz
if (localStorage.getItem("sado-goal") && !/^[123]$/.test(localStorage.getItem("sado-goal"))) {
  localStorage.setItem("sado-aim", localStorage.getItem("sado-goal"));
  localStorage.removeItem("sado-goal");
}
state.goal = Number(localStorage.getItem("sado-goal")) || 1;
function renderGoal() {
  const p = state.progress;
  const box = $("goal");
  if (!p) return (box.hidden = true);
  box.hidden = false;
  const n = Math.min(p.today || 0, state.goal);
  const done = (p.today || 0) >= state.goal;
  box.classList.toggle("done", done);
  box.innerHTML = "";
  const ring = el("span", "goal-ring", `${n}/${state.goal}`);
  ring.style.setProperty("--p", Math.round((n / state.goal) * 100));
  const txt = el("span", "goal-text");
  txt.append(
    el("b", "", done ? "🎉 Bugungi maqsad bajarildi!" : "🎯 Bugungi maqsad"),
    el("small", "", done ? "Ertaga ham davom eting — seriya uzilmasin 🔥" : `Kuniga ${state.goal} ta dars · bosing — maqsadni o'zgartirish`),
  );
  box.append(ring, txt);
  // ▶️ Maqsad bajarilmagan bo'lsa — bir bosishda keyingi darsni ochish
  if (!done) {
    const go = el("span", "goal-go", "▶️ Boshlash"); // #goal o'zi tugma — ichida <button> bo'lmasin
    go.setAttribute("role", "button");
    go.addEventListener("click", (e) => {
      e.stopPropagation(); // kartani bosish maqsadni o'zgartiradi — bu tugma emas
      haptic("medium");
      const nx = nextLesson();
      if (nx) openSheet(nx);
      else document.querySelector(".chip-f.rnd")?.click();
    });
    box.append(go);
  }
  // 🔥 Kechqurun (18:00 dan keyin) seriya bor-u bugun dars yo'q — uzilib qolmasin deb eslatamiz
  const hour = new Date(Date.now() + 5 * 3600_000).getUTCHours();
  if (p.streak > 0 && !n && hour >= 18) {
    box.classList.add("risk");
    txt.lastChild.textContent = `🔥 ${p.streak} kunlik seriyangiz bugun uzilishi mumkin — bitta qisqa dars yetadi!`;
  } else box.classList.remove("risk");
  // Kunlik limit: qancha dars qolgani
  if (p.limit) {
    const left = Math.max(0, p.limit - (p.startedToday || 0));
    box.append(el("span", "goal-left" + (left <= 2 ? " low" : ""), left ? `${left} ta dars qoldi` : "Limit tugadi"));
  }
}

function renderStats() {
  const p = state.progress;
  const box = $("stats");
  if (!p) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  [
    ["🔥", p.streak, "kun seriya"],
    ["✅", p.done, "dars o'tildi"],
    ["⏱️", p.minutes, "daqiqa"],
  ].forEach(([ico, n, label]) => {
    const d = el("div", "stat");
    d.append(el("b", "", `${ico} ${n}`), el("span", "", label));
    box.append(d);
  });
}

const CAT_ICONS = { "Erkin suhbat": "💬", Imtihonlar: "🏆", "IELTS kursi": "📘", "CEFR kursi": "📗", "Grammatika gapirib": "✏️", "Kundalik hayot": "🏠", Sayohat: "✈️", "O'qish va ish": "🎓", "Biznes va IT": "💼", "Bolalar uchun": "🧒" };
state.filter = { cat: "", q: "" };
// ⭐ Sevimli darslar (telefonda saqlanadi)
state.favs = new Set(JSON.parse(localStorage.getItem("sado-favs") || "[]"));
function toggleFav(id) {
  state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
  localStorage.setItem("sado-favs", JSON.stringify([...state.favs]));
}

const isHard = (l) => /^B2|C1|C2/.test(l.level || "");

// 60 balldan past darslar — takrorlash uchun
const WEAK = 60;
// Necha kun oldin o'tilgan (Toshkent vaqti)
function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  return Math.round((Date.parse(t) - Date.parse(dateStr)) / 86400_000);
}
const STALE = 7; // shuncha kundan keyin takrorlash tavsiya etiladi
function weakIds() {
  const ls = state.progress?.lessons || {};
  return Object.keys(ls).filter(
    (id) => id !== "review" && (ls[id].best < WEAK || daysSince(ls[id].last) >= STALE) && state.lessons.some((l) => l.id === id && !l.liveOnly),
  );
}

function lessonButton(l) {
  const b = document.createElement("button");
  b.className = "lesson";
  b.innerHTML = `
    <div class="lesson-emoji"></div>
    <div class="lesson-info"><div class="lesson-title"></div><div class="lesson-sub"></div></div>
    <span class="lesson-level"></span>`;
  b.querySelector(".lesson-emoji").textContent = l.emoji;
  b.querySelector(".lesson-title").textContent = l.title;
  b.querySelector(".lesson-sub").textContent = `${l.phrases.length} ta ibora · ${l.minutes || state.sessionMinutes} daqiqa`;
  b.querySelector(".lesson-level").textContent = (state.favs.has(l.id) ? "⭐ " : "") + l.level;
  const pr = state.progress?.lessons?.[l.id];
  if (!pr && state.newIds?.has(l.id)) b.querySelector(".lesson-title").append(el("span", "new-tag", "🆕 Yangi"));
  if (pr) {
    b.classList.add("done");
    b.querySelector(".lesson-sub").textContent = `✅ O'tildi · ${pr.best} ball`;
    // 🔁 Past ball — takrorlash tavsiya etiladi
    if (pr.best < WEAK && !l.liveOnly) {
      b.classList.add("weak");
      b.querySelector(".lesson-sub").textContent = `🔁 Takrorlang · ${pr.best} ball`;
    } else if (!l.liveOnly && daysSince(pr.last) >= STALE) {
      b.classList.add("weak");
      b.querySelector(".lesson-sub").textContent = `✅ ${pr.best} ball · 🔁 ${daysSince(pr.last)} kun oldin`;
    }
  }
  // ⭐ Bolalar darslari: natija yulduzlarda (90+ → 3, 60+ → 2, qolgani → 1)
  if (l.category === "Bolalar uchun") {
    const sub = b.querySelector(".lesson-sub");
    if (pr) {
      const n = pr.best >= 90 ? 3 : pr.best >= 60 ? 2 : 1;
      sub.textContent = `${"⭐".repeat(n)}${"☆".repeat(3 - n)} · ${pr.best} ball`;
      sub.classList.add("kid-stars");
    } else sub.textContent = `🎈 ${l.phrases.length} ta so'z · ${l.minutes || state.sessionMinutes} daqiqa`;
  }
  // 🧩 Grammatika mashqining eng yaxshi natijasi
  const qz = quizBest()[l.id];
  if (qz) b.querySelector(".lesson-sub").textContent += `\u00a0· 🧩\u00a0${qz}`; // "🧩 4/4" bo'linmasin
  // 🎯 Mavzu bo'yicha test aniqligi; 8+ javob va 80%+ bo'lsa — 🎓 o'zlashtirildi
  const ts = l.quiz?.length ? quizStats().by?.[l.id] : null;
  if (ts?.all >= 3) {
    const pct = Math.round((ts.ok / ts.all) * 100);
    const mastered = ts.all >= 8 && pct >= 80;
    const tag = el("span", "acc-tag " + (mastered ? "hi" : pct >= 50 ? "mid" : "lo"), mastered ? `🎓 ${pct}%` : `🎯 ${pct}%`);
    tag.title = mastered ? "Mavzu o'zlashtirildi" : "Testlardagi aniqlik";
    b.querySelector(".lesson-sub").append(" ", tag);
    if (mastered) b.classList.add("mastered");
  }
  b.addEventListener("click", () => openSheet(l));
  return b;
}

// 🧩 Tez mashq: qoida misollaridan bo'sh joyni to'ldirish (chalkash so'zlar guruhlari)
// Faqat bitta javob to'g'ri bo'ladigan guruhlar (moslashish: was/were, am/is/are, do/does, a/an ...)
const QZ_GROUPS = [["was", "were"], ["am", "is", "are"], ["do", "does"], ["a", "an"], ["much", "many"], ["some", "any"], ["have", "has"], ["to", "for"], ["by", "from"]];
function quizItems(rule) {
  // ✗ belgili noto'g'ri misollar mashqqa kirmaydi
  const sents = rule.split("\n").flatMap((line) => [...line.matchAll(/[A-Z][A-Za-z0-9' ,]*[A-Za-z0-9][.?!]/g)].filter((m) => !/✗\s*$/.test(line.slice(0, m.index)) && !/[a-z]\s*$/.test(line.slice(0, m.index)) && !line.startsWith("..", m.index + m[0].length)).map((m) => m[0]))
    .filter((t, i, a) => t.split(" ").length >= 3 && EN_HINT.test(t) && a.indexOf(t) === i);
  const items = [];
  for (const t of sents) {
    const words = t.split(" ");
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[.,?!]/g, "");
      const g = QZ_GROUPS.find((gr) => gr.includes(w.toLowerCase()));
      if (!g) continue;
      const cap = (x) => (i === 0 ? x[0].toUpperCase() + x.slice(1) : x);
      items.push({ text: t, before: words.slice(0, i).join(" "), after: words[i].slice(w.length) + " " + words.slice(i + 1).join(" "), answer: cap(w.toLowerCase()), options: g.map(cap) });
      break;
    }
  }
  return items.slice(0, 4);
}
// 🧩 Nechta grammatika mavzusida test xatosiz ishlangan (12/12, 4/4 ...)
const grPerfectCount = () => {
  const best = quizBest();
  return state.lessons.filter((l) => l.category === "Grammatika gapirib" && (() => { const [a, n] = String(best[l.id] || "").split("/").map(Number); return n > 0 && a === n; })()).length;
};
const quizBest = () => { try { return JSON.parse(localStorage.getItem("sado-quiz") || "{}"); } catch { return {}; } };
function saveQuiz(id, right, total) {
  const all = quizBest();
  // Ulush bo'yicha solishtiramiz (4 savollik va 12 savollik testlar aralashmasin); teng bo'lsa — ko'proq savollisi
  const [pr, pn] = String(all[id] || "0/1").split("/").map(Number);
  const ratio = (r, n) => (n ? r / n : 0);
  if (ratio(right, total) > ratio(pr, pn) || (ratio(right, total) === ratio(pr, pn) && total >= pn)) { all[id] = `${right}/${total}`; localStorage.setItem("sado-quiz", JSON.stringify(all)); }
}
// 🔁 Xato qilingan test savollari (localStorage): xato — qo'shiladi, keyin to'g'ri javob — o'chiriladi
const quizMisses = () => { try { return JSON.parse(localStorage.getItem("sado-qz-miss") || "[]"); } catch { return []; } };
// 🎯 Umumiy aniqlik: barcha testlardagi javoblar
const quizStats = () => { try { return JSON.parse(localStorage.getItem("sado-qz-stats")) || { ok: 0, all: 0 }; } catch { return { ok: 0, all: 0 }; } };
// 👁 Ko'rilgan savollar (qisqa xesh bilan) — aralash test avval yangilarini beradi
const qKey = (it) => phraseHash(`${it.before}|${it.after}|${it.answer}`).toString(36);
const seenSet = () => { try { return new Set(JSON.parse(localStorage.getItem("sado-qz-seen") || "[]")); } catch { return new Set(); } };
function quizMiss(it, lessonId, ok) {
  if (it.before != null) {
    const seen = seenSet();
    seen.add(qKey(it));
    try { localStorage.setItem("sado-qz-seen", JSON.stringify([...seen].slice(-2000))); } catch {}
  }
  const st = quizStats();
  st.all++;
  if (ok) st.ok++;
  // Mavzu bo'yicha ham
  const tid = it.from || lessonId;
  if (tid && /^gr-/.test(tid) && !/^gr-(mix|miss)/.test(tid)) {
    st.by ||= {};
    const t = (st.by[tid] ||= { ok: 0, all: 0 });
    t.all++;
    if (ok) t.ok++;
  }
  localStorage.setItem("sado-qz-stats", JSON.stringify(st));
  if (!it.options) return;
  const text = `${it.before} ___${it.after}`;
  let list = quizMisses().filter((q) => q.text !== text);
  if (!ok) list.unshift({ text, answer: it.answer, options: it.options, from: it.from || lessonId });
  localStorage.setItem("sado-qz-miss", JSON.stringify(list.slice(0, 60)));
}
// Ro'yxat qayta chizilganda sahifa joyi saqlanadi (test tugagach yuqoriga sakrab ketmasin)
function keepScroll(fn) {
  const y = window.scrollY;
  fn();
  window.scrollTo(0, y);
}

// 📖 Barcha grammatika qoidalari — bitta ma'lumotnoma (qidiruv, daraja bo'yicha)
function openRules() {
  state.speedRun = (state.speedRun || 0) + 1;
  $("mixSheet").hidden = false;
  $("mixLevels").innerHTML = "";
  const box = $("mixQuiz");
  box.innerHTML = "";
  const gr = state.lessons.filter((l) => l.category === "Grammatika gapirib" && l.rule);
  box.append(el("b", "", `📖 Grammatika qoidalari · ${gr.length} ta mavzu`));
  const q = el("input", "vocab-search rules-search");
  q.type = "search";
  q.placeholder = "🔍 Qidirish: past, have, artikl…";
  const list = el("div", "rules-list");
  // 📊 Har mavzu yonida test aniqligi; «⚠️ Avval zaiflari» — eng past aniqlikdagilar tepada
  const by = quizStats().by || {};
  const acc = (id) => (by[id]?.all ? Math.round((by[id].ok / by[id].all) * 100) : null);
  let weakFirst = false;
  const sortBtn = el("button", "chip-f rules-sort", "⚠️ Avval zaiflari");
  sortBtn.hidden = !Object.keys(by).length;
  sortBtn.addEventListener("click", () => { haptic(); weakFirst = !weakFirst; sortBtn.classList.toggle("on", weakFirst); render(); });
  const render = () => {
    list.innerHTML = "";
    const t = q.value.trim().toLowerCase();
    let last = "";
    const items = weakFirst ? gr.filter((l) => acc(l.id) !== null).sort((a, b) => acc(a.id) - acc(b.id)) : gr;
    for (const l of items) {
      if (t && !(l.title + " " + l.rule).toLowerCase().includes(t)) continue;
      const lv = mixLevelOf(l.level);
      if (!weakFirst && lv !== last) { last = lv; list.append(el("div", "part-title", { beg: "🌱 A1–A2", mid: "🌿 B1", adv: "🌳 B2" }[lv])); }
      const d = document.createElement("details");
      d.className = "rule-item";
      const sm = document.createElement("summary");
      sm.textContent = `${l.emoji} ${l.title.replace(/^\d+\.\s*/, "")}`;
      const a = acc(l.id);
      if (a !== null) sm.append(el("span", "rule-acc " + (a >= 80 ? "hi" : a >= 50 ? "mid" : "lo"), `${a}%`));
      const go = el("button", "rep-grlink", "🧩 Mashq ›");
      go.addEventListener("click", () => { haptic(); $("mixSheet").hidden = true; openSheet(l); setTimeout(() => $("sheetQuiz").scrollIntoView({ behavior: "smooth", block: "start" }), 350); });
      d.append(sm, ruleBody(l.rule), go);
      if (t) d.open = true;
      list.append(d);
    }
    if (!list.children.length) list.append(el("p", "qz-n", "Hech narsa topilmadi"));
  };
  q.addEventListener("input", render);
  box.append(q, sortBtn, list);
  render();
}

// 📊 Daraja testi: 20 savol (7 boshlang'ich, 7 o'rta, 6 yuqori) → taxminiy grammatika darajasi
function openLevelTest() {
  state.speedRun = (state.speedRun || 0) + 1;
  const gr = state.lessons.filter((l) => l.category === "Grammatika gapirib");
  const take = (lv, n) => gr.filter((l) => mixLevelOf(l.level) === lv)
    .flatMap((l) => (l.quiz || []).map((q) => ({ ...q, from: l.id })))
    .sort(() => Math.random() - 0.5).slice(0, n);
  // Osondan qiyinga: avval boshlang'ich, keyin o'rta, keyin yuqori
  const quiz = [...take("beg", 7), ...take("mid", 7), ...take("adv", 6)];
  if (quiz.length < 10) return;
  state.mixWeak = new Map();
  $("mixSheet").hidden = false;
  $("mixLevels").innerHTML = "";
  renderQuiz({ id: "gr-level", quiz, ordered: true }, $("mixQuiz"), "📊 Daraja testi · 20 savol", quiz.length);
}
function levelTestResult(items, marks, body) {
  const by = { beg: [0, 0], mid: [0, 0], adv: [0, 0] };
  items.forEach((it, k) => {
    const l = state.lessons.find((x) => x.id === it.from);
    const lv = mixLevelOf(l?.level || "");
    by[lv][1]++;
    if (marks[k] === "🟩") by[lv][0]++;
  });
  const p = (lv) => (by[lv][1] ? by[lv][0] / by[lv][1] : 0);
  const level = p("beg") >= 0.7 && p("mid") >= 0.7 && p("adv") >= 0.6 ? "B2" : p("beg") >= 0.7 && p("mid") >= 0.6 ? "B1" : p("beg") >= 0.6 ? "A2" : "A1";
  localStorage.setItem("sado-gr-level", level);
  const box = el("div", "lv-result");
  box.append(el("b", "", `🎓 Grammatika darajangiz: ~${level}`));
  for (const [lv, name] of [["beg", "🌱 A1–A2"], ["mid", "🌿 B1"], ["adv", "🌳 B2"]]) {
    const row = el("div", "lv-row");
    const bar = el("span", "ts-bar");
    const pc = Math.round(p(lv) * 100);
    const fill = el("i", pc >= 70 ? "hi" : pc >= 50 ? "mid" : "lo");
    fill.style.width = `${Math.max(4, pc)}%`;
    bar.append(fill);
    row.append(el("span", "", name), bar, el("b", "", `${by[lv][0]}/${by[lv][1]}`));
    box.append(row);
  }
  if (level === "B2") box.append(el("small", "qz-n", "Zo'r! Endi IELTS/CEFR kurslarida gapirib mustahkamlang."));
  else {
    // ▶ Keyingi daraja mavzularidan testni shu yerning o'zidan boshlash
    const [key, name] = level === "A1" ? ["beg", "🌱 A1–A2"] : level === "A2" ? ["mid", "🌿 B1"] : ["adv", "🌳 B2"];
    box.append(el("small", "qz-n", `Keyingi daraja uchun ${name} mavzularini mustahkamlang:`));
    const go = el("button", "btn primary wide lv-go", `▶ ${name} testini boshlash`);
    go.addEventListener("click", () => { haptic(); openMixTest(key); });
    box.append(go);
  }
  body.append(box);
}

// 📅 Bugungi test: har kuni 5 ta savol (sana bo'yicha, hamma uchun bir xil), 🔥 seriya
const dayNum = () => Math.floor((Date.now() + 5 * 3600_000) / 86400_000);
const dailyTest = () => { try { return JSON.parse(localStorage.getItem("sado-daily-test")) || {}; } catch { return {}; } };
function dailyTestDone(right, total) {
  const d = dailyTest();
  const today = dayNum();
  if (d.day === today) return; // bugun allaqachon hisoblangan
  d.streak = d.day === today - 1 ? (d.streak || 0) + 1 : 1;
  d.best = Math.max(d.best || 0, d.streak); // 🏅 «Test seriyasi» yutug'i uchun eng uzun seriya
  d.day = today;
  d.score = `${right}/${total}`;
  localStorage.setItem("sado-daily-test", JSON.stringify(d));
  toast(`📅 Bugungi test: ${right}/${total} · 🔥 ${d.streak} kun ketma-ket`, 3000);
}
function openDailyTest() {
  state.speedRun = (state.speedRun || 0) + 1;
  const all = state.lessons
    .filter((l) => l.category === "Grammatika gapirib")
    .flatMap((l) => (l.quiz || []).map((q) => ({ ...q, from: l.id })));
  const day = dayNum();
  const quiz = all.map((q) => [phraseHash(`${day}|q|${q.text}`), q]).sort((a, b) => a[0] - b[0]).slice(0, 5).map((x) => x[1]);
  if (!quiz.length) return;
  state.mixWeak = new Map();
  $("mixSheet").hidden = false;
  $("mixLevels").innerHTML = "";
  const d = dailyTest();
  renderQuiz({ id: "gr-daily", quiz }, $("mixQuiz"), d.day === day ? `📅 Bugungi test · ✅ ${d.score} (qayta ishlash)` : "📅 Bugungi test · 5 ta savol", 5);
}

// 🎯 Mavzular bo'yicha aniqlik: eng zaif mavzular tepada
function openTopicStats() {
  state.speedRun = (state.speedRun || 0) + 1;
  const st = quizStats();
  $("mixSheet").hidden = false;
  $("mixLevels").innerHTML = "";
  const box = $("mixQuiz");
  box.innerHTML = "";
  box.append(el("b", "", `🎯 Aniqlik: ${st.all ? Math.round((st.ok / st.all) * 100) : 0}% · ${st.all} ta javob`));
  // 📈 Oxirgi testlar natijasi (ustunlar) va o'sish
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem("sado-qz-hist") || "[]").slice(-12); } catch {}
  if (hist.length >= 2) {
    const NAMES = { "gr-mix": "Aralash", "gr-daily": "Bugungi", "gr-level": "Daraja", "gr-miss": "Xatolar", "gr-weak": "Zaif mavzular", "gr-new": "Yangi mavzular" };
    const pc = hist.map((x) => Math.round((x.r / x.n) * 100));
    const half = Math.floor(pc.length / 2);
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const diff = Math.round(avg(pc.slice(half)) - avg(pc.slice(0, half)));
    const wrap = el("div", "qh");
    wrap.append(el("div", "qh-head", `📈 Oxirgi ${pc.length} ta test`), el("span", "qh-diff " + (diff > 0 ? "up" : diff < 0 ? "down" : ""), diff > 0 ? `▲ +${diff}%` : diff < 0 ? `▼ ${diff}%` : "barqaror"));
    const bars = el("div", "qh-bars");
    hist.forEach((x, k) => {
      const col = el("i", pc[k] >= 80 ? "hi" : pc[k] >= 50 ? "mid" : "lo");
      col.style.height = `${Math.max(6, pc[k])}%`;
      const lname = NAMES[x.t] || state.lessons.find((l) => l.id === x.t)?.title.replace(/^\d+\.\s*/, "") || "Mashq";
      col.title = `${lname}: ${x.r}/${x.n}`;
      col.append(el("em", "", `${pc[k]}`)); // telefonda title ko'rinmaydi — foiz ustun ustida
      bars.append(col);
    });
    wrap.append(bars);
    box.append(wrap);
  }
  const rows = Object.entries(st.by || {})
    .map(([id, t]) => ({ l: state.lessons.find((x) => x.id === id), p: Math.round((t.ok / t.all) * 100), t }))
    .filter((x) => x.l)
    .sort((a, b) => (a.t.all >= 2 ? 0 : 1) - (b.t.all >= 2 ? 0 : 1) || a.p - b.p || b.t.all - a.t.all); // 1 ta javobli mavzular pastroqda
  if (!rows.length) box.append(el("p", "qz-done", "Hali mavzular bo'yicha ma'lumot yo'q — bir nechta test ishlang."));
  const ul = el("div", "ts-list");
  for (const { l, p, t } of rows) {
    const b = el("button", "ts-row");
    const bar = el("span", "ts-bar");
    const fill = el("i", p >= 80 ? "hi" : p >= 50 ? "mid" : "lo");
    fill.style.width = `${Math.max(4, p)}%`;
    bar.append(fill);
    b.append(el("span", "ts-name", `${l.emoji} ${l.title.replace(/^\d+\.\s*/, "").replace(/\s*\([^)]*\)$/, "")}`), bar, el("b", "ts-p", `${p}%`), el("small", "ts-n", `${t.ok}/${t.all} to'g'ri`));
    b.addEventListener("click", () => { haptic(); $("mixSheet").hidden = true; openSheet(l); setTimeout(() => $("sheetQuiz").scrollIntoView({ behavior: "smooth", block: "start" }), 350); });
    ul.append(b);
  }
  box.append(ul);
  // 💪 Eng zaif 3 mavzudan (80% dan past) test
  // Kamida 2 ta javobli mavzular afzal (bitta tasodifiy xato — ishonchli emas)
  const solid = rows.filter((x) => x.p < 80 && x.t.all >= 2);
  const weak = (solid.length ? solid : rows.filter((x) => x.p < 80)).slice(0, 3);
  if (weak.length) {
    const wb = el("button", "qz-again ts-weak", `💪 Zaif mavzulardan test: ${weak.map((x) => x.l.emoji).join(" ")}`);
    wb.addEventListener("click", () => {
      haptic();
      const quiz = weak.flatMap((x) => (x.l.quiz || []).map((q) => ({ ...q, from: x.l.id })));
      state.mixWeak = new Map();
      renderQuiz({ id: "gr-weak", quiz }, $("mixQuiz"), `💪 Zaif mavzular · ${weak.length} ta mavzu`, Math.min(mixLen(), quiz.length));
    });
    box.append(wb);
  }
  const untouched = state.lessons.filter((l) => l.category === "Grammatika gapirib" && !(st.by || {})[l.id]).length;
  // 🆕 Hali test ishlanmagan mavzulardan (tasodifiy 5 tasi) — 10 ta savol
  const fresh = state.lessons.filter((l) => l.category === "Grammatika gapirib" && !(st.by || {})[l.id] && l.quiz?.length);
  if (fresh.length) {
    const nb = el("button", "qz-again ts-new", `🆕 Yangi mavzulardan test (${fresh.length})`);
    nb.addEventListener("click", () => {
      haptic();
      const pick = [...fresh].sort(() => Math.random() - 0.5).slice(0, 5);
      const quiz = pick.flatMap((l) => l.quiz.map((q) => ({ ...q, from: l.id })));
      state.mixWeak = new Map();
      renderQuiz({ id: "gr-new", quiz }, $("mixQuiz"), `🆕 Yangi mavzular: ${pick.map((l) => l.emoji).join(" ")}`, Math.min(mixLen(), quiz.length));
    });
    box.append(nb);
  }
}

function openMissTest() {
  state.speedRun = (state.speedRun || 0) + 1;
  const quiz = quizMisses();
  if (!quiz.length) return toast("👏 Xato savollar yo'q");
  $("mixLevels").innerHTML = "";
  state.mixWeak = new Map();
  $("mixSheet").hidden = false;
  renderQuiz({ id: "gr-miss", quiz }, $("mixQuiz"), `🔁 Xato savollarim · ${quiz.length} ta`, Math.min(10, quiz.length));
}

// ⚡ 60 soniyalik tezkor test: imkon qadar ko'p to'g'ri javob, rekord saqlanadi
function openSpeedTest() {
  const pool = state.lessons
    .filter((l) => l.category === "Grammatika gapirib")
    .flatMap((l) => (l.quiz || []).map((q) => { const [before, after] = q.text.split("___"); return { before: before.trimEnd(), after, answer: q.answer, options: q.options, from: l.id }; }));
  if (!pool.length) return;
  $("mixSheet").hidden = false;
  $("mixLevels").innerHTML = "";
  const box = $("mixQuiz");
  box.innerHTML = "";
  const best = Number(localStorage.getItem("sado-speed-best")) || 0;
  const head = el("div", "sp-head");
  const timeEl = el("b", "sp-time", "⏱ 60");
  const scoreEl = el("b", "sp-score", "✅ 0");
  head.append(el("b", "", "⚡ 60 soniya"), timeEl, scoreEl);
  const body = el("div", "qz-body");
  box.append(head, el("small", "qz-n", best ? `🏆 Rekordingiz: ${best} ta` : "Iloji boricha ko'p savolga to'g'ri javob bering"), body);
  let left = 60, score = 0, wrong = 0, busy = false;
  const missed = []; // ❌ xato savollar — oxirida to'g'ri shakli bilan ko'rsatiladi
  const order = [...pool].sort(() => Math.random() - 0.5);
  let k = 0;
  const run = (state.speedRun = (state.speedRun || 0) + 1);
  const finish = () => {
    clearInterval(state.speedTimer);
    body.innerHTML = "";
    const rec = score > best;
    if (rec) localStorage.setItem("sado-speed-best", String(score));
    const total = score + wrong;
    body.append(el("p", "qz-done", rec && best ? `🎉 Yangi rekord: ${score} ta! (avval ${best})` : `⏱ Vaqt tugadi! ✅ ${score} ta to'g'ri, ❌ ${wrong} ta xato`));
    // 🏆 Rekord va aniqlik
    body.append(el("small", "qz-n sp-sum", `${total ? `🎯 Aniqlik: ${Math.round((score / total) * 100)}%` : "Hech bir savolga javob berilmadi"}${!rec && best ? ` · 🏆 Rekord: ${best} ta` : rec && !best && score ? " · 🏆 Birinchi rekordingiz!" : ""}`));
    // ❌ Xatolar: to'g'ri shakli (bosilsa eshittiriladi)
    if (missed.length) {
      const ul = el("div", "qz-missed");
      ul.append(el("small", "", "To'g'ri shakli:"));
      for (const t of missed.slice(0, 5)) {
        const bt = el("button", "rule-ex", t);
        bt.addEventListener("click", () => { haptic(); sayPhrase(t).then(() => mascot.setLevel(0)); });
        ul.append(bt);
      }
      if (missed.length > 5) ul.append(el("small", "", `…va yana ${missed.length - 5} ta — «🔁 Xatolarim»da takrorlang`));
      body.append(ul);
    }
    const again = el("button", "qz-again", "⚡ Yana bir bor");
    again.addEventListener("click", () => { haptic(); openSpeedTest(); });
    body.append(again);
    if (state.lessons.length) keepScroll(renderLessons);
  };
  const next = () => {
    if (run !== state.speedRun) return;
    const it = order[k++ % order.length];
    body.innerHTML = "";
    const q = el("p", "qz-q");
    q.append(document.createTextNode(it.before + " "), el("span", "qz-gap", "____"), document.createTextNode(it.after));
    const opts = el("div", "qz-opts");
    for (const o of [...it.options].sort(() => Math.random() - 0.5)) {
      const b = el("button", "qz-opt", o);
      b.addEventListener("click", () => {
        if (busy || left <= 0) return;
        busy = true;
        const ok = o === it.answer;
        haptic(ok ? "light" : "medium");
        ok ? score++ : wrong++;
        if (!ok) missed.push(`${it.before} ${it.answer === "—" ? "" : it.answer}${it.after}`.replace(/\s+/g, " ").replace(/«[^»]*»\s*→\s*/, "").trim());
        quizMiss(it, it.from, ok);
        scoreEl.textContent = `✅ ${score}`;
        b.classList.add(ok ? "ok" : "bad");
        if (!ok) [...opts.children].find((x) => x.textContent === it.answer)?.classList.add("ok");
        setTimeout(() => { busy = false; if (left > 0) next(); }, ok ? 250 : 900);
      });
      opts.append(b);
    }
    body.append(q, opts);
  };
  clearInterval(state.speedTimer);
  state.speedTimer = setInterval(() => {
    if (run !== state.speedRun || $("mixSheet").hidden) return clearInterval(state.speedTimer);
    left--;
    timeEl.textContent = `⏱ ${left}`;
    timeEl.classList.toggle("low", left <= 10);
    if (left <= 0) finish();
  }, 1000);
  next();
}

// 📝 Aralash grammatika testi (barcha darslar savollaridan)
// Daraja guruhlari: boshlang'ich (A1–A2), o'rta (A2-B1, B1), yuqori (B1-B2)
// 📝 Aralash test uzunligi (⚙️ Sozlamalarda: 10 yoki 20 savol)
const mixLen = () => (localStorage.getItem("sado-mix-n") === "20" ? 20 : 10);
const MIX_LEVELS = [["", "Hammasi"], ["beg", "🌱 A1–A2"], ["mid", "🌿 B1"], ["adv", "🌳 B2"], ["pick", "🎯 Tanlash"]];
// 🎯 O'zi tanlagan mavzulardan test
const mixPicked = () => { try { return JSON.parse(localStorage.getItem("sado-mix-pick") || "[]"); } catch { return []; } };
function renderMixPicker(gr, box) {
  box.innerHTML = "";
  const sel = new Set(mixPicked().filter((id) => gr.some((l) => l.id === id)));
  box.append(el("b", "", "🎯 Qaysi mavzulardan test tuzay?"));
  const list = el("div", "mp-list");
  const go = el("button", "btn primary wide mp-go");
  const items = new Map();
  const paint = () => { for (const [id, b] of items) b.classList.toggle("on", sel.has(id)); upd(); };
  // ⚡ Tezkor tanlash: zaif mavzular (aniqlik < 70%) yoki tozalash
  const tools = el("div", "mp-tools");
  const by = quizStats().by || {};
  const weak = gr.filter((l) => by[l.id]?.all >= 2 && by[l.id].ok / by[l.id].all < 0.8).map((l) => l.id); // statistika oynasidagi bilan bir xil chegara
  const wk = el("button", "mp-tool", weak.length ? `⚠️ Zaif mavzularim (${weak.length})` : "⚠️ Zaif mavzu hali yo'q");
  wk.disabled = !weak.length;
  wk.addEventListener("click", () => { haptic(); sel.clear(); weak.forEach((id) => sel.add(id)); paint(); });
  const clr = el("button", "mp-tool", "✕ Tozalash");
  clr.addEventListener("click", () => { haptic(); sel.clear(); paint(); });
  tools.append(wk, clr);
  box.append(tools);
  const upd = () => {
    const n = gr.filter((l) => sel.has(l.id)).reduce((a, l) => a + (l.quiz?.length || 0), 0);
    go.textContent = sel.size ? `▶ Boshlash · ${sel.size} ta mavzu, ${Math.min(mixLen(), n)} ta savol` : "Kamida bitta mavzuni belgilang";
    go.disabled = !sel.size;
  };
  let grp = "";
  for (const l of gr) {
    const g = mixLevelOf(l.level);
    if (g !== grp) {
      grp = g;
      // Guruh sarlavhasi — butun darajani belgilash / olib tashlash
      const ids = gr.filter((x) => mixLevelOf(x.level) === g).map((x) => x.id);
      const h = el("button", "mp-grp", `${MIX_LEVELS.find(([k]) => k === g)[1]} · hammasi`);
      h.addEventListener("click", () => { haptic(); const all = ids.every((id) => sel.has(id)); ids.forEach((id) => (all ? sel.delete(id) : sel.add(id))); paint(); });
      list.append(h);
    }
    const b = el("button", "mp-item" + (sel.has(l.id) ? " on" : ""), `${l.emoji || "✏️"} ${l.title.replace(/^\d+\.\s*/, "")}`);
    items.set(l.id, b);
    b.addEventListener("click", () => { haptic(); sel.has(l.id) ? sel.delete(l.id) : sel.add(l.id); paint(); });
    list.append(b);
  }
  go.addEventListener("click", () => {
    haptic();
    const ids = gr.filter((l) => sel.has(l.id)).map((l) => l.id);
    localStorage.setItem("sado-mix-pick", JSON.stringify(ids));
    const quiz = gr.filter((l) => sel.has(l.id)).flatMap((l) => (l.quiz || []).map((q) => ({ ...q, from: l.id })));
    renderQuiz({ id: "gr-mix", quiz }, box, `🎯 ${ids.length} ta mavzudan test · ${Math.min(mixLen(), quiz.length)} ta savol`, mixLen());
  });
  upd();
  box.append(list, go);
  box.hidden = false;
}
const mixLevelOf = (lv) => (/B2/.test(lv) ? "adv" : /A2-B1|^B1$/.test(lv) ? "mid" : "beg");
function openMixTest(level = localStorage.getItem("sado-mix-lv") || "") {
  state.speedRun = (state.speedRun || 0) + 1; // tezkor test to'xtaydi
  const gr = state.lessons.filter((l) => l.category === "Grammatika gapirib" && (!level || level === "pick" || mixLevelOf(l.level) === level));
  const quiz = gr.flatMap((l) => (l.quiz || []).map((q) => ({ ...q, from: l.id })));
  if (quiz.length < 4) return;
  localStorage.setItem("sado-mix-lv", level);
  state.mixWeak = new Map();
  $("mixSheet").hidden = false;
  // 🎚 Daraja tanlash chiplari
  const lv = $("mixLevels");
  lv.innerHTML = "";
  for (const [k, label] of MIX_LEVELS) {
    const b = el("button", "chip-f" + (k === level ? " on" : ""), label);
    b.addEventListener("click", () => { haptic(); openMixTest(k); });
    lv.append(b);
  }
  requestAnimationFrame(() => { const on = lv.querySelector(".on"); if (on) lv.scrollLeft = Math.max(0, on.offsetLeft + on.offsetWidth - lv.clientWidth + 8); });
  if (level === "pick") return renderMixPicker(gr, $("mixQuiz"));
  renderQuiz({ id: "gr-mix", quiz }, $("mixQuiz"), `📝 Aralash test · ${Math.min(mixLen(), quiz.length)} ta savol`, mixLen());
}
$("mixClose").addEventListener("click", () => ($("mixSheet").hidden = true));
$("mixSheet").addEventListener("click", (e) => { if (e.target.id === "mixSheet") $("mixSheet").hidden = true; });

function renderQuiz(lesson, box = $("sheetQuiz"), title = "🧩 Tez mashq", QN = 4) {
  box.innerHTML = "";
  // Darsning o'z mashqi bo'lsa — o'shani, aks holda qoida misollaridan avtomatik
  // 🎲 Savollar to'plamidan har safar tasodifiy 4 tasi (Qayta bosilganda — yangilari)
  const pool = lesson.quiz?.length
    ? lesson.quiz.map((q) => { const [before, after] = q.text.split("___"); return { before: before.trimEnd(), after, answer: q.answer, options: q.options, from: q.from }; })
    : lesson.rule ? quizItems(lesson.rule) : [];
  // ✅ Ba'zi savollar "Qaysi gap to'g'ri?" ko'rinishida: to'liq to'g'ri gap va bitta noto'g'ri gap
  const sent = (it, w) => `${it.before} ${w === "—" ? "" : w}${it.after}`.replace(/\s+/g, " ").trim();
  const asPick = (it) => {
    const wrong = it.options.filter((o) => o !== it.answer);
    if (!wrong.length || /«/.test(it.before)) return it;
    const bad = wrong[Math.floor(Math.random() * wrong.length)];
    return { ...it, mode: "pick", sentences: [sent(it, it.answer), sent(it, bad)], right: sent(it, it.answer) };
  };
  // 🧱 "So'zlarni tartibga soling": to'g'ri gapning so'zlari aralashtiriladi (4–8 so'zli gaplar)
  const asOrder = (it) => {
    if (/«/.test(it.before)) return it;
    const full = sent(it, it.answer);
    if (/[—–]|\s-\s/.test(full)) return it; // ikki qismli gap (savol — javob) tartiblash uchun chalkash
    const words = full.split(" ");
    if (words.length < 4 || words.length > 8 || new Set(words).size !== words.length) return it;
    let mixed = [...words];
    for (let t = 0; t < 5 && mixed.join(" ") === full; t++) mixed = [...words].sort(() => Math.random() - 0.5);
    return { ...it, mode: "order", words, mixed, right: full };
  };
  // 🔎 "Xatoni toping": noto'g'ri variant qo'yilgan gapda xato so'zni bosish (bitta so'zli variantlar)
  const asSpot = (it) => {
    if (/«/.test(it.before) || /[—–]/.test(it.before + it.after)) return it;
    const wrong = it.options.filter((o) => o !== it.answer && !/\s|—/.test(o) && o.length > 1);
    if (!wrong.length || /\s|—/.test(it.answer)) return it;
    const bad = wrong[Math.floor(Math.random() * wrong.length)];
    const beforeW = it.before.trim() ? it.before.trim().split(/\s+/) : [];
    const words = [...beforeW, bad + (it.after.match(/^[.,?!]+/)?.[0] || ""), ...it.after.replace(/^[.,?!]+/, "").trim().split(/\s+/).filter(Boolean)];
    if (words.length < 3 || words.length > 10) return it;
    return { ...it, mode: "spot", words, badIdx: beforeW.length, right: sent(it, it.answer) };
  };
  const shuffled = () => {
    const a = [...pool].sort(() => Math.random() - 0.5);
    if (lesson.id !== "gr-mix") return a;
    const seen = seenSet(); // aralash testda — hali ko'rilmagan savollar birinchi
    return [...a.filter((x) => !seen.has(qKey(x))), ...a.filter((x) => seen.has(qKey(x)))];
  };
  const pick = () => (pool.length > QN ? shuffled().slice(0, QN) : lesson.ordered ? [...pool] : [...pool].sort(() => Math.random() - 0.5))
    .map((it, k) => (pool.length <= QN ? it : k % 4 === 1 ? asOrder(it) : k % 4 === 2 ? asPick(it) : k % 4 === 3 ? asSpot(it) : it)); // bo'sh joy → so'z tartibi → gap tanlash → xatoni topish
  let items = pick();
  box.hidden = items.length < (lesson.id === "gr-miss" ? 1 : 2);
  if (box.hidden) return;
  let i = 0, right = 0, missed = [], marks = [];
  const head = el("b", "", title);
  const body = el("div", "qz-body");
  box.append(head, body);
  const show = () => {
    body.innerHTML = "";
    if (i >= items.length) {
      if (lesson.id === "gr-level") levelTestResult(items, marks, body);
      // 📈 Natijalar tarixi (oxirgi 30 ta test)
      if (!lesson.noStats) try {
        const h = JSON.parse(localStorage.getItem("sado-qz-hist") || "[]");
        h.push({ t: lesson.id, r: right, n: items.length, d: dayNum() });
        localStorage.setItem("sado-qz-hist", JSON.stringify(h.slice(-30)));
      } catch {}
      if (lesson.id === "gr-daily") {
        dailyTestDone(right, items.length);
        // 📤 Natijani kvadratchalar bilan ulashish (javoblar oshkor qilinmaydi)
        const d = dailyTest();
        const sh = el("button", "qz-again qz-share", "📤 Natijani ulashish");
        const text = `📅 Sado — bugungi grammatika testi\n${marks.join("")}  ${right}/${items.length}${d.streak ? `\n🔥 ${d.streak} kun ketma-ket` : ""}\n\nSen ham sinab ko'r 👇`;
        sh.addEventListener("click", () => {
          haptic();
          const url = state.shareUrl || "https://t.me";
          const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
          if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
          else if (navigator.share) navigator.share({ text: text + (state.shareUrl ? "\n" + state.shareUrl : "") }).catch(() => {});
          else window.open(link, "_blank");
        });
        body.append(el("div", "qz-marks", marks.join("")));
        state.dailyShareBtn = sh;
      }
      if (!lesson.noStats) saveQuiz(lesson.id === "gr-mix" ? `gr-mix${localStorage.getItem("sado-mix-lv") || ""}` : lesson.id, right, items.length); // aralash testda — har daraja uchun alohida
      if (state.lessons.length && !lesson.noStats) keepScroll(renderLessons); // plitkadagi 🧩 va Aralash test 🏆 yangilanadi
      const doneLine = lesson.noStats
        ? el("p", "qz-done", right === items.length ? `🎉 ${right}/${items.length} — hammasini bilasiz!` : `${right * 2 >= items.length ? "👍" : "💪"} ${right}/${items.length} — xato qilinganlarini eshitib, kartochkalarda takrorlang.`)
        : (el("p", "qz-done", right === items.length ? `🎉 ${right}/${items.length} — a'lo! Endi gapirib mustahkamlaymiz.` : right * 2 >= items.length ? `👍 ${right}/${items.length} — yaxshi! To'g'ri shakllarini eshitib takrorlang.` : `💪 ${right}/${items.length} — qoidani yana bir o'qing va qayta urinib ko'ring.`));
      body.append(doneLine);
      if (lesson.id === "gr-daily" && state.dailyShareBtn) body.append(state.dailyShareBtn), (state.dailyShareBtn = null);
      // 🔁 Xatolarim: ro'yxat qanchaga qisqardi
      if (lesson.id === "gr-miss") {
        const leftN = quizMisses().length;
        body.append(el("p", "qz-n miss-left" + (leftN ? "" : " done"), leftN ? `✅ ${right} ta savol ro'yxatdan o'chdi · 🔁 ${leftN} ta qoldi` : "🎉 Xatolar ro'yxati bo'sh — hammasini tuzatdingiz!"));
      }
      // ❌ Xato qilingan gaplarning to'g'ri shakli — eshitish mumkin
      if (missed.length) {
        const ul = el("div", "qz-missed");
        ul.append(el("small", "", "To'g'ri shakli:"));
        for (const t of missed.slice(0, 5)) {
          const bt = el("button", "rule-ex", t);
          bt.addEventListener("click", () => { haptic(); sayPhrase(t).then(() => mascot.setLevel(0)); });
          ul.append(bt);
        }
        if (missed.length > 5) ul.append(el("small", "", lesson.noStats ? `…va yana ${missed.length - 5} ta` : `…va yana ${missed.length - 5} ta — «🔁 Xatolarim»da takrorlang`));
        body.append(ul);
      }
      // 📝 Aralash test: xato qilingan mavzular — mos darsga o'tish
      if (["gr-mix", "gr-weak", "gr-new"].includes(lesson.id) && state.mixWeak?.size) {
        const tl = el("div", "qz-topics");
        tl.append(el("small", "", "Takrorlash kerak bo'lgan mavzular:"));
        for (const [id, n] of [...state.mixWeak].sort((a, b) => b[1] - a[1])) {
          const l = state.lessons.find((x) => x.id === id);
          if (!l) continue;
          const b = el("button", "rep-grlink", `${l.emoji} ${l.title.replace(/^\d+\.\s*/, "").replace(/\s*\([^)]*\)$/, "")}${n > 1 ? ` · ${n}` : ""} ›`);
          b.addEventListener("click", () => { haptic(); $("mixSheet").hidden = true; openSheet(l); });
          tl.append(b);
        }
        body.append(tl);
      }
      const again = el("button", "qz-again", lesson.id === "gr-miss" ? "🔁 Qolganlarini ishlash" : lesson.id === "gr-daily" ? "🔄 Yana mashq (natija o'zgarmaydi)" : pool.length > QN || lesson.id === "gr-level" ? "🔄 Yangi savollar" : "🔄 Qayta");
      if (lesson.id === "gr-miss" && !quizMisses().length) again.hidden = true; // tuzatadigan xato qolmadi
      again.addEventListener("click", () => {
        if (lesson.id === "gr-miss") return openMissTest(); // ro'yxat yangilangan — qolgan xatolar bilan qayta
        if (lesson.id === "gr-level") return openLevelTest(); // yangi 20 savol
        i = 0; right = 0; missed = []; marks = []; state.mixWeak = new Map(); items = pick(); show();
      });
      body.append(again);
      // 📝 Bugungi 5 ta savoldan keyin — mashqni davom ettirish
      if (lesson.id === "gr-daily") {
        const more = el("button", "qz-again qz-more", "📝 Yana 10 ta savol");
        more.addEventListener("click", () => { haptic(); openMixTest(); });
        body.append(more);
      }
      // 📋 Mavzuning barcha savollari bilan to'liq test (dars mashqida)
      if (/^gr-/.test(lesson.id) && !/^gr-(mix|miss|daily|level|weak)$/.test(lesson.id) && pool.length > QN && QN < pool.length) {
        const full = el("button", "qz-again qz-full", `📋 To'liq test (${pool.length} ta)`);
        full.addEventListener("click", () => { haptic(); renderQuiz(lesson, box, `📋 To'liq test · ${pool.length} ta savol`, pool.length); });
        body.append(full);
      }
      return;
    }
    const it = items[i];
    body.append(el("small", "qz-n", `${i + 1}/${items.length}${pool.length > QN ? ` · to'plamda ${pool.length} ta savol` : ""}`));
    // ●●○○ Yo'l chizig'i: javob berilganlar yashil/qizil, joriy — ajratilgan
    if (items.length > 1) {
      const dots = el("div", "qz-dots");
      items.forEach((_, k) => dots.append(el("i", k < marks.length ? (marks[k] === "🟩" ? "ok" : "bad") : k === i ? "cur" : "")));
      body.append(dots);
    }
    if (it.mode === "spot") {
      body.append(el("p", "qz-q", ""));
      body.lastChild.append(el("b", "qz-pick", "🔎 Xatoni toping — noto'g'ri so'zni bosing"));
      const line = el("div", "qz-spot");
      it.words.forEach((w, k) => {
        const b = el("button", "qz-sw", w);
        b.addEventListener("click", () => {
          if (line.dataset.done) return;
          line.dataset.done = "1";
          const ok = k === it.badIdx;
          haptic(ok ? "light" : "medium");
          if (ok) right++;
          else if (it.from) (state.mixWeak ||= new Map()).set(it.from, (state.mixWeak.get(it.from) || 0) + 1);
          if (lesson.noStats) lesson.onAnswer?.(it, ok); else quizMiss(it, lesson.id, ok);
          marks.push(ok ? "🟩" : "🟥");
          b.classList.add(ok ? "ok" : "bad");
          line.children[it.badIdx].classList.add("found");
          body.append(el("div", ok ? "qz-why qz-good" : "qz-why", "✅ To'g'risi: " + it.right));
          if (!ok) missed.push(it.right);
          const nx = el("button", "qz-next", i < items.length - 1 ? "Keyingi ›" : "Natija ›");
          nx.addEventListener("click", () => { haptic(); i++; show(); });
          body.append(nx);
        });
        line.append(b);
      });
      body.append(line);
      return;
    }
    if (it.mode === "order") {
      body.append(el("p", "qz-q", ""));
      body.lastChild.append(el("b", "qz-pick", "🧱 So'zlarni tartibga soling"));
      const line = el("div", "qz-line");
      const bank = el("div", "qz-opts qz-bank");
      const placed = [];
      const check = () => {
        if (placed.length < it.words.length) return;
        const got = placed.map((b) => b.textContent).join(" ");
        const ok = got === it.right;
        if (ok) right++;
        else if (it.from) (state.mixWeak ||= new Map()).set(it.from, (state.mixWeak.get(it.from) || 0) + 1);
        if (lesson.noStats) lesson.onAnswer?.(it, ok); else quizMiss(it, lesson.id, ok);
        marks.push(ok ? "🟩" : "🟥");
        line.classList.add(ok ? "ok" : "bad");
        haptic(ok ? "light" : "medium");
        if (ok) return setTimeout(() => { i++; show(); }, 800);
        missed.push(it.right);
        body.append(el("div", "qz-why", "✅ To'g'risi: " + it.right));
        const nx = el("button", "qz-next", i < items.length - 1 ? "Keyingi ›" : "Natija ›");
        nx.addEventListener("click", () => { haptic(); i++; show(); });
        body.append(nx);
      };
      for (const w of it.mixed) {
        const b = el("button", "qz-opt qz-w", w);
        b.addEventListener("click", () => {
          if (line.classList.contains("ok") || line.classList.contains("bad")) return;
          haptic();
          if (b.parentNode === bank) { line.append(b); placed.push(b); }
          else { bank.append(b); placed.splice(placed.indexOf(b), 1); }
          check();
        });
        bank.append(b);
      }
      // 🔊 Eshitib yordam olish va ↺ qaytadan boshlash
      const tools = el("div", "qz-tools");
      const hear = el("button", "qz-tool", "🔊 Eshitish");
      hear.addEventListener("click", () => {
        haptic();
        hear.classList.add("used");
        sayPhrase(it.right).then(() => mascot.setLevel(0)).catch(() => {});
      });
      const reset = el("button", "qz-tool", "↺ Tozalash");
      reset.addEventListener("click", () => {
        if (line.classList.contains("ok") || line.classList.contains("bad")) return;
        haptic();
        for (const b of [...placed]) bank.append(b);
        placed.length = 0;
      });
      tools.append(hear, reset);
      body.append(line, bank, tools);
      return;
    }
    const q = el("p", "qz-q");
    if (it.mode === "pick") q.append(el("b", "qz-pick", "✅ Qaysi gap to'g'ri?"));
    else q.append(document.createTextNode(it.before + " "), el("span", "qz-gap", "____"), document.createTextNode(it.after));
    body.append(q);
    const opts = el("div", "qz-opts" + (it.mode === "pick" ? " qz-sents" : ""));
    for (const o of [...(it.mode === "pick" ? it.sentences : it.options)].sort(() => Math.random() - 0.5)) {
      const btn = el("button", "qz-opt", o);
      btn.addEventListener("click", () => {
        if (opts.dataset.done) return;
        opts.dataset.done = "1";
        haptic();
        const ok = o === (it.mode === "pick" ? it.right : it.answer);
        if (lesson.noStats) lesson.onAnswer?.(it, ok); else quizMiss(it, lesson.id, ok);
        marks.push(ok ? "🟩" : "🟥");
        if (ok) right++;
        else if (it.from) (state.mixWeak ||= new Map()).set(it.from, (state.mixWeak.get(it.from) || 0) + 1);
        if (!ok) missed.push(`${it.before} ${it.answer === "—" ? "" : it.answer}${it.after}`.replace(/\s+/g, " ").replace(/«[^»]*»\s*→\s*/, "").trim());
        btn.classList.add(ok ? "ok" : "bad");
        if (!ok) [...opts.children].find((b) => b.textContent === (it.mode === "pick" ? it.right : it.answer))?.classList.add("ok");
        const gap = q.querySelector(".qz-gap");
        if (gap) (gap.textContent = it.answer), gap.classList.add("ok");
        if (ok) return setTimeout(() => { i++; show(); }, 700);
        // 💡 Xato bo'lsa — qoidadan tegishli qator (javob so'zi bor qator) va "Keyingi" tugmasi
        const src = state.lessons.find((l) => l.id === (it.from || lesson.id));
        const lines = String(src?.rule || "").split("\n").filter(Boolean);
        const aw = String(it.answer).toLowerCase().replace(/[^a-z' ]/g, "").trim();
        const has = lines.filter((ln) => aw && new RegExp(`(^|[^a-z])${aw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(ln));
        // Izohli (":" bor, o'zbekcha) qator afzal — faqat inglizcha misol qatori emas
        // ✗ Avvalo o'quvchi tanlagan noto'g'ri so'z tilga olingan qator (ayniqsa "✗ ..." izohi) — xatosi aynan tushuntiriladi
        const ww = it.mode === "pick" ? "" : String(btn.textContent).toLowerCase().replace(/[^a-z' ]/g, "").trim();
        const wre = ww && ww !== aw ? new RegExp(`(^|[^a-z'])${ww.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z']|$)`, "i") : null;
        const bad = wre ? lines.filter((ln) => wre.test(ln)) : [];
        const hit = bad.find((ln) => ln.includes("✗")) || (ww.length >= 4 && bad[0]) || has.find((ln) => ln.includes(":")) || has[0] || lines.find((ln) => ln.includes(":")) || lines[0];
        if (hit) body.append(el("div", "qz-why", "💡 " + hit));
        const nx = el("button", "qz-next", i < items.length - 1 ? "Keyingi ›" : "Natija ›");
        nx.addEventListener("click", () => { haptic(); i++; show(); });
        body.append(nx);
      });
      opts.append(btn);
    }
    body.append(opts);
  };
  show();
}

// Bo'lim filtrlari (gorizontal chiplar)
// 📖 Qoidadagi inglizcha misollarni ajratib, bosilganda eshittiramiz
// (please, let's, how, me ... ham — "Sit down, please.", "Let's go!", "How much?", "Me too." misollari ham bosiladigan bo'lsin)
const EN_HINT = /\b(I|I'm|I've|I'd|I'll|you|he|she|it|we|they|is|are|am|do|does|did|will|the|a|an|can|can't|was|were|have|has|had|my|your|his|her|our|their|its|me|him|us|them|to|used|should|must|there|this|that|these|those|any|some|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|let's|please|not|never|ever|been|would|could|might|of|in|on|at|for|with|than|so|such|very|too|what|where|when|who|how|why|if|unless|go|come|and|or|both|either|neither)\b/i;
function ruleBody(rule) {
  const box = el("div", "rule-body");
  for (const line of rule.split("\n")) {
    const row = el("div", "");
    let last = 0;
    for (const m of line.matchAll(/[A-Z][A-Za-z0-9' ,]*[A-Za-z0-9][.?!]/g)) {
      const t = m[0];
      // ✗ belgili noto'g'ri misolni o'qitmaymiz
      if (t.split(" ").length < 2 || !EN_HINT.test(t) || /✗\s*$/.test(line.slice(0, m.index))) continue;
      row.append(document.createTextNode(line.slice(last, m.index)));
      const ex = el("button", "rule-ex", t);
      ex.addEventListener("click", (e) => {
        e.stopPropagation();
        haptic();
        sayPhrase(t).then(() => mascot.setLevel(0));
      });
      row.append(ex);
      last = m.index + t.length;
    }
    row.append(document.createTextNode(line.slice(last)));
    box.append(row);
  }
  if (box.querySelector(".rule-ex")) box.append(el("small", "rule-tip", "🔊 Misolni bosing — talaffuzini eshitasiz"));
  // ▶ Barcha misollarni ketma-ket tinglash (aytilayotgani ajratib ko'rsatiladi; yana bosilsa — to'xtaydi)
  const exs = [...box.querySelectorAll(".rule-ex")];
  if (exs.length >= 2) {
    const all = el("button", "rule-all", "▶ Misollarni ketma-ket tinglash");
    let run = 0;
    all.addEventListener("click", async (e) => {
      e.stopPropagation();
      haptic();
      const my = ++run;
      if (all.classList.contains("on")) { all.classList.remove("on"); all.textContent = "▶ Misollarni ketma-ket tinglash"; exs.forEach((x) => x.classList.remove("now")); return; }
      all.classList.add("on");
      all.textContent = "⏹ To'xtatish";
      for (const x of exs) {
        if (my !== run || !box.isConnected) break;
        exs.forEach((y) => y.classList.toggle("now", y === x));
        await sayPhrase(x.textContent).catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
      }
      if (my === run) { all.classList.remove("on"); all.textContent = "▶ Misollarni ketma-ket tinglash"; exs.forEach((y) => y.classList.remove("now")); }
      mascot.setLevel(0);
    });
    box.append(all);
  }
  return box;
}

// 🏅 Bir marta olingan yutuq olib qo'yilmaydi (masalan, kursga yangi dars qo'shilsa ham)
function hasBadge(b, p) {
  if (b[3](p)) return true;
  try {
    return (JSON.parse(localStorage.getItem("sado-badges") || "[]") || []).includes(b[1]);
  } catch {
    return false;
  }
}

// Ochilmagan yutuqlar uchun [hozirgi, kerakli]
const BADGE_PROGRESS = {
  Gapdon: (p) => [Math.min(50, p.maxWords || 0), 50],
  "Kurs bitiruvchisi": (p) => {
    // Eng ko'p o'tilgan kurs bo'yicha progress
    let best = [0, 1];
    for (const c of ["IELTS kursi", "CEFR kursi", "Grammatika gapirib"]) {
      const all = state.lessons.filter((l) => l.category === c);
      const d = all.filter((l) => p.lessons?.[l.id]).length;
      if (all.length && d / all.length > best[0] / best[1]) best = [d, all.length];
    }
    return best;
  },
  "3 kun ketma-ket": (p) => [Math.min(3, p.streak || 0), 3],
  "Grammatika a'lochisi": () => [Math.min(10, grPerfectCount()), 10],
  "Test seriyasi": () => { const d = dailyTest(); const alive = d.day >= dayNum() - 1; return [Math.min(7, alive ? d.streak || 0 : 0), 7]; },
  "10 ta dars": (p) => [Math.min(10, p.done || 0), 10],
  "A'lochi": (p) => [Math.min(90, p.best || 0), 90],
  "So'z ustasi": (p) => [Math.min(30, (p.words || []).length), 30],
  "Hafta qahramoni": (p) => [Math.min(7, p.streak || 0), 7],
  "Xato tuzatuvchi": (p) => [Math.min(5, (p.words || []).filter((w) => w.fixed).length), 5],
  "Kartochka ustasi": () => [Math.min(10, Object.values(flashBoxes()).filter((n) => n >= 3).length), 10],
  "Har tomonlama": (p) => [Math.min(5, new Set(Object.keys(p.lessons || {}).map((id) => state.lessons.find((l) => l.id === id)?.category).filter(Boolean)).size), 5],
};

// 🏅 Yangi qo'lga kiritilgan yutuqlarni natija sahifasida e'lon qilamiz
function announceBadges() {
  const p = state.progress;
  if (!p) return;
  const have = BADGES.filter((b) => hasBadge(b, p)).map((b) => b[1]);
  let seen;
  try {
    seen = JSON.parse(localStorage.getItem("sado-badges") || "null");
  } catch {}
  localStorage.setItem("sado-badges", JSON.stringify(have));
  if (!Array.isArray(seen)) return; // birinchi marta — eskilarini "yangi" demaymiz
  const fresh = BADGES.filter((b) => have.includes(b[1]) && !seen.includes(b[1]));
  if (!fresh.length) return;
  const box = el("div", "new-badge");
  for (const b of fresh) {
    const row = el("div", "nb-row");
    row.append(el("span", "nb-ico", b[0]), el("div", "", ""));
    row.lastChild.append(el("b", "", `Yangi yutuq: ${b[1]}!`), el("small", "", b[2]));
    box.append(row);
  }
  $("report").before(box);
  haptic("success");
}

// ⭐ Bolalar rejimi: har bir to'g'ri ibora uchun katta yulduz va maqtov
const KID_PRAISE = ["Zo'r! ⭐", "Barakalla! 🌟", "Juda yaxshi! ✨", "Ofarin! 🎉", "Super! 🚀", "Qoyil! 👏"];
function kidStar() {
  const s = el("div", "kid-star");
  s.append(el("b", "", "⭐"), el("span", "", KID_PRAISE[(state.used.size - 1) % KID_PRAISE.length]));
  document.body.append(s);
  setTimeout(() => s.remove(), 1600);
}

// 🧭 Imtihon qismlari: Sado gapida "Part 2" / "Part 1.2" uchrasa, bosqich oldinga siljiydi
function renderStages(lesson, idx = 0) {
  const box = $("stages");
  const st = lesson?.stages;
  box.hidden = !st;
  state.stageIdx = idx;
  if (!st) return;
  box.innerHTML = "";
  st.forEach((x, i) => {
    if (i) box.append(el("span", "st-line" + (i <= idx ? " done" : ""), ""));
    box.append(el("span", "st" + (i < idx ? " done" : i === idx ? " on" : ""), (i < idx ? "✓ " : "") + x.label));
  });
}
function trackStage(text) {
  const st = state.lesson?.stages;
  if (!st || !text) return;
  let best = state.stageIdx || 0;
  for (const m of text.matchAll(/\bpart\s*(\d(?:\.\d)?)/gi)) {
    const i = st.findIndex((x) => x.key === m[1] || (m[1] === "1" && x.key === "1.1"));
    if (i > best) best = i;
  }
  if (best !== state.stageIdx) {
    renderStages(state.lesson, best);
    haptic("light");
    toast(`🧭 ${st[best].label} boshlandi`, 2000);
  }
}

// 📖 Grammatika darsida qoidani dars davomida ham ochib ko'rish mumkin
function renderLessonRule(lesson) {
  const box = $("lessonRule");
  $("ruleBtn").hidden = !lesson?.rule;
  $("ruleBtn").classList.remove("on");
  box.hidden = true;
  box.innerHTML = "";
  if (!lesson?.rule) return;
  // ✕ Yopish tugmasi qoida ichida ham (yuqoridagi tugmaga qaytib bormaslik uchun)
  const close = el("button", "rule-close", "✕");
  close.title = "Qoidani yopish";
  close.addEventListener("click", () => $("ruleBtn").click());
  box.append(close, el("b", "", "📖 Qoida"), ruleBody(lesson.rule));
  // 💾 O'quvchi qoidani ochiq holda ishlatishni yoqtirsa — keyingi grammatika darsida ham ochiq
  if (localStorage.getItem("sado-rule-open") === "1") {
    box.hidden = false;
    $("ruleBtn").classList.add("on");
  }
}
$("ruleBtn").addEventListener("click", () => {
  haptic();
  const box = $("lessonRule");
  box.hidden = !box.hidden;
  $("ruleBtn").classList.toggle("on", !box.hidden);
  localStorage.setItem("sado-rule-open", box.hidden ? "0" : "1");
});

// 🖼 Rasm/jadval topshiriqlari: o'quvchi ko'rib turib gapiradi
function renderVisual(lesson) {
  const box = $("visual");
  const v = lesson?.visual;
  box.hidden = !v && !lesson?.questions && !lesson?.plan;
  box.innerHTML = "";
  // 📋 CEFR: javob rejasi — har bir bandni bosib belgilash mumkin
  if (!v && lesson?.plan) {
    const d = document.createElement("details");
    d.className = "vis-q";
    d.open = window.innerHeight > 720; // past ekranda yig'iq — Sado gapi ko'rinib tursin
    const sm = document.createElement("summary");
    sm.textContent = `📋 Javob rejasi — ${lesson.plan.length} qism`;
    const ul = el("ul", "plan-list");
    for (const step of lesson.plan) {
      const li = el("li", "", step);
      li.addEventListener("click", () => {
        haptic();
        li.classList.toggle("done");
      });
      ul.append(li);
    }
    d.append(sm, ul, el("small", "", "👆 Imtihonda shu qismlar baholanadi. Gapirib bo'lganingizni bosib belgilang"));
    box.append(d);
    return;
  }
  // ❓ IELTS Part 3 savollari — yig'iladigan ro'yxat
  if (!v && lesson?.questions) {
    const d = document.createElement("details");
    d.className = "vis-q";
    const sm = document.createElement("summary");
    sm.textContent = `❓ ${lesson.questions.length} ta savol — oldindan o'ylab oling`;
    const ol = el("ol", "q-list");
    // 🔊 Savolni bosish — imtihonchi ovozida eshitiladi va «javob berildi» deb belgilanadi
    for (const q of lesson.questions) {
      const li = el("li", "", q);
      li.addEventListener("click", () => {
        haptic();
        li.classList.toggle("done");
        const n = ol.querySelectorAll(".done").length;
        sm.textContent = n ? `❓ ${lesson.questions.length} ta savol — ✅ ${n} tasiga javob berdingiz` : `❓ ${lesson.questions.length} ta savol — oldindan o'ylab oling`;
        if (li.classList.contains("done")) sayPhrase(q).then(() => mascot.setLevel(0));
      });
      ol.append(li);
    }
    const tip = /^ielts-p1/.test(lesson.id)
      ? "💡 Part 1: har biriga 2–3 gap — javob + sabab yoki misol. Faqat «Yes»/«No» demang!"
      : "💡 Har biriga 2–4 gap: fikr + sabab + misol. «I'd argue that... because... For example...»";
    d.append(sm, ol, el("small", "", tip));
    box.append(d);
    return;
  }
  if (!v) return;
  if (v.type === "pictures") {
    box.append(el("div", "vis-title", "🖼 Rasmlar"));
    const row = el("div", "vis-pics");
    v.items.forEach((it, i) => {
      const c = el("div", "vis-pic");
      c.append(el("small", "", `${i + 1}-rasm`), el("div", "vis-emoji", it.emoji), el("b", "", it.en), el("span", "", it.uz));
      // ✓ Rasmni tasvirlab bo'lgach bosib belgilash; hammasi tayyor bo'lsa — solishtirishga o'tish eslatmasi
      c.addEventListener("click", () => {
        haptic();
        c.classList.toggle("done");
        const all = row.querySelectorAll(".vis-pic");
        if ([...all].every((x) => x.classList.contains("done"))) toast("🎯 Endi solishtiring: «Both pictures show... but...», «whereas...»", 3500);
      });
      row.append(c);
    });
    box.append(row, el("small", "vis-tip", "👆 Rasmni tasvirlab bo'lgach, ustiga bosib belgilang"));
  } else if (v.type === "chart") {
    box.append(el("div", "vis-title", "📊 " + v.title));
    const max = Math.max(...v.items.map((x) => x.value));
    for (const it of v.items) {
      const r = el("div", "vis-bar");
      const bar = el("span", "vis-track");
      const fill = el("i", "");
      fill.style.width = `${(it.value / max) * 100}%`;
      bar.append(fill);
      r.append(el("span", "vis-label", it.label), bar, el("b", "", it.value + "%"));
      box.append(r);
    }
  }
}

// Chiplar yopishqoq — ro'yxat boshini chiplar qatori ostiga keltiramiz; tanlangan chip markazda
function scrollToList(smooth = false) {
  const box = $("chips");
  const top = $("lessonList").getBoundingClientRect().top + window.scrollY - document.querySelector(".topbar").offsetHeight - box.offsetHeight - 6;
  window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  const on = box.querySelector(".chip-f.on");
  if (on) box.scrollLeft = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
}

function renderChips() {
  const box = $("chips");
  if (!box) return;
  const cats = [...new Set(state.lessons.filter((l) => !l.liveOnly).map((l) => l.category).filter(Boolean))];
  box.innerHTML = "";
  // 🎲 Tasodifiy dars: hali o'tilmaganlardan tanlanadi
  const rnd = el("button", "chip-f rnd", "🎲 Tasodifiy");
  rnd.addEventListener("click", () => {
    haptic("medium");
    const done = state.progress?.lessons || {};
    // Tanlangan bo'lim ichidan; aks holda — bolalar darslarisiz (maqsad "Bolalar" bo'lmasa)
    const cat = state.filter.cat && !state.filter.cat.startsWith("__") ? state.filter.cat : "";
    const kidsGoal = localStorage.getItem("sado-aim") === "Bolalar uchun";
    let all = state.lessons.filter((l) => !l.liveOnly && (cat ? l.category === cat : kidsGoal || l.category !== "Bolalar uchun"));
    // Boshlovchiga juda qiyin (B2+) darslar tushmasin
    if (localStorage.getItem("sado-level") === "beg" && all.some((l) => !isHard(l))) all = all.filter((l) => !isHard(l));
    const fresh = all.filter((l) => !done[l.id]);
    const pool = fresh.length ? fresh : all;
    if (!pool.length) return;
    openSheet(pool[Math.floor(Math.random() * pool.length)]);
    if (cat) toast(`🎲 «${cat}» bo'limidan tasodifiy dars`, 1800);
  });
  box.append(rnd);
  const favChip = state.favs.size ? [["__fav", `⭐ Sevimlilar (${state.favs.size})`]] : [];
  const newN = state.lessons.filter((l) => state.newIds?.has(l.id) && !state.progress?.lessons?.[l.id]).length;
  if (newN) favChip.unshift(["__new", `🆕 Yangi (${newN})`]);
  if (!newN && state.filter.cat === "__new") state.filter.cat = "";
  // 🔥 Qiyin darslar (B2 va undan yuqori)
  favChip.push(["__hard", `🔥 Qiyin (${state.lessons.filter(isHard).length})`]);
  const weakN = weakIds().length;
  if (weakN) favChip.push(["__weak", `🔁 Takrorlash (${weakN})`]);
  if (!weakN && state.filter.cat === "__weak") state.filter.cat = "";
  if (!state.favs.size && state.filter.cat === "__fav") state.filter.cat = "";
  [["", "📚 Hammasi"], ...favChip, ...cats.map((c) => [c, `${CAT_ICONS[c] || "📚"} ${c}`])].forEach(([c, label]) => {
    const b = el("button", "chip-f" + (state.filter.cat === c ? " on" : ""), label);
    b.addEventListener("click", () => {
      haptic();
      state.filter.cat = c;
      renderChips();
      // Tanlangan chipni gorizontal markazga olamiz, sahifani esa chiplar qatori panel ostida ko'rinadigan qilib suramiz
      const on = box.querySelector(".chip-f.on");
      if (on) box.scrollTo({ left: on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
      renderLessons();
      scrollToList(true);
    });
    box.append(b);
  });
}

// IELTS/CEFR kursidagi birinchi o'tilmagan dars
function nextLesson() {
  const done = state.progress?.lessons || {};
  // 🎯 Tanishuvda tanlangan maqsad bo'limi birinchi (masalan CEFR tanlaganga IELTS taklif qilinmasin)
  const aim = localStorage.getItem("sado-aim");
  if (aim) {
    const n = state.lessons.find((l) => l.category === aim && !l.liveOnly && !done[l.id]);
    if (n) return n;
  }
  for (const cat of ["IELTS kursi", "CEFR kursi", "Grammatika gapirib"]) {
    const list = state.lessons.filter((l) => l.category === cat);
    if (list.some((l) => done[l.id])) {
      const n = list.find((l) => !done[l.id]);
      if (n) return n;
    }
  }
  // Boshlovchiga (tanishuvda tanlangan) — kundalik mavzular, keyin grammatika
  const start = localStorage.getItem("sado-level") === "beg" ? ["Kundalik hayot", "Grammatika gapirib"] : ["IELTS kursi"];
  for (const cat of start) {
    const n = state.lessons.find((l) => l.category === cat && !done[l.id]);
    if (n) return n;
  }
  return null;
}

function renderNext() {
  const box = $("nextBox");
  const n = state.filter.q || state.filter.cat ? null : nextLesson();
  if (!n) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  const started = Object.keys(state.progress?.lessons || {}).length > 0;
  const head = el("div", "next-label", started ? "➡️ Keyingi dars" : "🚀 Shu yerdan boshlang");
  // Kurs ichida qayerdaligimiz: "📘 IELTS kursi · 3/41"
  const all = state.lessons.filter((l) => l.category === n.category);
  if (all.length > 1) {
    const done = all.filter((l) => state.progress?.lessons?.[l.id]).length;
    head.append(el("span", "next-course", `${CAT_ICONS[n.category] || "📚"} ${n.category} · ${done}/${all.length}`));
  }
  box.append(head, lessonButton(n));
}

// 📒 Lug'atim
state.vocabTab = "word";
function renderVocabBtn() {
  const words = state.progress?.words || [];
  const btn = $("vocabBtn");
  btn.hidden = !words.length;
  const n = words.filter((w) => w.type !== "fix").length;
  const f = words.length - n;
  btn.innerHTML = "";
  const fx = words.filter((w) => w.type === "fix" && w.fixed).length;
  btn.append(el("b", "", "📒 Lug'atim"), el("small", "", `${n} so'z · ${f} xato${fx ? ` (✅${fx})` : ""} ›`));
}
function renderVocab() {
  const fixes = (state.progress?.words || []).filter((w) => w.type === "fix" && w.en);
  $("reviewBtn").hidden = state.vocabTab !== "fix" || fixes.length < 2 || Boolean(state.flash);
  const ul = $("vocabList");
  ul.innerHTML = "";
  let items = (state.progress?.words || []).filter((w) => (state.vocabTab === "fix" ? w.type === "fix" : w.type !== "fix"));
  // Tuzatilmagan xatolar tepada, tuzatilganlari pastda
  if (state.vocabTab === "fix") items = [...items.filter((w) => !w.fixed), ...items.filter((w) => w.fixed)];
  // 🔍 Lug'atda qidirish (ro'yxat uzun bo'lsa ko'rinadi)
  $("vocabSearch").hidden = items.length < 8 || Boolean(state.flash);
  $("vocabPlay").hidden = items.length < 2 || Boolean(state.flash);
  $("flashBtn").textContent = "🃏 Kartochkalar";
  $("vocabQuiz").hidden = items.filter((w) => w.en && w.uz).length < 3 || Boolean(state.flash);
  const vq = $("vocabSearch").hidden ? "" : $("vocabSearch").value.trim().toLowerCase().replace(/[‘’`ʻʼ]/g, "'");
  const total = items.length;
  if (vq) items = items.filter((w) => [w.en, w.uz, w.wrong].some((x) => String(x || "").toLowerCase().replace(/[‘’`ʻʼ]/g, "'").includes(vq)));
  // 🏆 Hamma xato tuzatilgan bo'lsa — tabrik, takrorlash tugmasi "mustahkamlash"ga aylanadi
  const allFixed = state.vocabTab === "fix" && items.length > 0 && items.every((w) => w.fixed);
  $("reviewBtn").textContent = allFixed ? "💪 Tuzatilganlarni mustahkamlash" : "🔁 Xatolarim ustida Sado bilan ishlash";
  // 🎯 Eng ko'p uchraydigan grammatika mavzusi (tuzatilmagan xatolar bo'yicha) — mos darsga havola
  if (state.vocabTab === "fix" && !vq) {
    const cnt = new Map();
    for (const w of items.filter((x) => !x.fixed)) {
      const gl = grammarLessonFor([{ wrong: w.wrong, right: w.en }]);
      if (gl) cnt.set(gl, (cnt.get(gl) || 0) + 1);
    }
    const top = [...cnt].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const [gl, n] = top;
      const li = el("li", "fix-focus");
      li.append(el("b", "", `🎯 ${n >= 2 ? "Ko'p xato" : "Tavsiya"}: ${gl.title.replace(/^\d+\.\s*/, "").replace(/\s*\([^)]*\)$/, "")}${n >= 2 ? ` — ${n} ta` : ""}`), el("span", "", "Shu grammatika darsini o'tsangiz, bu xatolar kamayadi ›"));
      li.addEventListener("click", () => {
        haptic();
        $("vocabSheet").hidden = true;
        stopVocabPlay();
        openSheet(gl);
      });
      ul.append(li);
    }
  }
  if (allFixed) ul.append(el("li", "all-fixed", `🏆 Barcha ${items.length} ta xatoingiz tuzatilgan! Yangi darslarda yangi xatolar chiqsa, shu yerda paydo bo'ladi.`));
  if (!items.length) ul.append(el("li", "muted", vq && total ? `«${vq}» topilmadi` : state.vocabTab === "fix" ? "Hozircha xato yo'q 👏" : "Hozircha so'z yo'q"));
  for (const w of items) {
    const li = el("li", "rep-word" + (w.type === "fix" ? " rep-mistake" : ""));
    li.dataset.en = w.en;
    if (w.type === "fix") {
      const line = el("div", "");
      line.append(el("s", "rep-wrong", w.wrong || ""), document.createTextNode(" → "), el("b", "rep-right", w.en));
      if (w.fixed) line.append(el("span", "fixed-badge", "✅ tuzatildi"));
      li.append(line, el("div", "rep-why", w.uz || ""));
    } else {
      li.append(el("b", "", w.en), el("span", "muted", " — " + (w.uz || "")));
    }
    li.addEventListener("click", () => sayPhrase(w.en).then(() => mascot.setLevel(0)));
    // ✕ Lug'atdan o'chirish
    const del = el("button", "w-del", "✕");
    del.title = "O'chirish";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      haptic();
      li.classList.add("removing");
      try {
        const d = await api("api/word", { method: "DELETE", json: { en: w.en } });
        if (d.progress) state.progress = { ...state.progress, words: d.progress.words };
        renderVocabBtn();
        renderVocab();
        toast(`🗑 «${w.en.slice(0, 30)}» lug'atdan o'chirildi`);
      } catch (err) {
        li.classList.remove("removing");
        toast(err.message);
      }
    });
    li.append(del);
    ul.append(li);
  }
  $("vocabCopy").hidden = !items.length || Boolean(state.flash);
}

// 📋 Lug'atni matn ko'rinishida nusxalash (Telegram "Saqlangan xabarlar"ga yoki daftarga)
$("vocabSearch").addEventListener("input", () => renderVocab());

$("vocabCopy").addEventListener("click", async () => {
  haptic();
  const fix = state.vocabTab === "fix";
  let items = (state.progress?.words || []).filter((w) => (fix ? w.type === "fix" : w.type !== "fix"));
  // Qidiruv bo'lsa — faqat topilganlar nusxalanadi
  const norm = (x) => String(x || "").toLowerCase().replace(/[‘’`ʻʼ]/g, "'");
  const vq = $("vocabSearch").hidden ? "" : norm($("vocabSearch").value.trim());
  if (vq) items = items.filter((w) => [w.en, w.uz, w.wrong].some((x) => norm(x).includes(vq)));
  const lines = items.map((w, i) => (fix ? `${i + 1}. ❌ ${w.wrong || ""} → ✅ ${w.en}${w.uz ? ` (${w.uz})` : ""}` : `${i + 1}. ${w.en} — ${w.uz || ""}`));
  const text = `${fix ? "✏️ Xatolarim" : "📚 Yangi so'zlarim"} (Sado)\n\n${lines.join("\n")}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`📋 ${items.length} ta ${fix ? "xato" : "so'z"} nusxalandi`);
  } catch {
    // Eski brauzerlar uchun zaxira usul
    const ta = el("textarea", "");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? `📋 ${items.length} ta nusxalandi` : "Nusxalab bo'lmadi");
  }
});
$("moreBtn").addEventListener("click", () => {
  haptic();
  localStorage.setItem("sado-more", localStorage.getItem("sado-more") === "1" ? "0" : "1");
  renderMoreStats();
});
$("vocabBtn").addEventListener("click", () => {
  haptic();
  renderVocab();
  $("vocabSheet").hidden = false;
});
$("vocabClose").addEventListener("click", () => {
  $("vocabSheet").hidden = true;
  stopVocabPlay();
  stopFlash();
});

// 🎧 Hammasini tinglash: ro'yxatdagi so'zlar ketma-ket o'qiladi (qo'l bo'sh takrorlash)
function stopVocabPlay() {
  if (!state.vocabPlay) return;
  state.vocabPlay.stop = true;
  state.vocabPlay = null;
  $("vocabPlay").textContent = "🎧 Tinglash";
  $("vocabPlay").classList.remove("on");
  document.querySelectorAll("#vocabList .playing").forEach((x) => x.classList.remove("playing"));
}
$("vocabPlay").addEventListener("click", async () => {
  haptic();
  if (state.vocabPlay) return stopVocabPlay();
  const run = (state.vocabPlay = { stop: false });
  $("vocabPlay").textContent = "⏹ To'xtatish";
  $("vocabPlay").classList.add("on");
  const lis = [...$("vocabList").querySelectorAll("li[data-en]")];
  for (const li of lis) {
    if (run.stop) return;
    document.querySelectorAll("#vocabList .playing").forEach((x) => x.classList.remove("playing"));
    li.classList.add("playing");
    li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    await sayPhrase(li.dataset.en).catch(() => {});
    await new Promise((res) => setTimeout(res, 1200)); // o'quvchi takrorlashi uchun pauza
  }
  if (!run.stop) stopVocabPlay();
});

// 🃏 Kartochka mashqi: o'zbekchasi ko'rsatiladi, inglizchasini eslash kerak
function stopFlash() {
  state.flash = null;
  $("flash").hidden = true;
  $("vocabList").hidden = false;
  $("flashBtn").hidden = false;
}
function startFlash() {
  // Ochiq bo'lim bo'yicha: "Xatolarim"da — faqat xatolar, "So'zlar"da — faqat so'zlar
  const fixTab = state.vocabTab === "fix";
  const words = (state.progress?.words || []).filter((w) => w.en && (fixTab ? w.type === "fix" : w.type !== "fix" && w.uz));
  if (!words.length) return toast(fixTab ? "Hozircha xato yo'q 👏" : "Lug'atda hali so'z yo'q");
  // 🧠 Leitner usuli: "Bilmadim" deyilgan va yangi so'zlar oldinroq, yaxshi bilinganlar kamroq chiqadi
  const box = flashBoxes();
  const deck = words
    .map((w) => ({ w, k: (box[w.en.toLowerCase()] || 0) + Math.random() * 0.9 }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 10)
    .map((x) => x.w);
  state.flash = { deck, i: 0, known: 0, open: false };
  $("vocabList").hidden = true;
  $("vocabCopy").hidden = true;
  $("flashBtn").hidden = true;
  $("vocabQuiz").hidden = true;
  stopVocabPlay();
  $("vocabPlay").hidden = true;
  $("reviewBtn").hidden = true;
  $("flash").hidden = false;
  renderFlash();
}
// 🧩 Lug'at testi: o'zbekchasi beriladi, 3 ta inglizcha variantdan to'g'risini tanlash
// (grammatika statistikasiga aralashmaydi; natija kartochkalardagi "bilaman" qutilariga yoziladi)
function startVocabQuiz() {
  const fixTab = state.vocabTab === "fix";
  const words = (state.progress?.words || []).filter((w) => w.en && w.uz && (fixTab ? w.type === "fix" : w.type !== "fix"));
  const uniq = [...new Map(words.map((w) => [w.en.toLowerCase(), w])).values()];
  if (uniq.length < 3) return toast("Test uchun lug'atda kamida 3 ta so'z kerak");
  const quiz = uniq.map((w) => {
    const others = uniq.filter((x) => x !== w).sort(() => Math.random() - 0.5).slice(0, 2).map((x) => x.en);
    return { text: `«${w.uz}» → ___`, answer: w.en, options: [w.en, ...others], from: "" };
  });
  stopVocabPlay();
  $("vocabSheet").hidden = true;
  $("mixLevels").innerHTML = "";
  $("mixSheet").hidden = false;
  state.mixWeak = new Map();
  const onAnswer = (it, ok) => {
    const box = flashBoxes();
    const k = it.answer.toLowerCase();
    box[k] = ok ? Math.min(5, (box[k] || 0) + 1) : 0;
    localStorage.setItem("sado-flash", JSON.stringify(box));
  };
  renderQuiz({ id: "vocab-quiz", quiz, noStats: true, onAnswer }, $("mixQuiz"), `🧩 So'z testi · ${Math.min(10, quiz.length)} ta savol`, Math.min(10, quiz.length));
}
function flashBoxes() {
  try {
    return JSON.parse(localStorage.getItem("sado-flash") || "{}");
  } catch {
    return {};
  }
}

function renderFlash() {
  const f = state.flash;
  const box = $("flash");
  box.innerHTML = "";
  if (f.i >= f.deck.length) {
    box.append(
      el("div", "flash-done", `${f.known >= f.deck.length * 0.7 ? "🎉" : "💪"} ${f.deck.length} tadan ${f.known} tasini bildingiz!`),
    );
    // 🧠 Yodlanganlar: kamida 3 marta ketma-ket "Bildim"
    const bx = flashBoxes();
    const all = (state.progress?.words || []).filter((w) => w.en && w.uz);
    const mastered = all.filter((w) => (bx[w.en.toLowerCase()] || 0) >= 3).length;
    const bar = el("div", "flash-mastery");
    const fill = el("i", "");
    fill.style.width = `${all.length ? Math.round((mastered / all.length) * 100) : 0}%`;
    bar.append(fill);
    box.append(el("div", "flash-mastery-t", `🧠 Yodlangan: ${mastered} / ${all.length} ta so'z`), bar);
    const again = el("button", "btn primary wide", "🔁 Yana bir marta");
    again.addEventListener("click", startFlash);
    const back = el("button", "btn ghost wide", "Lug'atga qaytish");
    back.addEventListener("click", () => (stopFlash(), renderVocab()));
    box.append(again, back);
    return;
  }
  const w = f.deck[f.i];
  box.append(el("div", "flash-count", `${f.i + 1} / ${f.deck.length}`));
  const card = el("div", "flash-card" + (f.open ? " open" : ""));
  card.append(el("div", "flash-q", w.type === "fix" ? `Xato: ${w.wrong}` : w.uz));
  card.append(el("div", "flash-a", f.open ? w.en : "Bosing — javobni ko'rish 👆"));
  card.addEventListener("click", () => {
    if (!f.open) {
      f.open = true;
      sayPhrase(w.en).then(() => mascot.setLevel(0));
      renderFlash();
    }
  });
  box.append(card);
  if (f.open) {
    const row = el("div", "flash-row");
    const no = el("button", "btn ghost", "😕 Bilmadim");
    const yes = el("button", "btn ok", "✅ Bildim");
    no.addEventListener("click", () => next(false));
    yes.addEventListener("click", () => next(true));
    row.append(no, yes);
    box.append(row);
  }
  function next(knew) {
    haptic(knew ? "success" : "light");
    if (knew) f.known++;
    // So'z "qutisi": bildim — yuqoriga (5 gacha), bilmadim — boshiga qaytadi
    const bx = flashBoxes();
    const key = w.en.toLowerCase();
    bx[key] = knew ? Math.min(5, (bx[key] || 0) + 1) : 0;
    localStorage.setItem("sado-flash", JSON.stringify(bx));
    f.i++;
    f.open = false;
    renderFlash();
  }
}
// 🔁 Shaxsiy dars: xatolar asosida (server lessonId "review" bilan tuzadi)
$("reviewBtn").addEventListener("click", () => {
  const allFix = (state.progress?.words || []).filter((w) => w.type === "fix" && w.en);
  const fixes = [...allFix.filter((w) => !w.fixed), ...allFix.filter((w) => w.fixed)].slice(0, 6);
  $("vocabSheet").hidden = true;
  startLesson(
    {
      id: "review",
      title: "Xatolarim ustida ishlash",
      emoji: "🔁",
      level: "Shaxsiy",
      phrases: fixes.map((f) => ({ en: f.en, uz: `Xato edi: ${f.wrong || ""}` })),
    },
    // Xatolarni o'zbekcha tushuntirish uchun ustoz rejimi; yaxshi biladiganlarga — inglizcha suhbat
    localStorage.getItem("sado-level") === "adv" ? "chat" : "tutor",
  );
});

$("vocabQuiz").addEventListener("click", () => { haptic(); startVocabQuiz(); });
$("flashBtn").addEventListener("click", () => {
  haptic();
  startFlash();
});
$("vocabSheet").addEventListener("click", (e) => {
  if (e.target.id === "vocabSheet") $("vocabSheet").hidden = true, stopVocabPlay();
});
for (const b of document.querySelectorAll(".vocab-tabs .chip-f")) {
  b.addEventListener("click", () => {
    state.vocabTab = b.dataset.t;
    stopVocabPlay();
    $("vocabSearch").value = "";
    for (const x of document.querySelectorAll(".vocab-tabs .chip-f")) x.classList.toggle("on", x === b);
    renderVocab();
  });
}

// 📈 So'nggi natijalar: oxirgi 7 ta dars balli ustunlarda
function renderTrend() {
  const box = $("trend");
  const recent = (state.progress?.recent || []).slice(0, 7).reverse();
  if (recent.length < 2) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  const avg = (a) => Math.round(a.reduce((x, r) => x + r.score, 0) / a.length);
  const half = Math.floor(recent.length / 2);
  const diff = avg(recent.slice(half)) - avg(recent.slice(0, half));
  const head = el("div", "trend-head");
  head.append(
    el("b", "", "📈 So'nggi natijalar"),
    el("span", diff > 0 ? "up" : diff < 0 ? "down" : "", diff > 0 ? `▲ +${diff} ball` : diff < 0 ? `▼ ${diff} ball` : "barqaror"),
  );
  box.append(head);
  const bars = el("div", "trend-bars");
  const info = el("div", "trend-info", "");
  info.hidden = true;
  for (const r of recent) {
    const l = state.lessons.find((x) => x.id === r.lessonId);
    const col = el("div", "tb");
    const bar = el("i", r.score >= 70 ? "hi" : r.score >= 45 ? "mid" : "lo");
    bar.style.height = `${Math.max(8, r.score)}%`;
    col.append(el("em", "", String(r.score)), el("span", "tb-track", ""), el("small", "", l?.emoji || "📘"));
    col.querySelector(".tb-track").append(bar);
    col.title = `${l?.title || ""} · ${r.level || ""}`;
    // Ustunni bosish — qaysi dars, qachon va qanday natija
    col.addEventListener("click", () => {
      haptic();
      for (const c of bars.children) c.classList.toggle("sel", c === col);
      const d = new Date(r.at);
      const when = isNaN(d) ? "" : `\u00a0·\u00a0${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`; // sana alohida qatorga tushmasin
      info.innerHTML = "";
      info.append(el("span", "", `${l?.emoji || "📘"} ${l?.title || "Dars"} — ${r.score} ball${r.level ? ` (${r.level})` : ""}${when}`));
      // 🔁 Shu darsni darhol qayta o'tish (ballni oshirish uchun)
      if (l && !l.liveOnly) {
        const again = el("button", "trend-again", "🔁 Qayta o'tish");
        again.addEventListener("click", (e) => { e.stopPropagation(); haptic(); openSheet(l); });
        info.append(again);
      }
      info.hidden = false;
    });
    bars.append(col);
  }
  box.append(bars, info);
}

// 🏅 Yutuqlar: progressdan hisoblanadi
const BADGES = [
  ["🎤", "Birinchi qadam", "Birinchi darsni tugating", (p) => p.done >= 1],
  ["🔥", "3 kun ketma-ket", "3 kun ketma-ket mashq qiling", (p) => (p.bestStreak || p.streak) >= 3],
  ["📚", "10 ta dars", "10 xil darsni o'ting", (p) => p.done >= 10],
  ["💯", "A'lochi", "Biror darsda 90+ ball oling", (p) => (p.best || 0) >= 90],
  ["🧠", "So'z ustasi", "Lug'atga 30 ta so'z yig'ing", (p) => (p.words || []).length >= 30],
  ["🏆", "IELTS 6+", "IELTS darsida 6.0+ band oling", (p) => p.ielts],
  ["⚡", "Hafta qahramoni", "7 kun ketma-ket mashq qiling", (p) => (p.bestStreak || p.streak) >= 7],
  ["🛠", "Xato tuzatuvchi", "5 ta xatoingizni tuzating", (p) => (p.words || []).filter((w) => w.fixed).length >= 5],
  ["🃏", "Kartochka ustasi", "Kartochkalarda 10 ta so'zni yodlang", () => Object.values(flashBoxes()).filter((n) => n >= 3).length >= 10],
  ["🗣", "Gapdon", "Bitta darsda 50 ta inglizcha so'z ayting", (p) => (p.maxWords || 0) >= 50],
  ["🎓", "Kurs bitiruvchisi", "IELTS, CEFR yoki Grammatika kursini to'liq tugating", (p) => ["IELTS kursi", "CEFR kursi", "Grammatika gapirib"].some((c) => { const all = state.lessons.filter((l) => l.category === c); return all.length && all.every((l) => p.lessons?.[l.id]); })],
  ["🧩", "Grammatika a'lochisi", "10 ta grammatika mavzusida testni xatosiz ishlang", () => grPerfectCount() >= 10],
  ["📅", "Test seriyasi", "«Bugungi test»ni 7 kun ketma-ket ishlang", () => (dailyTest().best || dailyTest().streak || 0) >= 7],
  ["🌍", "Har tomonlama", "5 xil bo'limdan dars o'ting", (p) => new Set(Object.keys(p.lessons || {}).map((id) => state.lessons.find((l) => l.id === id)?.category).filter(Boolean)).size >= 5],
];
function renderBadges() {
  const p = state.progress;
  const box = $("badges");
  if (!p) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  const got = BADGES.filter((b) => hasBadge(b, p)).length;
  const head = el("div", "trend-head");
  head.append(el("b", "", "🏅 Yutuqlar"), el("span", "", `${got} / ${BADGES.length}`));
  box.append(head);
  const row = el("div", "badge-row");
  for (const [ico, name, how, test] of BADGES) {
    const on = hasBadge([ico, name, how, test], p);
    const b = el("button", "badge" + (on ? " on" : ""));
    b.append(el("span", "badge-ico", ico), el("small", "", name));
    // 📈 Ochilmagan yutuqqa qancha qolgani
    const pr = !on && BADGE_PROGRESS[name] ? BADGE_PROGRESS[name](p) : null;
    if (pr) {
      const bar = el("i", "badge-bar");
      bar.style.setProperty("--p", Math.min(100, Math.round((pr[0] / pr[1]) * 100)) + "%");
      b.append(bar);
    }
    b.addEventListener("click", () => toast(on ? `🏅 ${name} — qo'lga kiritilgan!` : `🔒 ${name}: ${how}${pr ? ` (${pr[0]}/${pr[1]})` : ""}`, 2500));
    row.append(b);
  }
  box.append(row);
}

// 📊 Natijalar plitkasi: bosilganda grafik va yutuqlar ochiladi
function renderMoreStats() {
  const p = state.progress;
  const btn = $("moreBtn");
  btn.hidden = !p;
  if (!p) return ($("moreStats").hidden = true);
  const open = localStorage.getItem("sado-more") === "1";
  const got = BADGES.filter((b) => hasBadge(b, p)).length;
  btn.innerHTML = "";
  btn.append(el("b", "", "📊 Natijalar"), el("small", "", `🏅 ${got}/${BADGES.length} yutuq ${open ? "▴" : "▾"}`));
  btn.classList.toggle("on", open);
  $("moreStats").hidden = !open;
}

// 🌟 Kun iborasi: sanaga qarab har kuni boshqa ibora (hamma uchun bir xil)
// 🌟 Kun iborasi tanlovi: "kun|ibora" xeshi eng kichik bo'lgani. Yangi dars qo'shilsa ham
// odatda o'zgarmaydi (ro'yxatdagi tartib raqamiga bog'liq emas). Serverdagi eslatma bilan bir xil.
function phraseHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function dailyPick(pool, dayNo, k = 0) {
  return pool
    .map((x) => [phraseHash(`${dayNo}|${x.p.en}`), x])
    .sort((a, b) => a[0] - b[0])[k % pool.length][1];
}
function renderDaily() {
  const box = $("daily");
  const pool = state.lessons.filter((l) => !l.liveOnly).flatMap((l) => l.phrases.filter((p) => !p.en.includes("...")).map((p) => ({ p, l })));
  if (!pool.length) return (box.hidden = true);
  const d = new Date();
  const dayNo = Math.floor((d.getTime() + 5 * 3600_000) / 86400_000); // Toshkent vaqti
  const { p, l } = dailyPick(pool, dayNo, state.dailyOff || 0);
  box.hidden = false;
  box.innerHTML = "";
  const top = el("div", "daily-top");
  top.append(el("span", "daily-tag", "🌟 Kun iborasi"), el("span", "daily-from", `${l.emoji} ${l.title.replace(/^\d+\.\s*/, "")}`));
  // Oxirgi so'z va 🔊 bir qatorda qoladi
  const words = p.en.split(" ");
  const last = words.pop();
  const en = el("button", "daily-en", words.length ? words.join(" ") + " " : "");
  en.append(el("span", "nowrap", `${last} 🔊`));
  en.addEventListener("click", async () => {
    haptic();
    en.classList.add("busy");
    await sayPhrase(p.en).catch(() => speakBrowser(p.en, "en")); // Sado'ning tabiiy ovozi
    mascot.setLevel(0);
    en.classList.remove("busy");
  });
  const go = el("button", "daily-go", "Shu darsni ochish ›");
  go.addEventListener("click", () => openSheet(l));
  // ⏭ Yana bitta ibora (faqat shu ochilishda; ertaga yangi kun iborasi)
  const more = el("button", "daily-go daily-more", state.dailyOff ? `⏭ Yana (${state.dailyOff + 1})` : "⏭ Yana bitta");
  more.addEventListener("click", () => {
    haptic();
    state.dailyOff = (state.dailyOff || 0) + 1;
    renderDaily();
  });
  // 📒 Lug'atga saqlash
  const saved = (state.progress?.words || []).some((w) => w.en === p.en);
  const keep = el("button", "daily-go daily-more", saved ? "✅ Lug'atda" : "📒 Saqlash");
  keep.disabled = saved;
  keep.addEventListener("click", async () => {
    haptic();
    try {
      const d = await api("api/word", { json: { en: p.en } });
      if (d.progress) state.progress = { ...state.progress, words: d.progress.words };
      renderVocabBtn();
      keep.textContent = "✅ Lug'atda";
      keep.disabled = true;
      toast("📒 Lug'atingizga saqlandi — kartochkalarda takrorlanadi");
    } catch (e) {
      toast(e.message);
    }
  });
  // 📤 Kun iborasini do'stlarga ulashish
  const share = el("button", "daily-go daily-more daily-share", "📤");
  share.title = "Do'stlarga ulashish";
  share.addEventListener("click", () => {
    haptic();
    const text = `🌟 Bugungi inglizcha ibora:\n${p.en}\n🇺🇿 ${p.uz}\n\nSado bilan har kuni bitta ibora o'rganing 👇`;
    const url = state.shareUrl || "https://t.me";
    const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
    else if (navigator.share) navigator.share({ text: text + (state.shareUrl ? "\n" + state.shareUrl : "") }).catch(() => {});
    else window.open(link, "_blank");
  });
  const row = el("div", "daily-row");
  const right = el("span", "daily-btns");
  right.append(keep, more, share);
  row.append(go, right);
  box.append(top, en, el("div", "daily-uz", p.uz), row);
  // 🔁 Kechagi ibora: o'zbekchasi ko'rinadi, inglizchasini eslab, bosib tekshirish (takrorlash)
  if (!state.dailyOff) {
    const y = dailyPick(pool, dayNo - 1).p;
    if (y.en !== p.en) {
      const rev = el("button", "daily-yday");
      rev.append(el("span", "", "🔁 Kechagi: "), el("b", "", `«${y.uz}»`), el("em", "", " — inglizchasini eslang, keyin bosing"));
      rev.addEventListener("click", async () => {
        haptic();
        if (!rev.classList.contains("open")) {
          rev.classList.add("open");
          rev.lastChild.textContent = ` → ${y.en} 🔊`;
        }
        await sayPhrase(y.en).catch(() => speakBrowser(y.en, "en"));
        mascot.setLevel(0);
      });
      box.append(rev);
    }
  }
  // 🧩 Ibora grammatika darsidan bo'lsa — shu mavzudan bitta tezkor savol (shu yerning o'zida)
  if (l.quiz?.length) {
    const q = l.quiz[phraseHash(`${dayNo}|${state.dailyOff || 0}|q`) % l.quiz.length];
    const [before, after] = q.text.split("___");
    const qb = el("div", "daily-q");
    const line = el("div", "daily-q-text");
    const gap = el("b", "daily-q-gap", "____");
    line.append(el("span", "", "🧩 " + before), gap, el("span", "", after));
    const opts = el("div", "daily-q-opts");
    for (const o of [...q.options].sort((a, b) => phraseHash(dayNo + a) - phraseHash(dayNo + b))) {
      const b = el("button", "qz-opt", o);
      b.addEventListener("click", () => {
        if (opts.dataset.done) return;
        opts.dataset.done = "1";
        const ok = o === q.answer;
        haptic(ok ? "light" : "medium");
        b.classList.add(ok ? "ok" : "bad");
        if (!ok) [...opts.children].find((x) => x.textContent === q.answer)?.classList.add("ok");
        gap.textContent = q.answer;
        gap.classList.add("ok");
        quizMiss({ before: before.trimEnd(), after, answer: q.answer, options: q.options, from: l.id }, l.id, ok);
        if (!ok) toast("💡 Bu mavzu «Shu darsni ochish» da batafsil", 2500);
      });
      opts.append(b);
    }
    qb.append(line, opts);
    box.append(qb);
  }
  // 📅 Bugungi grammatika testiga tezkor havola (grammatika bo'limiga kirmasdan)
  if (state.lessons.some((l) => l.quiz?.length)) {
    const dt = dailyTest();
    const done = dt.day === dayNum();
    const alive = done || dt.day === dayNum() - 1;
    const link = el("button", "daily-test" + (done ? " done" : ""), done
      ? `✅ Bugungi test: ${dt.score}${dt.streak ? ` · 🔥 ${dt.streak} kun` : ""}`
      : `📅 Bugungi grammatika testi — 5 ta savol${alive && dt.streak ? ` · 🔥 ${dt.streak}` : ""} ›`);
    link.addEventListener("click", () => { haptic(); openDailyTest(); });
    box.append(link);
  }
}

// 📅 Haftalik xulosa
// 🎯 Taxminiy IELTS band (IELTS darslaridagi so'nggi natijalardan)
function renderBand() {
  const b = state.progress?.band;
  const box = $("band");
  const cefr = state.progress?.cefr;
  box.hidden = !b && !cefr;
  box.innerHTML = "";
  box.classList.toggle("cefr", !b && Boolean(cefr));
  // IELTS natijasi bo'lmasa — CEFR zinapoyasi
  if (!b && cefr) {
    const L = ["A1", "A2", "B1", "B2", "C1", "C2"];
    const ml = state.progress?.ml;
    box.append(el("b", "", `📗 Taxminiy daraja: ${cefr}`), el("span", "", ml != null ? `🇺🇿 Multilevel ~${ml}/75` : "so'nggi darslar bo'yicha"));
    const ladder = el("div", "cefr-ladder");
    for (const x of L) ladder.append(el("i", L.indexOf(x) < L.indexOf(cefr) ? "done" : x === cefr ? "on" : "", x));
    box.append(ladder);
    return;
  }
  if (!b) return;
  const goal = Number(localStorage.getItem("sado-band-goal")) || 6.5;
  const pct = Math.min(100, Math.round((b.value / goal) * 100));
  box.append(el("b", "", `🎯 Taxminiy IELTS: ${b.value.toFixed(1)}`), el("span", "", `maqsad ${goal.toFixed(1)} · bosing`));
  const bar = el("i", "band-bar");
  bar.style.setProperty("--p", pct + "%");
  box.append(bar);
  box.title = `Oxirgi ${b.n} ta IELTS natijasi asosida`;
}
$("band").addEventListener("click", () => {
  if ($("band").classList.contains("cefr")) return;
  // Maqsad bandni almashtirish: 5.5 → 6.0 → 6.5 → 7.0 → 7.5 → 8.0
  haptic();
  const G = [5.5, 6, 6.5, 7, 7.5, 8];
  const cur = Number(localStorage.getItem("sado-band-goal")) || 6.5;
  const next = G[(G.indexOf(cur) + 1) % G.length];
  localStorage.setItem("sado-band-goal", String(next));
  renderBand();
  toast(`🎯 IELTS maqsadingiz: ${next.toFixed(1)}`);
});

function renderWeek() {
  renderBand();
  const w = state.progress?.week;
  const box = $("week");
  if (!w || !w.n) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  box.append(el("b", "", `📅 Bu hafta: ${w.n} dars · ~${w.avg} ball`));
  if (w.prevAvg != null) {
    const d = w.avg - w.prevAvg;
    box.append(el("span", d > 0 ? "up" : d < 0 ? "down" : "", d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "= barqaror"));
  } else box.append(el("span", "", "birinchi hafta 🌱"));
  // 🗓 7 kunlik mini kalendar: mashq qilingan kunlar yashil
  const d7 = state.progress?.days7;
  if (d7?.length) {
    const WD = ["Ya", "Du", "Se", "Ch", "Pa", "Ju", "Sh"];
    const row = el("div", "days7");
    d7.forEach((x, i) => {
      const wd = WD[new Date(x.d + "T12:00:00").getDay()];
      row.append(el("i", (x.on ? "on" : "") + (i === 6 ? " today" : ""), wd));
    });
    box.append(row);
  }
}

function renderLessons() {
  renderDaily();
  renderWeek();
  renderGoal();
  renderMoreStats();
  renderBadges();
  renderStats();
  renderVocabBtn();
  renderTrend();
  renderNext();
  const list = $("lessonList");
  list.innerHTML = "";
  // O'zbekcha tutuq belgilari (o' oʻ o` o’) va katta-kichik harf farqi hisobga olinmaydi
  const norm = (t) => t.toLowerCase().replace(/[‘’ʻʼ`´']/g, "'").replace(/\s+/g, " ");
  const q = norm(state.filter.q.trim());
  const hits = new Map(); // dars id -> topilgan ibora
  const items = state.lessons.filter((l) => {
    if (l.liveOnly) return false;
    if (state.filter.cat && !(state.filter.cat === "__fav" ? state.favs.has(l.id) : state.filter.cat === "__weak" ? weakIds().includes(l.id) : state.filter.cat === "__new" ? state.newIds?.has(l.id) && !state.progress?.lessons?.[l.id] : state.filter.cat === "__hard" ? isHard(l) : l.category === state.filter.cat)) return false;
    if (!q) return true;
    // Sarlavha, bo'lim, ID (masalan "cafe", "airport") va Sado birinchi gapi bo'yicha ham
    if (norm(l.title + " " + l.category + " " + l.id.replace(/-/g, " ") + " " + (l.kw || "") + " " + (l.openerUz || "")).includes(q)) return true;
    const p = l.phrases.find((x) => norm(x.en + " " + x.uz).includes(q));
    if (p) hits.set(l.id, p);
    return Boolean(p);
  });
  // 🔍 Qidiruvda nechta dars topilgani
  if (q && items.length) list.append(el("p", "search-count", `🔍 «${state.filter.q.trim()}» — ${items.length} ta dars topildi`));
  if (!items.length) {
    list.append(el("p", "note", "Hech narsa topilmadi. Boshqa so'z bilan qidirib ko'ring."));
    // 💬 Topilmagan mavzuni Erkin suhbatda gaplashish taklifi
    const q = (state.filter.q || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const free = state.lessons.find((l) => l.liveOnly);
    if (q.length >= 3 && free && state.liveEnabled) {
      const b = el("button", "btn next wide search-free", `💬 Sado bilan «${q}» haqida gaplashish`);
      b.addEventListener("click", () => {
        haptic("medium");
        state.topic = "custom:" + q;
        localStorage.setItem("sado-topic", state.topic);
        renderTopicPick();
        startLesson(free, "live");
      });
      list.append(b);
    }
    return;
  }
  const done = state.progress?.lessons || {};
  const partOf = (l) => (l.id.match(/^ielts-p(\d)/) || [])[1];
  const PART_NAMES = { 1: "Part 1 — qisqa savollar", 2: "Part 2 — kartochka (monolog)", 3: "Part 3 — muhokama",
    "gr-beg": "🌱 A1–A2 — boshlang'ich", "gr-mid": "🌿 B1 — o'rta", "gr-adv": "🌳 B2 — yuqori" };
  let lastCat = null;
  let lastPart = null;
  const canFold = !state.filter.q && !state.filter.cat;
  let folded;
  try { folded = new Set(JSON.parse(localStorage.getItem("sado-folded") || "[]")); } catch { folded = new Set(); }
  // 📂 Hammasini yig'ish / ochish
  if (canFold && items.length > 10) {
    const cats = [...new Set(items.map((l) => l.category).filter(Boolean))];
    const allFolded = cats.every((c) => folded.has(c));
    const t = el("button", "fold-all", allFolded ? "▾ Hammasini ochish" : "▸ Bo'limlarni yig'ish");
    t.addEventListener("click", () => {
      haptic();
      localStorage.setItem("sado-folded", JSON.stringify(allFolded ? [] : cats));
      renderLessons();
    });
    list.append(t);
  }
  let pendingContinue = null;
  for (const l of items) {
    if (l.category && l.category !== lastCat) {
      lastCat = l.category;
      lastPart = null;
      const head = el("div", "cat-title", `${CAT_ICONS[l.category] || "📚"} ${l.category}`);
      // Har bir bo'lim uchun progress: nechta dars o'tilgani
      const all = state.lessons.filter((x) => x.category === l.category);
      if (all.length > 1) {
        const n = all.filter((x) => done[x.id]).length;
        const bar = el("span", "cat-progress");
        bar.append(el("i", ""), el("em", "", `${n}/${all.length}`));
        bar.firstChild.style.width = `${Math.round((n / all.length) * 100)}%`;
        head.append(bar);
      }
      // ▶ Boshlangan kursda — keyingi o'tilmagan darsga bir bosishda o'tish (ro'yxatni aylanib qidirmaslik uchun)
      if (state.filter.cat === l.category && !state.filter.q && all.length > 1) {
        const n = all.filter((x) => done[x.id]).length;
        const nx = items.find((x) => x.category === l.category && !done[x.id] && !x.liveOnly);
        if (n > 0 && nx) {
          const cb = el("button", "cat-continue");
          cb.append(el("span", "", "▶ Davom etish"), el("b", "", `${nx.emoji || ""} ${nx.title}`));
          cb.addEventListener("click", () => { haptic(); openSheet(nx); });
          pendingContinue = cb;
        }
      }
      // ▾/▸ "Hammasi" ko'rinishida bo'limni yig'ish/ochish (qidiruv va filtrda doim ochiq)
      if (canFold) {
        const cat = l.category;
        const isFolded = folded.has(cat);
        head.classList.add("foldable");
        head.classList.toggle("folded", isFolded);
        head.prepend(el("span", "fold-ico", isFolded ? "▸" : "▾"));
        // Yig'ilgan bo'limda nimalar kutayotganini ko'rsatamiz: 🆕 yangi va 🔁 takrorlash
        if (isFolded) {
          const inCat = state.lessons.filter((x) => x.category === cat);
          const nNew = inCat.filter((x) => state.newIds?.has(x.id) && !done[x.id]).length;
          const weak = new Set(weakIds());
          const nRep = inCat.filter((x) => weak.has(x.id)).length;
          const before = head.querySelector(".cat-progress");
          // Belgini bosish — tegishli filtrga o'tadi (yangi yoki takrorlash darslari)
          const tag = (cls, txt, f) => {
            const t = el("span", "fold-tag " + cls, txt);
            t.addEventListener("click", (e) => {
              e.stopPropagation();
              haptic();
              state.filter.cat = f;
              renderChips();
              renderLessons();
              scrollToList(true);
            });
            return t;
          };
          if (nNew) head.insertBefore(tag("new", `🆕${nNew}`, "__new"), before);
          if (nRep) head.insertBefore(tag("rep", `🔁${nRep}`, "__weak"), before);
        }
        head.addEventListener("click", () => {
          haptic();
          folded.has(cat) ? folded.delete(cat) : folded.add(cat);
          localStorage.setItem("sado-folded", JSON.stringify([...folded]));
          renderLessons();
        });
      }
      list.append(head);
      if (pendingContinue) list.append(pendingContinue);
      pendingContinue = null;
      // 🧩 Grammatika: mashqlar hisobi va tasodifiy (hali a'lo bo'lmagan) mashq
      if (l.category === "Grammatika gapirib" && !q && !(canFold && folded.has(l.category))) {
        const gr = state.lessons.filter((x) => x.category === l.category && x.quiz?.length);
        const best = quizBest();
        // A'lo — eng yaxshi natijada hamma javob to'g'ri (4/4 yoki 12/12)
        const perfect = gr.filter((x) => { const [a, n] = String(best[x.id] || "").split("/").map(Number); return n > 0 && a === n; });
        if (gr.length) {
          const row = el("div", "gr-quizbar");
          // 🧪 Panel sarlavhasi: savollar soni va umumiy aniqlik
          const st = quizStats();
          const nQ = gr.reduce((n, x) => n + x.quiz.length, 0);
          const top = el("div", "gq-top");
          const seenN = (() => { const ss = seenSet(); return gr.reduce((n, x) => n + x.quiz.filter((q) => { const [b, a] = q.text.split("___"); return ss.has(qKey({ before: b.trimEnd(), after: a, answer: q.answer })); }).length, 0); })();
          top.append(el("b", "", "🧪 Testlar"), el("span", "", `${seenN ? `👁 ${seenN}/${nQ}` : `${nQ} ta savol`} · 🧩 ${perfect.length}/${gr.length} a'lo`));
          if (st.all >= 5) {
            const acc = el("button", "gq-acc", `🎯 ${Math.round((st.ok / st.all) * 100)}% ›`);
            acc.title = "Mavzular bo'yicha aniqlik";
            acc.addEventListener("click", () => { haptic(); openTopicStats(); });
            top.append(acc);
          }
          row.append(top);
          // 📅 Bugungi test banneri
          const dt = dailyTest();
          const doneToday = dt.day === dayNum();
          const alive = doneToday || dt.day === dayNum() - 1;
          const db = el("button", "gq-daily" + (doneToday ? " done" : ""));
          db.append(el("b", "", doneToday ? `✅ Bugungi test bajarildi · ${dt.score}` : "📅 Bugungi test — 5 ta savol"), el("small", "", alive && dt.streak ? `🔥 ${dt.streak} kun ketma-ket${doneToday ? " · ertaga yangi savollar" : " — seriyani uzmang!"}` : "Har kuni yangi savollar · seriya yig'ing"));
          db.addEventListener("click", () => { haptic(); openDailyTest(); });
          row.append(db);
          const pool = gr.filter((x) => !perfect.includes(x));
          const go = el("button", "", pool.length ? "🎲 Tasodifiy mashq" : "🎉 Yana bir mashq");
          go.addEventListener("click", () => {
            haptic();
            const from = pool.length ? pool : gr;
            // Hali umuman urinilmaganlar birinchi
            const fresh = from.filter((x) => !best[x.id]);
            const pick = (fresh.length ? fresh : from)[Math.floor(Math.random() * (fresh.length || from.length))];
            openSheet(pick);
            setTimeout(() => $("sheetQuiz").scrollIntoView({ behavior: "smooth", block: "start" }), 350);
          });
          // 📝 Aralash test: barcha grammatika mavzularidan 10 ta savol
          const mixBest = quizBest()[`gr-mix${localStorage.getItem("sado-mix-lv") || ""}`];
          const mix = el("button", "", "📝 Aralash test");
          if (mixBest) mix.append(el("small", "", `🏆 ${mixBest}`));
          mix.addEventListener("click", () => { haptic(); openMixTest(); });
          const btns = el("span", "gr-qbtns");
          const spBest = Number(localStorage.getItem("sado-speed-best")) || 0;
          const sp = el("button", "", "⚡ 60 soniya");
          if (spBest) sp.append(el("small", "", `🏆 ${spBest} ta`));
          sp.addEventListener("click", () => { haptic(); openSpeedTest(); });
          const lvSaved = localStorage.getItem("sado-gr-level");
          const lvb = el("button", "", "📊 Daraja testi");
          lvb.append(el("small", "", lvSaved ? `🎓 ~${lvSaved}` : "20 savol"));
          lvb.addEventListener("click", () => { haptic(); openLevelTest(); });
          const rb = el("button", "", "📖 Qoidalar");
          rb.append(el("small", "", `${gr.length} ta mavzu`));
          rb.addEventListener("click", () => { haptic(); openRules(); });
          btns.append(mix, sp, lvb, go, rb);
          const nMiss = quizMisses().length;
          if (nMiss) {
            const mb = el("button", "gr-miss", "🔁 Xatolarim");
            mb.append(el("small", "", `${nMiss} ta savol`));
            mb.addEventListener("click", () => { haptic(); openMissTest(); });
            btns.append(mb);
          }
          row.append(btns);
          list.append(row);
        }
      }
    }
    if (canFold && folded.has(l.category)) continue;
    const part = l.category === "IELTS kursi" ? partOf(l) : l.category === "Grammatika gapirib" && !q ? "gr-" + mixLevelOf(l.level) : null;
    if (part && part !== lastPart) {
      lastPart = part;
      // Grammatika daraja guruhi: nechta dars va nechtasi o'tilgan
      let extra = "";
      if (String(part).startsWith("gr-")) {
        const g = state.lessons.filter((x) => x.category === "Grammatika gapirib" && "gr-" + mixLevelOf(x.level) === part);
        extra = ` · ${g.filter((x) => state.progress?.lessons?.[x.id]).length}/${g.length}`;
      }
      const pt = el("div", "part-title", PART_NAMES[part] + extra);
      // 🧪 Shu darajadagi mavzulardan aralash test
      if (String(part).startsWith("gr-")) {
        const tb = el("button", "pt-test", "🧪 Test ›");
        tb.addEventListener("click", () => { haptic(); openMixTest(part.slice(3)); });
        pt.append(tb);
      }
      list.append(pt);
    }
    const btn = lessonButton(l);
    const hit = hits.get(l.id);
    if (hit) {
      const m = el("div", "hit");
      m.append(el("b", "", hit.en), document.createTextNode(" — " + hit.uz));
      btn.querySelector(".lesson-info").append(m);
    }
    list.appendChild(btn);
  }
}

// ⏳ Kunlik limit tugagan bo'lsa — darsni boshlashdan oldin aytamiz va bepul mashqlarni taklif qilamiz
function renderLimitNote() {
  const p = state.progress;
  const left = p?.limit ? p.limit - (p.startedToday || 0) : Infinity;
  const over = left <= 0;
  $("limitNote").hidden = !over;
  for (const id of ["startLiveBtn", "startTutorBtn", "startChatBtn"]) $(id).classList.toggle("locked", over);
  if (!over) return;
  // Toshkent vaqti bilan yarim tungacha qolgan vaqt
  const now = Date.now() + 5 * 3600_000;
  const mins = Math.ceil((86400_000 - (now % 86400_000)) / 60000);
  const h = Math.floor(mins / 60);
  $("limitNote").innerHTML = "";
  $("limitNote").append(
    el("b", "", "⏳ Bugungi darslar limiti tugadi"),
    el("span", "", `Yangi darslar ${h ? h + " soat " : ""}${mins % 60} daqiqadan keyin ochiladi. Hozircha limitsiz mashq qiling: 🎧 Tinglab takrorlash va 📒 lug'at kartochkalari.`),
  );
}

function openSheet(lesson) {
  stopShadow();
  $("startLiveBtn").hidden = !state.liveEnabled;
  // Erkin suhbat faqat jonli rejimda bo'ladi
  $("startTutorBtn").hidden = Boolean(lesson.liveOnly) && state.liveEnabled;
  $("startChatBtn").hidden = Boolean(lesson.liveOnly) && state.liveEnabled;
  haptic();
  state.pendingLesson = lesson;
  renderLimitNote();
  $("sheetEmoji").textContent = lesson.emoji;
  renderFavBtn(lesson);
  $("sheetTitle").textContent = lesson.title;
  // ⭐ Tavsiya etilgan rejim: daraja va o'quvchining o'rtacha baliga qarab
  const recent = state.progress?.recent || [];
  const avg = recent.length ? recent.reduce((s, r) => s + (r.score || 0), 0) / recent.length : null;
  const lvl = String(lesson.level || "");
  let rec = "chat";
  // Hali natija yo'q bo'lsa — tanishuvda tanlangan daraja hisobga olinadi
  const self = avg === null ? localStorage.getItem("sado-level") : null;
  if (self === "beg" || /^A1|^A2$|^A1-|Har/.test(lvl) || (avg !== null && avg < 50)) rec = "tutor";
  else if (state.liveEnabled && (self === "adv" || /B2|C1/.test(lvl) || (avg !== null && avg >= 70))) rec = "live";
  for (const [id, m] of [["startLiveBtn", "live"], ["startTutorBtn", "tutor"], ["startChatBtn", "chat"]]) $(id).classList.toggle("rec", m === rec);
  // 🎭 Vaziyat: Sado suhbatni qanday boshlaydi (o'zbekcha) — o'quvchi rolni oldindan biladi
  $("sheetScene").hidden = !lesson.openerUz || Boolean(lesson.rule);
  $("sheetScene").innerHTML = "";
  if (lesson.openerUz && !lesson.rule) $("sheetScene").append(el("b", "", "🎭 Sado boshlaydi: "), document.createTextNode(`«${lesson.openerUz}»`));
  // ✏️ Grammatika qoidasi
  $("sheetRule").hidden = !lesson.rule;
  if (lesson.rule) {
    $("sheetRule").innerHTML = "";
    $("sheetRule").append(el("b", "", "📖 Qoida"), ruleBody(lesson.rule));
  }
  renderQuiz(lesson);
  // ❓ IELTS Part 1/3: imtihonchi so'raydigan savollar — darsdan oldin ko'rib, eshitib olish
  const qs = $("sheetQs");
  qs.hidden = !lesson.questions?.length;
  qs.innerHTML = "";
  qs.open = false;
  if (lesson.questions?.length) {
    const sm = document.createElement("summary");
    sm.textContent = `❓ Imtihonchi so'raydigan ${lesson.questions.length} ta savol`;
    const ol = el("ol", "");
    for (const q of lesson.questions) {
      const li = el("li", "");
      const bt = el("button", "rule-ex", q);
      bt.addEventListener("click", () => { haptic(); sayPhrase(q).then(() => mascot.setLevel(0)); });
      li.append(bt);
      ol.append(li);
    }
    qs.append(sm, ol, el("small", "rule-tip", "🔊 Savolni bosing — imtihonchi ovozida eshitasiz. Javobni oldindan o'ylab oling"));
  }
  // 📋 CEFR: javob rejasi va 🃏 IELTS Part 2 kartochkasi — darsdan oldin tanishib olish
  else if (lesson.plan?.length || lesson.cue) {
    qs.hidden = false;
    const sm = document.createElement("summary");
    const ul = el("ul", "plain");
    if (lesson.cue) {
      sm.textContent = "🃏 Kartochka — 1 daqiqa tayyorlanib, 2 daqiqa gapirasiz";
      qs.append(sm, el("p", "sheet-cue", lesson.cue.title), el("small", "rule-tip", "You should say:"));
      for (const pt of lesson.cue.points) ul.append(el("li", "", pt));
      qs.append(ul);
    } else {
      sm.textContent = `📋 Javob rejasi — ${lesson.plan.length} qism`;
      for (const st of lesson.plan) ul.append(el("li", "", st));
      qs.append(sm, ul, el("small", "rule-tip", "👆 Imtihonda shu qismlar baholanadi — har biriga to'xtalib o'ting"));
    }
  }
  // Daraja, iboralar soni va oldingi natija
  const meta = $("sheetMeta");
  meta.innerHTML = "";
  meta.append(el("span", "pill", `📊 ${lesson.level}`), el("span", "pill", `🗂️ ${lesson.phrases.length} ta ibora`), el("span", "pill", `⏱️ ${lesson.minutes || state.sessionMinutes} daq`));
  const pr = state.progress?.lessons?.[lesson.id];
  if (pr) meta.append(el("span", "pill ok", `✅ ${pr.best} ball · ${pr.count} marta`));
  // 🕒 Oxirgi marta qachon o'tilgan; 7 kundan oshsa — takrorlashni eslatamiz (unutish egri chizig'i)
  if (pr?.last) {
    const todayStr = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    const days = Math.round((Date.parse(todayStr) - Date.parse(pr.last)) / 86400_000);
    const when = days <= 0 ? "bugun" : days === 1 ? "kecha" : `${days} kun oldin`;
    meta.append(el("span", "pill" + (days >= 7 ? " warn" : ""), days >= 7 ? `🔁 ${when} — takrorlash vaqti` : `🕒 ${when}`));
  }
  const ul = $("sheetPhrases");
  ul.innerHTML = "";
  const render = (all) => {
    ul.innerHTML = "";
    for (const p of all ? lesson.phrases : lesson.phrases.slice(0, 3)) {
      const li = el("li", "", (p.pic ? p.pic + " " : "") + p.en);
      li.append(el("span", "", p.uz));
      li.addEventListener("click", () => sayPhrase(p.en).then(() => mascot.setLevel(0)));
      // 📒 Iborani lug'atga saqlash
      if (state.progress) {
        const has = (state.progress.words || []).some((w) => w.en === p.en);
        const keep = el("button", "ph-keep" + (has ? " on" : ""), has ? "✓" : "＋");
        keep.title = has ? "Lug'atda" : "Lug'atga saqlash";
        keep.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (keep.classList.contains("on")) return toast("📒 Bu ibora lug'atingizda bor");
          haptic();
          try {
            const d = await api("api/word", { json: { en: p.en } });
            if (d.progress) state.progress = { ...state.progress, words: d.progress.words };
            renderVocabBtn();
            keep.classList.add("on");
            keep.textContent = "✓";
            toast("📒 Lug'atga saqlandi");
          } catch (err) {
            toast(err.message);
          }
        });
        li.append(keep);
      }
      ul.append(li);
    }
    if (!all && lesson.phrases.length > 3) {
      const more = el("li", "more", `＋ Yana ${lesson.phrases.length - 3} ta iborani ko'rish`);
      more.addEventListener("click", () => render(true));
      ul.append(more);
    }
  };
  render(false);
  $("startSheet").hidden = false;
  // Yangi dars oynasi doim boshidan ochilsin (oldingi darsning aylantirish joyi qolmasin) — ko'rsatilgandan keyin
  $("startSheet").querySelector(".sheet-card").scrollTop = 0;
}

$("goal").addEventListener("click", () => {
  haptic();
  state.goal = (state.goal % 3) + 1;
  localStorage.setItem("sado-goal", String(state.goal));
  renderGoal();
  toast(`🎯 Yangi maqsad: kuniga ${state.goal} ta dars`, 2000);
});

let searchT;
// Qidiruvga yozilganda qidiruv maydoni ekran tepasiga chiqadi — natijalar ko'rinib turadi
$("searchInput").addEventListener("focus", () => {
  setTimeout(() => {
    const top = $("searchInput").getBoundingClientRect().top + window.scrollY - document.querySelector(".topbar").offsetHeight - 8;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, 250); // klaviatura ochilishini kutamiz
});
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    state.filter.q = e.target.value;
    renderLessons();
  }, 150);
});

// 🗣 Jonli suhbat ovozi: ayol yoki erkak (Sozlamalarda tanlanadi)
state.voice = localStorage.getItem("sado-voice") || "f";

// 🗂 Erkin suhbat mavzusi (ixtiyoriy)
const TOPICS = [["", "🎲 Istalgan"], ["football", "⚽ Futbol"], ["movies", "🎬 Kino"], ["games", "🎮 O'yinlar"], ["future", "🎓 Kelajak"], ["travel", "✈️ Sayohat"], ["music", "🎵 Musiqa"], ["food", "🍲 Taomlar"], ["ielts", "📘 IELTS"]];
state.topic = localStorage.getItem("sado-topic") || "";
function renderTopicPick() {
  const box = $("topicPick");
  box.innerHTML = "";
  const custom = state.topic.startsWith("custom:") ? state.topic.slice(7) : "";
  const items = [...TOPICS, ["__custom", custom ? `✏️ ${custom}` : "✏️ O'z mavzuim"]];
  for (const [t, label] of items) {
    const on = t === "__custom" ? Boolean(custom) : state.topic === t;
    const b = el("span", "tp" + (on ? " on" : "") + (t === "__custom" ? " tp-custom" : ""), label);
    if (t === "__custom") {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        haptic();
        openTopicSheet(custom);
      });
      box.append(b);
      continue;
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      haptic();
      state.topic = t;
      localStorage.setItem("sado-topic", t);
      renderTopicPick();
    });
    box.append(b);
  }
}
renderTopicPick();

// ✏️ O'z mavzuim: o'quvchi istalgan mavzuni yozadi
const TOPIC_IDEAS = ["Shaxmat", "Dasturlash", "Samarqand tarixi", "Kitoblar", "Avtomobillar", "Moda", "Kosmos", "Biznes g'oyalar"];
function openTopicSheet(cur) {
  $("topicInput").value = cur || "";
  const ideas = $("topicIdeas");
  ideas.innerHTML = "";
  // 🕘 Oxirgi yozilgan mavzular (3 tagacha) — birinchi, keyin g'oyalar
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("sado-topics") || "[]"); } catch {}
  const recentSet = new Set(recent.map((x) => x.toLowerCase()));
  for (const t of [...recent, ...TOPIC_IDEAS.filter((x) => !recentSet.has(x.toLowerCase()))]) {
    const b = el("button", "chip-f" + (recentSet.has(t.toLowerCase()) ? " tp-recent" : ""), recentSet.has(t.toLowerCase()) ? "🕘 " + t : t);
    b.type = "button";
    b.addEventListener("click", () => ($("topicInput").value = t));
    ideas.append(b);
  }
  $("topicSheet").hidden = false;
  setTimeout(() => $("topicInput").focus(), 100);
}
$("topicForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("topicInput").value.replace(/\s+/g, " ").trim().slice(0, 60);
  state.topic = t ? "custom:" + t : "";
  localStorage.setItem("sado-topic", state.topic);
  if (t) {
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem("sado-topics") || "[]"); } catch {}
    recent = [t, ...recent.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 3);
    localStorage.setItem("sado-topics", JSON.stringify(recent));
  }
  $("topicSheet").hidden = true;
  renderTopicPick();
  if (t) toast(`💬 Mavzu: ${t}. Endi «Gaplashishni boshlash»ni bosing`, 3000);
});
$("topicCancel").addEventListener("click", () => ($("topicSheet").hidden = true));
$("topicSheet").addEventListener("click", (e) => {
  if (e.target.id === "topicSheet") $("topicSheet").hidden = true;
});

// ⚙️ Sozlamalar: barcha shaxsiy sozlamalar bitta joyda
function renderSettings() {
  const rows = [
    ["🗣 Sado ovozi (jonli suhbat)", [["f", "👩 Ayol"], ["m", "👨 Erkak"]], () => state.voice, (v) => { state.voice = v; localStorage.setItem("sado-voice", v); }],
    ["🐇 Gapirish tezligi", [["0", "🐇 Oddiy"], ["1", "🐢 Sekin"]], () => (state.slow ? "1" : "0"), (v) => { state.slow = v === "1"; localStorage.setItem("sado-slow", v); }],
    ["🇺🇿 O'zbekcha tarjimani aytish", [["1", "Ha"], ["0", "Yo'q"]], () => (state.tr ? "1" : "0"), (v) => { state.tr = v === "1"; localStorage.setItem("sado-tr", v); }],
    ["🙈 Ibora tarjimasini yashirish", [["0", "Yo'q"], ["1", "Ha (o'zimni sinayman)"]], () => (localStorage.getItem("sado-hideuz") === "1" ? "1" : "0"), (v) => { localStorage.setItem("sado-hideuz", v); applyHideUz(); }],
    ["🎚 Ingliz tilim darajasi", [["beg", "🌱 Boshlovchi"], ["mid", "🌿 O'rtacha"], ["adv", "🌳 Yaxshi"]], () => localStorage.getItem("sado-level") || "", (v) => { localStorage.setItem("sado-level", v); renderNext(); }],
    ...(state.progress?.remindAvailable
      ? [["🔔 Kechki eslatma (Telegram)", [["1", "Ha"], ["0", "Yo'q"]], () => (state.progress?.remind ? "1" : "0"), (v) => {
          state.progress.remind = v === "1";
          setTimeout(renderSettings, 0);
          api("api/remind", { json: { on: v === "1" } })
            .then(() => toast(v === "1" ? "🔔 Seriya uzilay desa, kechqurun bot eslatadi" : "🔕 Eslatma o'chirildi"))
            .catch((e) => toast(e.message));
        }]]
      : []),
    ...(state.progress?.remindAvailable && state.progress?.remind
      ? [["⏰ Eslatma vaqti", [["19", "19:00"], ["20", "20:00"], ["21", "21:00"], ["22", "22:00"]], () => String(state.progress.remindHour || state.progress.remindDefault || 20), (v) => {
          state.progress.remindHour = Number(v);
          api("api/remind", { json: { on: true, hour: Number(v) } }).then(() => toast(`⏰ Eslatma soat ${v}:00 da keladi`)).catch((e) => toast(e.message));
        }]]
      : []),
    // 🧭 Yo'nalish (tanishuvdagi maqsad) — "Keyingi dars" va tasodifiy darslar shunga moslanadi
    ["🧭 Yo'nalish", [["", "Umumiy"], ["IELTS kursi", "IELTS"], ["CEFR kursi", "CEFR"], ["Grammatika gapirib", "Grammatika"], ["Kundalik hayot", "Kundalik"], ["Bolalar uchun", "Bola"]], () => {
      const a = localStorage.getItem("sado-aim") || "";
      return ["IELTS kursi", "CEFR kursi", "Grammatika gapirib", "Kundalik hayot", "Bolalar uchun"].includes(a) ? a : "";
    }, (v) => {
      v ? localStorage.setItem("sado-aim", v) : localStorage.removeItem("sado-aim");
      renderNext();
    }],
    ["📝 Aralash test uzunligi", [["10", "10 ta savol"], ["20", "20 ta savol"]], () => String(mixLen()), (v) => { localStorage.setItem("sado-mix-n", v); if (state.lessons.length) keepScroll(renderLessons); }],
    ["🎯 Kunlik maqsad", [["1", "1 dars"], ["2", "2 dars"], ["3", "3 dars"]], () => String(state.goal), (v) => { state.goal = Number(v); localStorage.setItem("sado-goal", v); renderGoal(); }],
    ["🌙 Ko'rinish", [["auto", "Avto"], ["light", "☀️ Kunduzgi"], ["dark", "🌙 Tungi"]], () => localStorage.getItem("sado-theme") || "auto", (v) => { localStorage.setItem("sado-theme", v); applyTheme(); }],
    ["Aa Matn o'lchami", [["0", "Oddiy"], ["1", "Katta"], ["2", "Juda katta"]], () => String((Number(localStorage.getItem("sado-font")) || 0) % 3), (v) => { localStorage.setItem("sado-font", v); applyFont(); }],
  ];
  const box = $("setRows");
  box.innerHTML = "";
  for (const [title, opts, get, set] of rows) {
    const r = el("div", "set-row");
    const tt = el("div", "set-title", title);
    // Hali tanlanmagan sozlama — kichik eslatma
    if (!opts.some(([v]) => v === get())) tt.append(el("em", "", " · tanlanmagan"));
    r.append(tt);
    const seg = el("div", "seg");
    for (const [v, label] of opts) {
      const b = el("button", "seg-b" + (get() === v ? " on" : ""), label);
      b.addEventListener("click", () => {
        haptic();
        set(v);
        renderSettings();
      });
      seg.append(b);
    }
    r.append(seg);
    box.append(r);
  }
}
$("setBtn").addEventListener("click", () => {
  haptic();
  renderSettings();
  $("soundAsk").hidden = true;
  $("soundTest").textContent = "🔊 Ovozni tekshirish";
  $("setSheet").hidden = false;
});
$("setClose").addEventListener("click", () => {
  $("setSheet").hidden = true;
  toast("✅ Sozlamalar saqlandi", 1500);
});
$("delData").addEventListener("click", () => {
  const ask = "Barcha ballar, o'tilgan darslar, yutuqlar va lug'at o'chiriladi. Davom etasizmi?";
  const go = async (ok) => {
    if (!ok) return;
    try {
      await api("api/progress", { method: "DELETE" });
      for (const k of ["sado-favs", "sado-more", "sado-progress", "sado-flash", "sado-badges", "sado-maxwords"]) localStorage.removeItem(k);
      state.progress = null;
      state.favs = new Set();
      $("setSheet").hidden = true;
      await loadProgress();
      renderChips();
      renderLessons();
      toast("🗑 Ma'lumotlaringiz o'chirildi", 2500);
    } catch (e) {
      toast(e.message, 3000);
    }
  };
  if (inTelegram && tg.showConfirm) tg.showConfirm(ask, go);
  else go(confirm(ask));
});

$("setSheet").addEventListener("click", (e) => {
  if (e.target.id === "setSheet") $("setSheet").hidden = true;
});

$("freeHero").addEventListener("click", () => {
  const free = state.lessons.find((l) => l.liveOnly);
  if (!free) {
    state.pendingFree = true;
    return toast("⏳ Yuklanmoqda... bir soniya", 1500);
  }
  haptic("medium");
  if (state.liveEnabled) startLesson(free, "live");
  else openSheet(free);
});

function renderFavBtn(lesson) {
  const on = state.favs.has(lesson.id);
  $("favBtn").textContent = on ? "⭐ Sevimlilarda" : "☆ Sevimlilarga qo'shish";
  $("favBtn").classList.toggle("on", on);
  $("favBtn").hidden = Boolean(lesson.liveOnly);
}
$("favBtn").addEventListener("click", () => {
  const l = state.pendingLesson;
  if (!l) return;
  haptic("success");
  toggleFav(l.id);
  renderFavBtn(l);
  renderChips();
  renderLessons();
});

// 🎧 Tinglab takrorlash: har bir ibora 2 marta eshittiriladi, orada takrorlash uchun pauza
async function sayPhrase(en) {
  const key = (state.slow ? "slow:" : "") + en;
  let part = sayCache.get(key);
  if (!part) {
    part = await api(`api/say?text=${encodeURIComponent(en)}&slow=${state.slow ? 1 : 0}&session=${encodeURIComponent(state.session || "")}`, { method: "GET" }).catch(() => null);
    if (part?.audio) sayCache.set(key, part);
  }
  ensureCtx();
  if (part?.audio) await playMp3(part.audio, part.mime).catch(() => {});
  else await speakBrowser(en.replace(/\.\.\./g, "something"), "en");
}
function stopShadow() {
  state.shadowRun = (state.shadowRun || 0) + 1;
  $("shadow").hidden = true;
  $("shadowBtn").hidden = false;
  try { audio.source?.stop(); } catch {}
}
$("shadowBtn").addEventListener("click", async () => {
  const lesson = state.pendingLesson;
  if (!lesson) return;
  haptic();
  const run = (state.shadowRun = (state.shadowRun || 0) + 1);
  const box = $("shadow");
  $("shadowBtn").hidden = true;
  box.hidden = false;
  const list = lesson.phrases;
  // ⏭ Keyingisi: joriy iborani o'tkazib yuborish (kutishni darhol tugatadi)
  let skip = null;
  const wait = (ms) => new Promise((r) => {
    const t = setTimeout(r, ms);
    skip = () => { clearTimeout(t); r(); };
  });
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    let skipped = false;
    for (const round of [1, 2]) {
      if (run !== state.shadowRun || skipped) break;
      box.innerHTML = "";
      const stop = el("button", "shadow-stop", "■ To'xtatish");
      stop.addEventListener("click", stopShadow);
      const next = el("button", "shadow-stop", i < list.length - 1 ? "⏭ Keyingisi" : "⏭ Tugatish");
      next.addEventListener("click", () => {
        haptic();
        skipped = true;
        try { audio.source?.stop(); } catch {}
        skip?.();
      });
      const dots = el("div", "shadow-dots");
      list.forEach((_, j) => dots.append(el("i", j < i ? "done" : j === i ? "on" : "")));
      // 🐢/🐇 Tezlik: keyingi ijrodan boshlab sekin yoki oddiy
      const speed = el("button", "shadow-stop", state.slow ? "🐢 Sekin" : "🐇 Oddiy");
      speed.addEventListener("click", () => {
        haptic();
        state.slow = !state.slow;
        localStorage.setItem("sado-slow", state.slow ? "1" : "0");
        speed.textContent = state.slow ? "🐢 Sekin" : "🐇 Oddiy";
        if (typeof applySlow === "function") applySlow();
      });
      const btns = el("div", "shadow-btns");
      btns.append(stop, speed, next);
      box.append(dots, el("div", "shadow-en", p.en), el("div", "shadow-uz", p.uz));
      const st = el("div", "shadow-st", "🔊 Tinglang...");
      const bar = el("div", "shadow-bar");
      const fill = el("i", "");
      bar.append(fill);
      box.append(st, bar, btns);
      await sayPhrase(p.en);
      if (run !== state.shadowRun) return;
      if (skipped) break;
      st.textContent = round === 1 ? "🗣 Endi siz takrorlang!" : "🗣 Yana bir bor!";
      st.classList.add("go");
      // Takrorlash vaqti chiziq bilan ko'rsatiladi
      const ms = Math.max(2500, p.en.length * 110);
      bar.classList.add("run");
      fill.style.animationDuration = ms + "ms";
      await wait(ms);
    }
  }
  if (run !== state.shadowRun) return;
  box.innerHTML = "";
  box.append(el("div", "shadow-en", "🎉 Barakalla!"), el("div", "shadow-uz", "Endi shu iboralarni Sado bilan suhbatda ishlating 👇"));
  const again = el("button", "shadow-stop", "↻ Qaytadan");
  again.addEventListener("click", () => $("shadowBtn").click());
  box.append(again);
});

$("cancelBtn").addEventListener("click", () => { stopShadow(); $("startSheet").hidden = true; });
$("startSheet").addEventListener("click", (e) => {
  if (e.target.id === "startSheet") $("startSheet").hidden = true, stopShadow(); // ovoz yopilgan oynada davom etmasin
});
$("startLiveBtn").addEventListener("click", () => { stopShadow(); startLesson(state.pendingLesson, "live"); });
$("startTutorBtn").addEventListener("click", () => { stopShadow(); startLesson(state.pendingLesson, "tutor"); });
$("startChatBtn").addEventListener("click", () => { stopShadow(); startLesson(state.pendingLesson, "chat"); });
$("againBtn").addEventListener("click", () => startLesson(state.lesson, state.lessonMode));
$("homeBtn").addEventListener("click", () => show("home"));
$("nextBtn").addEventListener("click", () => {
  if (!state.nextAfter) return;
  show("home");
  openSheet(state.nextAfter);
});

// ---------------- Audio tayyorlash ----------------
function pickMime() {
  if (!window.MediaRecorder) return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

function ensureCtx() {
  if (!audio.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.outAnalyser = audio.ctx.createAnalyser();
    audio.outAnalyser.fftSize = 512;
    audio.outAnalyser.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
}

async function ensureAudio() {
  if (!audio.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.outAnalyser = audio.ctx.createAnalyser();
    audio.outAnalyser.fftSize = 512;
    audio.outAnalyser.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === "suspended") await audio.ctx.resume();

  if (!state.voiceEnabled || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    state.textOnly = true;
    return;
  }
  if (audio.stream && audio.stream.active) return;
  try {
    audio.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const src = audio.ctx.createMediaStreamSource(audio.stream);
    audio.micAnalyser = audio.ctx.createAnalyser();
    audio.micAnalyser.fftSize = 1024;
    src.connect(audio.micAnalyser);
    audio.mime = pickMime();
    state.textOnly = false;
  } catch (e) {
    console.warn("Mikrofon:", e);
    state.textOnly = true;
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") showMicHelp();
    else toast("Mikrofon topilmadi. Hozircha yozib javob bering.", 3500);
  }
}

// 🎙️ Mikrofon ruxsati bo'yicha yo'riqnoma
function showMicHelp(liveLesson) {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const steps = ios
    ? ["iPhone Sozlamalar (Settings) ni oching", "Pastga tushib Telegram ni tanlang", "Microphone (Mikrofon) ni yoqing", "Telegram'ga qaytib, «Qayta urinish» ni bosing"]
    : ["Telefon Sozlamalar → Ilovalar → Telegram ni oching", "Ruxsatlar (Permissions) → Mikrofon → «Ruxsat berish»", "Yoki: Telegram'da so'ralganda «Ruxsat berish» ni bosing", "Shu yerga qaytib, «Qayta urinish» ni bosing"];
  $("micSteps").innerHTML = "";
  for (const s of steps) $("micSteps").append(el("li", "", s));
  state.micRetryLesson = liveLesson || null;
  $("micSheet").hidden = false;
  haptic("error");
}
$("micRetry").addEventListener("click", async () => {
  $("micSheet").hidden = true;
  if (state.micRetryLesson) return startLesson(state.micRetryLesson, "live");
  await ensureAudio();
  applyMode();
  if (!state.textOnly && state.phase === "idle" && state.mode === "auto") listenAuto();
});
$("micText").addEventListener("click", () => {
  $("micSheet").hidden = true;
  if (state.micRetryLesson) return show("home");
  state.textOnly = true;
  applyMode();
});

function releaseMic() {
  audio.stream?.getTracks().forEach((t) => t.stop());
  audio.stream = null;
  audio.micAnalyser = null;
}

function rms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ---------------- Dars ----------------
async function startLesson(lesson, lessonMode = "tutor") {
  if (!lesson) return;
  if (lessonMode === "live") return startLive(lesson);
  state.lessonMode = lessonMode;
  resetLiveUi();
  $("startSheet").hidden = true;
  haptic("medium");
  stopAll();

  state.lesson = lesson;
  state.phraseIdx = 0;
  if (state.mode === "text") state.mode = localStorage.getItem("sado-mode") === "hold" ? "hold" : "auto";
  state.phraseIdx = 0;
  state.session = null;

  show("lesson");
  $("lessonTitle").textContent = lesson.title;
  resetWords();
  renderPhrase();
  renderVisual(lesson);
  $("lesson").classList.toggle("kids", lesson.category === "Bolalar uchun");
  renderLessonRule(lesson);
  renderStages(lesson);
  applyMode();
  applySubs();
  applyTr();
  applySlow();
  setSubs("", "", "", "");
  setPhase("thinking", "Tayyorlanmoqda...");
  $("hint").textContent = "";

  await ensureAudio();
  applyMode();

  try {
    const data = await api("api/session", {
      json: { lessonId: lesson.id, translate: state.tr, mode: state.lessonMode, slow: state.slow, level: localStorage.getItem("sado-level") || "" },
    });
    state.session = data.session;
    if (state.progress) state.progress.startedToday = (state.progress.startedToday || 0) + 1;
    if (Number.isInteger(data.current)) {
      state.phraseIdx = data.current;
      renderPhrase();
    }
    state.seconds = state.left = data.seconds;
    startTimer();
    setSubs(data.reply, data.reply_uz, "", "", data.say);
    await playReply(data.parts, data.reply);
    afterReply();
  } catch (e) {
    setPhase("idle", "");
    toast(e.message, 4000);
    show("home");
  }
}

// ---------------- 📞 Jonli suhbat ----------------
async function startLive(lesson) {
  $("startSheet").hidden = true;
  haptic("medium");
  stopAll();
  state.lessonMode = "live";
  state.lesson = lesson;
  state.used = new Set();
  state.phraseIdx = 0;
  state.session = null;

  show("lesson");
  $("lessonTitle").textContent = lesson.title + " · jonli";
  renderPhrase();
  renderVisual(lesson);
  $("lesson").classList.toggle("kids", lesson.category === "Bolalar uchun");
  renderLessonRule(lesson);
  renderStages(lesson);
  // Jonli rejimda tugmalar kerak emas: shunchaki gaplashiladi
  $("modeToggle").hidden = true;
  $("holdBtn").hidden = true;
  $("textForm").hidden = true;
  $("trBtn").hidden = true;
  $("slowBtn").hidden = true;
  $("subs").hidden = true; // jonli rejimda suhbat tarixi (chatlog) ko'rsatiladi
  $("listenBtn").hidden = true; // qo'ng'iroq paytida ibora ijrosi xalaqit beradi
  $("recallBtn").hidden = true;
  $("phraseCard").hidden = Boolean(lesson.liveOnly); // Erkin suhbatda ibora kartasi shart emas
  $("chatlog").hidden = false;
  $("chatlog").innerHTML = "";
  $("subsBtn").classList.add("on");
  $("muteBtn").hidden = false;
  $("hintBtn").hidden = false; // 💡 jonli suhbatda ham javob namunalari
  $("topicBtn").hidden = !lesson.liveOnly; // 🔀 erkin suhbatda mavzuni almashtirish
  $("lesson").classList.add("is-live");
  resetWords(true);
  $("replayBtn").hidden = true;
  clearHints();
  setMuteUi(false);
  setSubs("", "", "", "");
  setPhase("thinking", "Ulanmoqda...");
  $("hint").textContent = "Shunchaki gapiring. Sado gapini tugatgach javob bering 🙂";

  ensureCtx();
  let sadoLine = "";
  let userLine = "";
  let lastSpeaker = "";
  let connected = false;
  let lastErr = "";
  const quiet = { at: Date.now(), done: false, n: 0 };
  clearTimeout(state.liveWait);
  try {
    const data = await api("api/session", { json: { lessonId: lesson.id, mode: "live", level: localStorage.getItem("sado-level") || "" } });
    if (data.mode !== "live") throw new Error("Jonli suhbat serverda yoqilmagan.");
    state.session = data.session;
    if (state.progress) state.progress.startedToday = (state.progress.startedToday || 0) + 1;
    state.seconds = state.left = data.seconds;

    const call = new LiveCall({
      ctx: audio.ctx,
      outAnalyser: audio.outAnalyser,
      onState: (st, level) => {
        if (state.phase === "ended") return;
        const label = st === "speaking" ? "Sado gapirmoqda · ✋ to'xtatish" : st === "muted" ? "🔇 Mikrofon o'chiq" : st === "paused" ? "⏸ Ovoz to'xtadi — ekranga bosing" : "Sizni tinglayapti...";
        const phase = st === "muted" || st === "paused" ? "idle" : st;
        $("status").classList.toggle("paused", st === "paused");
        if (state.phase !== phase || $("statusText").textContent !== label) setPhase(phase, label);
        mascot.setLevel(level);
      },
      onEvent: (m) => {
        if (m.type === "turn" || m.type === "user") quiet.at = Date.now();
        if (m.type === "user") quiet.done = false;
        if (m.type === "ready") {
          connected = true;
          quiet.at = Date.now();
          clearTimeout(state.liveWait);
          startTimer();
          setPhase("speaking", "Sado gapirmoqda...");
        } else if (m.type === "sado" || m.type === "user") {
          // 🔀 Mavzu almashganda Sado yangi pufakchada boshlaydi
          if (lastSpeaker !== m.type || (m.type === "sado" && state.newTopicBubble)) addBubble(m.type);
          if (m.type === "sado") state.newTopicBubble = false;
          lastSpeaker = m.type;
          appendBubble(m.text);
          if (m.type === "sado") trackStage($("chatlog").lastElementChild?.textContent || "");
        } else if (m.type === "wrapup") {
          toast("⏳ 1 daqiqa qoldi — Sado suhbatni yakunlaydi", 4000);
          haptic("medium");
        } else if (m.type === "used") {
          markUsed(m.found || []);
        } else if (m.type === "error") {
          lastErr = m.message || "";
          toast("⚠️ " + m.message, 4000);
        } else if (m.type === "closed") {
          if (state.phase === "ended") return;
          // Suhbat umuman boshlanmagan bo'lsa — "Ajoyib suhbat" emas, ulanish xatosi ko'rsatiladi
          if (!connected) liveFailed(lastErr);
          else finish();
        }
      },
    });
    state.live = call;
    // ⏸ Telefon ovoz tizimini to'xtatsa (ruxsat oynasi, qo'ng'iroq, boshqa ilova) — istalgan bosish uni qayta yoqadi
    const wake = () => {
      if (state.live !== call || call.stopped) return unwake(); // suhbat tugagan — tinglovchilarni olib tashlaymiz
      if (audio.ctx?.state !== "running") audio.ctx.resume().catch(() => {});
    };
    const onVis = () => { if (!document.hidden) wake(); };
    const unwake = () => { document.removeEventListener("pointerdown", wake, true); document.removeEventListener("visibilitychange", onVis); };
    document.removeEventListener("pointerdown", state.liveWake || (() => {}), true); // oldingi suhbatniki
    document.removeEventListener("visibilitychange", state.liveVis || (() => {}));
    state.liveWake = wake;
    state.liveVis = onVis;
    document.addEventListener("pointerdown", wake, true);
    document.addEventListener("visibilitychange", onVis);
    // 🤫 O'quvchi 15 soniya jim qolsa — Sado o'zi yordam beradi (har jimlikda bir marta, jami 3 marta)
    clearInterval(state.quietTimer);
    state.quietTimer = setInterval(() => {
      if (state.live !== call || call.stopped) return clearInterval(state.quietTimer);
      // 📶 40 soniya serverdan hech narsa kelmasa — aloqa jimgina uzilgan: qotib turmay yakunlaymiz
      if (connected && Date.now() - (call.lastMsg || Date.now()) > 40_000) {
        clearInterval(state.quietTimer);
        toast("📶 Internet aloqasi uzildi — suhbat saqlandi", 4000);
        if (state.phase !== "ended") finish();
        return;
      }
      if (call.speaking()) quiet.at = Date.now(); // jimlik Sado ovozi tugagandan keyin sanaladi
      if (!connected || call.muted || call.speaking() || quiet.done || quiet.n >= 3) return;
      if (Date.now() - quiet.at > 15000 && call.nudge()) {
        quiet.done = true;
        quiet.n++;
        quiet.at = Date.now();
      }
    }, 2000);
    await call.start(data.session, tg?.initData || "", state.voice, lesson.liveOnly ? state.topic : "");
    // 20 soniyada ulanmasa — kutib qolmaymiz
    state.liveWait = setTimeout(() => {
      if (!connected && state.live === call && state.phase !== "ended") liveFailed("Sado javob bermadi (internet sekin bo'lishi mumkin).");
    }, 20000);
  } catch (e) {
    console.warn("Jonli:", e);
    state.live?.stop();
    state.live = null;
    setPhase("idle", "");
    if (e.name === "NotAllowedError") showMicHelp(lesson);
    else toast(e.message || "Jonli suhbatni boshlab bo'lmadi.", 4000);
    show("home");
  }
}

// 📵 Jonli suhbatga ulanib bo'lmadi: aniq xabar va qayta urinish
function liveFailed(msg) {
  clearTimeout(state.liveWait);
  state.phase = "ended";
  stopAll();
  releaseMic();
  state.session = null;
  showResult();
  $("resultTitle").textContent = "😕 Sado bilan ulanib bo'lmadi";
  const tip = state.lesson?.liveOnly
    ? "Internetni tekshirib, bir ozdan keyin qayta urinib ko'ring."
    : "Internetni tekshirib, qayta urinib ko'ring. Agar takrorlansa, darsni «🇬🇧 Inglizcha suhbat» yoki «🇺🇿 Ustoz» rejimida o'ting.";
  $("resultSub").textContent = (msg ? msg + " " : "") + tip;
  // Server ulanmagan suhbatni kunlik limitdan qaytaradi
  if (state.progress) state.progress.startedToday = Math.max(0, (state.progress.startedToday || 1) - 1);
  $("resultSub").append(el("div", "fail-note", "✅ Bu urinish kunlik limitdan hisoblanmadi."));
  $("resultList").hidden = true;
  $("nextBtn").hidden = true;
  $("againBtn").textContent = "🔄 Qayta urinish";
  mascot.setMood?.("surprised");
  haptic("error");
}

// 💡 Javob namunalari
// 🔁 Sado'ning oxirgi gapini qayta eshitish
$("replayBtn").addEventListener("click", async () => {
  if (!state.lastParts || state.phase === "thinking" || state.phase === "speaking") return;
  haptic();
  const wasListening = state.phase === "listening";
  if (wasListening) cancelRecording();
  await playReply(state.lastParts, "");
  afterReply();
});

$("topicBtn").addEventListener("click", () => {
  if (!state.live) return;
  haptic();
  if (state.live.newTopic()) {
    clearHints();
    state.newTopicBubble = true;
    toast("🔀 Sado yangi mavzu taklif qiladi...", 2200);
    // Ketma-ket bosilmasin
    $("topicBtn").disabled = true;
    setTimeout(() => ($("topicBtn").disabled = false), 6000);
  }
});
$("hintBtn").addEventListener("click", async () => {
  if (!state.session || state.hintBusy) return;
  state.hintBusy = true;
  haptic();
  const box = $("hintBox");
  box.hidden = false;
  box.innerHTML = '<div class="rep-loading"><span class="spin"></span>Sado namunalar tayyorlamoqda...</div>';
  try {
    const { hints } = await api(`api/hint?session=${encodeURIComponent(state.session)}`, { json: {} });
    box.innerHTML = "";
    // Jonli qo'ng'iroqda namunani ovoz bilan ijro etmaymiz — Sado uni o'quvchi gapi deb eshitib qoladi
    const live = Boolean(state.live);
    const typing = !live && !$("textForm").hidden;
    box.append(el("div", "hint-title", live ? "Shulardan birini ovoz chiqarib ayting:" : typing ? "Bosing — eshitasiz va javob maydoniga tushadi (o'zgartirib yuboring):" : "Shunday deyishingiz mumkin (bosing — eshitasiz):"));
    for (const h of hints || []) {
      const d = el("div", "hint-item");
      d.append(el("b", "", h.en), el("span", "", h.uz));
      if (!live)
        d.addEventListener("click", () => {
          haptic();
          // ✍️ Yozma rejimda namuna javob maydoniga qo'yiladi — o'quvchi uni o'ziga moslab yuboradi
          if (!$("textForm").hidden) {
            $("textInput").value = h.en;
            $("textInput").focus();
            for (const x of box.querySelectorAll(".hint-item")) x.classList.toggle("picked", x === d);
          }
          sayPhrase(h.en).then(() => mascot.setLevel(0));
        });
      box.append(d);
    }
    if (!hints?.length) box.append(el("div", "muted", "Hozircha namuna topilmadi."));
  } catch (e) {
    box.innerHTML = "";
    box.append(el("div", "muted", e.message));
  }
  state.hintBusy = false;
});
function clearHints() {
  $("hintBox").hidden = true;
  $("hintBox").innerHTML = "";
}

function resetLiveUi() {
  $("topicBtn").hidden = true;
  clearInterval(state.cueTimer);
  state.cueDone = false;
  $("cue").hidden = true;
  $("cue").classList.remove("speaking");
  $("cueReady").hidden = false;
  clearInterval(state.cueClock);
  $("cueClock").hidden = true;
  $("cueNotes").value = "";
  $("retryBtn").hidden = true;
  state.pendingTurn = null;
  state.ttsWarned = false;
  state.lastParts = null;
  $("replayBtn").hidden = true;
  $("hintBtn").hidden = false;
  clearHints();
  $("chatlog").hidden = true;
  $("muteBtn").hidden = true;
  $("listenBtn").hidden = false;
  $("recallBtn").hidden = false;
  $("phraseCard").hidden = false;
}

function setMuteUi(m) {
  $("muteBtn").classList.toggle("muted", m);
  // Qisqa yozuv — tor ekranda bir qatorga sig'adi
  $("muteBtn").textContent = m ? "🔇 Mikrofon o'chiq · yoqish" : "🎙️ Mikrofon yoniq · o'chirish";
}

$("muteBtn").addEventListener("click", () => {
  if (!state.live) return;
  haptic("medium");
  const m = !state.live.muted;
  state.live.setMuted(m);
  setMuteUi(m);
});

// 🇺🇿 Sado pufakchasini bosish — o'zbekcha tarjimasi ostida chiqadi (yana bosilsa yashiriladi)
async function translateBubble(b) {
  const old = b.querySelector(".b-tr");
  if (old) return void (old.hidden = !old.hidden);
  const text = b.querySelector("span").textContent.trim();
  if (!text || b.dataset.busy || !state.session) return;
  haptic();
  b.dataset.busy = "1";
  const tr = el("div", "b-tr", "⏳ Tarjima qilinmoqda...");
  b.append(tr);
  const r = await api("api/translate", { json: { session: state.session, text } }).catch((e) => ({ error: e.message }));
  delete b.dataset.busy;
  if (r?.uz) tr.textContent = "🇺🇿 " + r.uz;
  else tr.remove(), toast("⚠️ " + (r?.error || "Tarjima qilib bo'lmadi"), 2500);
}

// Jonli suhbat tarixi: Sado va o'quvchi gaplari pufakchalarda
function addBubble(who) {
  const log = $("chatlog");
  const b = el("div", "bubble " + (who === "sado" ? "b-sado" : "b-me"));
  b.append(el("small", "", who === "sado" ? "Sado" : "Siz"), el("span", "", ""));
  if (who === "sado") {
    b.querySelector("small").append(el("i", "b-tr-ico", " · 🇺🇿 tarjima"));
    b.addEventListener("click", () => translateBubble(b));
  }
  log.append(b);
  if (who !== "sado" && state.live) clearHints(); // o'quvchi javob berdi — namunalar yopiladi
  while (log.children.length > 40) log.firstChild.remove();
}
function appendBubble(text) {
  const log = $("chatlog");
  const last = log.lastElementChild;
  if (!last) return;
  // Pastda turgan bo'lsa — kuzatib boramiz; yuqoriga surib o'qiyotgan bo'lsa — sakratmaymiz
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  last.lastElementChild.textContent += text;
  // 🗣 Jonli hisoblagich: o'quvchi aytgan inglizcha so'zlar
  if (last.classList.contains("b-me")) {
    const n = [...log.querySelectorAll(".b-me span")].reduce((k, x) => k + (x.textContent.match(/[A-Za-z]+/g) || []).length, 0);
    setWords(n);
  }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// 🗣 Aytilgan inglizcha so'zlar hisoblagichi (barcha rejimlarda)
function setWords(n) {
  const w = $("wordsLive");
  if (n === Number(w.dataset.n || 0)) return;
  w.dataset.n = n;
  w.textContent = `🗣 ${n} so'z`;
  w.classList.remove("bump");
  void w.offsetWidth;
  w.classList.add("bump");
  // Oddiy rejimlarda sarlavha tor — hisob ibora kartasidagi qatorda ko'rinadi
  $("countWords").textContent = `· 🗣 ${n} so'z`;
  $("countWords").hidden = !$("wordsLive").hidden || n === 0;
}
function resetWords(live = false) {
  $("countWords").hidden = true;
  $("wordsLive").hidden = !live;
  $("wordsLive").dataset.n = "0";
  $("wordsLive").textContent = "🗣 0 so'z";
}

function startTimer() {
  clearInterval(state.timer);
  renderTimer();
  state.timer = setInterval(() => {
    state.left -= 1;
    renderTimer();
    if (state.left <= 0) {
      clearInterval(state.timer);
      toast("Vaqt tugadi!");
      finish();
    }
  }, 1000);
}

function renderTimer() {
  const l = Math.max(0, state.left);
  $("timerText").textContent = `${Math.floor(l / 60)}:${String(l % 60).padStart(2, "0")}`;
  const frac = state.seconds ? l / state.seconds : 1;
  $("timerRing").style.strokeDashoffset = String(50.27 * (1 - frac));
  $("timer").classList.toggle("low", l <= 60);
  // ⏳ 1 daqiqa qolganda ogohlantiramiz (jonli suhbatda Sado o'zi yakunlaydi)
  if (l === 60 && state.lessonMode !== "live" && state.seconds > 120) {
    const left = state.lesson ? state.lesson.phrases.length - state.used.size : 0;
    haptic("medium");
    toast(left > 0 ? `⏳ 1 daqiqa qoldi — yana ${left} ta ibora ishlatib ulgurasizmi?` : "⏳ 1 daqiqa qoldi — barcha iboralar bajarildi, zo'r! 🎉", 4000);
  }
}

function renderPhrase() {
  const { lesson, used } = state;
  $("phraseUz").classList.remove("shown"); // yangi ibora — tarjima yana yashirin
  $("phraseEn").classList.remove("shown");
  const seg = $("segments");
  seg.innerHTML = "";
  lesson.phrases.forEach((_, i) => {
    const el = document.createElement("i");
    if (used.has(i)) el.className = "done";
    else if (i === state.phraseIdx) el.className = "current";
    seg.appendChild(el);
  });
  $("countText").textContent = lesson.category === "Bolalar uchun"
    ? "⭐".repeat(used.size) + "☆".repeat(Math.max(0, lesson.phrases.length - used.size))
    : `${lesson.phrases.length} tadan ${used.size} ta ibora`;
  const p = lesson.phrases[state.phraseIdx];
  $("phraseEn").textContent = p.en.replace(/ (\.\.\.)/g, "\u00a0$1"); // "..." yolg'iz keyingi qatorga tushmasin
  $("phraseUz").textContent = p.uz;
  $("phrasePic").hidden = !p.pic;
  $("phrasePic").textContent = p.pic || "";
  // Bolalar uchun «Yoddan» murakkab — yashiramiz
  $("recallBtn").hidden = lesson.category === "Bolalar uchun" || state.lessonMode === "live";
  $("phraseCard").classList.toggle("recall", localStorage.getItem("sado-recall") === "1" && lesson.category !== "Bolalar uchun");
  const done = used.has(state.phraseIdx);
  $("phraseCard").classList.toggle("done", done);
  $("phraseLabel").textContent = done ? "✓ Aytildi" : $("phraseCard").classList.contains("recall") ? "🙈 Eslab ayting — tekshirish uchun bosing" : "Ovoz chiqarib ayting";
}

// 🟢🔴 So'zma-so'z: joriy iboradagi qaysi so'zlarni aytdi
const wnorm = (w) => w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z']/g, "");
function markWords(heard) {
  const p = state.lesson?.phrases?.[state.phraseIdx];
  if (!p || !heard) return;
  const said = new Set(String(heard).split(/\s+/).map(wnorm).filter(Boolean));
  const words = p.en.split(/\s+/);
  const real = words.filter((w) => wnorm(w));
  const hits = real.filter((w) => said.has(wnorm(w))).length;
  if (!real.length || hits === 0) return; // umuman boshqa gap aytgan bo'lsa belgilamaymiz
  const box = $("phraseEn");
  box.innerHTML = "";
  words.forEach((w, i) => {
    const n = wnorm(w);
    box.append(n ? el("span", said.has(n) ? "w-ok" : "w-miss", w) : document.createTextNode(w));
    if (i < words.length - 1) box.append(document.createTextNode(" "));
  });
  $("phraseLabel").textContent = hits === real.length ? "✓ Hamma so'zlar aytildi" : `${hits}/${real.length} so'z aytildi — qizillarini qo'shing`;
}

// 🙈 Yoddan: inglizcha ibora xiralashadi — o'quvchi o'zbekchasidan eslab aytadi, keyin bosib tekshiradi
function applyRecall() {
  const on = localStorage.getItem("sado-recall") === "1";
  $("phraseCard").classList.toggle("recall", on);
  $("recallBtn").classList.toggle("on", on);
  $("recallBtn").setAttribute("aria-pressed", String(on));
}
applyRecall();
$("recallBtn").addEventListener("click", () => {
  haptic();
  const on = localStorage.getItem("sado-recall") !== "1";
  localStorage.setItem("sado-recall", on ? "1" : "0");
  $("phraseEn").classList.remove("shown");
  applyRecall();
  if (state.lesson) renderPhrase();
  toast(on ? "🙈 Inglizchasi yashirildi — o'zbekchasidan eslab ayting, tekshirish uchun bosing" : "👀 Inglizchasi yana ko'rinadi", 2600);
});

// ✍️ Yozma rejimda iborani bosish — uni javob maydoniga qo'yadi
$("phraseEn").addEventListener("click", () => {
  if ($("phraseCard").classList.contains("recall") && !$("phraseEn").classList.contains("shown") && !$("phraseCard").classList.contains("done")) {
    haptic();
    return $("phraseEn").classList.add("shown");
  }
  if ($("textForm").hidden || !state.lesson) return;
  const p = state.lesson.phrases[state.phraseIdx];
  if (!p) return;
  haptic();
  const inp = $("textInput");
  inp.value = inp.value.trim() ? `${inp.value.trim()} ${p.en}` : p.en;
  inp.focus();
});

// 🙈 Tarjimani yashirish: o'quvchi avval o'zi eslaydi, keyin bosib tekshiradi
function applyHideUz() {
  $("phraseCard").classList.toggle("hide-uz", localStorage.getItem("sado-hideuz") === "1");
  $("phraseUz").classList.remove("shown");
}
applyHideUz();
$("phraseUz").addEventListener("click", (e) => {
  if (!$("phraseCard").classList.contains("hide-uz")) return;
  e.stopPropagation();
  haptic();
  $("phraseUz").classList.toggle("shown");
});

function nextUnused(from = 0) {
  const n = state.lesson.phrases.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (!state.used.has(i)) return i;
  }
  return state.phraseIdx;
}

// 🔊 Iborani to'g'ri talaffuzda eshitish (mikrofon vaqtincha to'xtaydi)
const sayCache = new Map();
// 🔊 Sozlamalarda ovozni sinash: Sado ovozi telefonda eshitilyaptimi?
$("soundTest").addEventListener("click", async () => {
  if (state.soundBusy) return;
  state.soundBusy = true;
  haptic();
  const btn = $("soundTest");
  const ask = $("soundAsk");
  ask.hidden = true;
  btn.textContent = "⏳ Sado gapirmoqda...";
  const lesson = state.lessons.find((l) => !l.liveOnly && l.phrases?.some((p) => !p.en.includes("...")));
  const text = lesson?.phrases.find((p) => !p.en.includes("..."))?.en || "Hello!";
  try {
    ensureCtx();
    const part = state.voiceEnabled
      ? await api(`api/say?text=${encodeURIComponent(text)}&slow=${state.slow ? 1 : 0}`, { method: "GET" }).catch(() => null)
      : null;
    if (part?.audio) await playMp3(part.audio, part.mime);
    else await speakBrowser(text, "en");
  } catch {}
  mascot.setLevel(0);
  btn.textContent = "🔊 Yana bir marta tekshirish";
  state.soundBusy = false;
  ask.innerHTML = "";
  const yes = el("button", "chip-f", "✅ Eshitdim");
  const no = el("button", "chip-f", "❌ Eshitilmadi");
  yes.addEventListener("click", () => {
    ask.hidden = true;
    toast("👍 Ajoyib, ovoz ishlayapti!");
  });
  no.addEventListener("click", () => {
    ask.innerHTML = "";
    const ol = el("ol", "sound-tips");
    for (const t of [
      "Telefon ovozini baland qiling (yon tugma).",
      "iPhone'da chap yondagi «ovozsiz» tugmasini o'chiring.",
      "Bluetooth quloqchin ulangan bo'lsa, tekshiring.",
      "Telegram'ni yangilang va ilovani yopib qayta oching.",
      "Baribir eshitilmasa: darsda «Subtitrlar»ni yoqib, matndan o'qing.",
    ])
      ol.append(el("li", "", t));
    ask.append(ol);
  });
  ask.append(el("span", "", "Sado ovozini eshitdingizmi?"), yes, no);
  ask.hidden = false;
});

// 🐣 Maskotni bosish — Sado oxirgi gapini qayta aytadi (jonli suhbatdan tashqari)
$("mascot").addEventListener("click", () => {
  // ✋ Jonli suhbatda: Sado gapirayotganda bosilsa — to'xtaydi, o'quvchi gapiradi
  if (state.live?.interrupt?.()) {
    haptic("medium");
    toast("✋ Sado to'xtadi — gapiring 🎙️", 1800);
    return;
  }
  if (state.lessonMode === "live" || $("replayBtn").hidden) return;
  $("replayBtn").click();
});
// Holat yozuvini bosish ham Sado'ni to'xtatadi (yozuvda shunday deyilgan)
$("status").addEventListener("click", () => { if (state.live?.speaking?.()) $("mascot").click(); });

$("myVoiceBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.myVoiceUrl || state.phase === "speaking") return;
  haptic();
  const wasListening = state.phase === "listening";
  if (wasListening) cancelRecording();
  const a = new Audio(state.myVoiceUrl);
  $("myVoiceBtn").classList.add("busy");
  const done = () => {
    $("myVoiceBtn").classList.remove("busy");
    if (wasListening && state.phase === "listening" && state.mode === "auto") listenAuto();
  };
  a.onended = done;
  a.onerror = done;
  a.play().catch(() => {
    done();
    toast("Yozuvni ijro etib bo'lmadi");
  });
});

$("listenBtn").addEventListener("click", async () => {
  if (state.phase === "thinking" || state.phase === "speaking" || state.listenBusy) return;
  const p = state.lesson.phrases[state.phraseIdx];
  state.listenBusy = true;
  $("listenBtn").classList.add("busy");
  haptic();
  const wasListening = state.phase === "listening";
  if (wasListening) cancelRecording();
  try {
    ensureCtx();
    const key = (state.slow ? "slow:" : "") + p.en;
    let part = sayCache.get(key);
    if (!part) {
      part = await api(`api/say?text=${encodeURIComponent(p.en)}&slow=${state.slow ? 1 : 0}`, { method: "GET" }).catch(() => null);
      if (part?.audio) sayCache.set(key, part);
    }
    if (part?.audio) await playMp3(part.audio, part.mime);
    else await speakBrowser(p.en.replace(/\.\.\./g, "something"), "en");
  } catch {}
  mascot.setLevel(0);
  state.listenBusy = false;
  $("listenBtn").classList.remove("busy");
  if (wasListening && state.phase === "listening" && state.mode === "auto") listenAuto();
});

// 👆 Ibora kartasini barmoq bilan surish: chapga — keyingi, o'ngga — oldingi
(() => {
  const card = $("phraseCard");
  let x0 = null, y0 = 0;
  card.addEventListener("touchstart", (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  card.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
    const btn = $(dx < 0 ? "nextPhrase" : "prevPhrase");
    if (btn.hidden || btn.disabled) return;
    card.classList.remove("swipe-l", "swipe-r");
    void card.offsetWidth;
    card.classList.add(dx < 0 ? "swipe-l" : "swipe-r");
    btn.click();
  }, { passive: true });
})();

// Strelka bosilganda (sensorli ekranda) bir marta surish mumkinligini eslatamiz
for (const id of ["prevPhrase", "nextPhrase"])
  $(id).addEventListener("click", (e) => {
    if (!e.isTrusted || !("ontouchstart" in window) || localStorage.getItem("sado-swipe-tip")) return;
    localStorage.setItem("sado-swipe-tip", "1");
    toast("👆 Maslahat: iborani barmoq bilan surib ham almashtirish mumkin", 3000);
  });

$("prevPhrase").addEventListener("click", () => {
  const n = state.lesson.phrases.length;
  state.phraseIdx = (state.phraseIdx - 1 + n) % n;
  renderPhrase();
});
$("nextPhrase").addEventListener("click", () => {
  state.phraseIdx = (state.phraseIdx + 1) % state.lesson.phrases.length;
  renderPhrase();
});

function setPhase(phase, text) {
  state.phase = phase;
  mascot.setState(phase === "ended" ? "idle" : phase);
  const st = $("status");
  st.dataset.s = phase;
  const labels = {
    listening: "Eshitmoqda...",
    thinking: "Sado o'ylamoqda...",
    speaking: "Sado gapirmoqda...",
    idle: state.mode === "hold" ? "Tugmani bosib gapiring" : "",
  };
  $("statusText").textContent = text ?? labels[phase] ?? "";
  updateHoldBtn();
}

function setSubs(ai, aiUz, me, fix, say) {
  $("subAi").textContent = ai || "";
  // 🇺🇿 Ustoz rejimi: o'zbekcha tushuntirish ichidagi inglizcha qismlar ajratib ko'rsatiladi, bosilsa eshittiriladi
  if (Array.isArray(say) && say.some((x) => x.lang === "en")) {
    $("subAi").textContent = "";
    say.forEach((x, i) => {
      if (i) $("subAi").append(" ");
      if (x.lang !== "en") return $("subAi").append(x.text);
      const b = el("button", "sub-en" + (x.wrong ? " wrong" : ""), x.text); // xato variant — qizil, ustidan chizilgan
      b.addEventListener("click", () => {
        haptic();
        sayPhrase(x.text).then(() => mascot.setLevel(0));
      });
      $("subAi").append(b);
    });
  }
  $("subAiUz").textContent = aiUz || "";
  $("subMe").textContent = me || "";
  $("subMeWrap").hidden = !me;
  // ▶️ Ovozli javobdan keyin — o'z talaffuzini eshitish tugmasi
  $("myVoiceBtn").hidden = !(me && state.myVoicePending && state.myVoiceUrl);
  $("subFix").textContent = fix || "";
  $("subFixWrap").hidden = !fix;
  keepSubsVisible();
}

// 👀 Sado gapi pastki tugmalar ortida qolmasin — ko'rinadigan joyga suriladi
// (maskot kichrayish animatsiyasi 0.3 s tugagach o'lchaymiz)
function keepSubsVisible() {
  clearTimeout(state.subsScroll);
  state.subsScroll = setTimeout(() => {
    const sb = $("subs");
    if (sb.hidden || !$("lesson").classList.contains("active") || !($("subAi").textContent || $("subMe").textContent)) return;
    if (!$("cue").hidden && !$("cueReady").hidden) return; // Part 2 tayyorlanishida kartochka (mavzu, taymer) ko'rinib tursin
    const r = sb.getBoundingClientRect(), ctl = $("controls").getBoundingClientRect().top;
    let dy = Math.min(r.bottom - ctl + 16, r.top - 70);
    // 🖼 Topshiriq materiali (CEFR rasmlari, jadval, savollar) yuqoridan chiqib ketmasin
    const task = $("visual");
    if (!task.hidden && task.offsetHeight && !task.querySelector(":scope > details")) dy = Math.min(dy, task.getBoundingClientRect().top - 70);
    if (r.bottom > ctl - 8 && dy > 0) window.scrollBy({ top: dy, behavior: "smooth" });
  }, 380);
}

// ---------------- Rejimlar ----------------
function applyMode() {
  for (const b of document.querySelectorAll(".mode")) b.classList.toggle("active", b.dataset.mode === state.mode);
  // ✍️ "Yozish" — mikrofon bor bo'lsa ham vaqtincha yozib javob berish (masalan, jamoat joyida)
  const text = state.textOnly || state.mode === "text";
  $("modeToggle").hidden = state.textOnly;
  $("textForm").hidden = !text;
  $("phraseCard").classList.toggle("can-insert", text);
  applySubs();
  $("holdBtn").hidden = text || state.mode !== "hold";
  if (state.lessonMode === "tutor" && !text) return applyHint();
  $("hint").textContent = text
    ? "Javobingizni inglizcha yozing."
    : state.mode === "hold"
      ? "Tugmani bosib turing, gapiring va qo'yib yuboring."
      : "Shunchaki gapiring — Sado tinglayapti.";
}

$("modeToggle").addEventListener("click", (e) => {
  const b = e.target.closest(".mode");
  if (!b || b.dataset.mode === state.mode) return;
  haptic();
  state.mode = b.dataset.mode;
  if (state.mode !== "text") localStorage.setItem("sado-mode", state.mode); // yozish rejimi faqat shu dars uchun
  applyMode();
  if (state.mode === "text") {
    if (state.phase === "listening") cancelRecording();
    if (state.phase === "listening" || state.phase === "idle") setPhase("idle");
    setTimeout(() => $("textInput").focus(), 50);
  } else if (state.phase === "listening" && state.mode === "hold") {
    cancelRecording();
    setPhase("idle");
  } else if (state.phase === "idle" && state.mode === "auto" && state.session) {
    listenAuto();
  }
});

function applySlow() {
  $("slowBtn").hidden = state.lessonMode === "live";
  $("slowBtn").classList.toggle("on", state.slow);
  $("slowBtn").textContent = state.slow ? "🐢" : "🐇";
  $("slowBtn").title = state.slow ? "Sekin gapirish" : "Oddiy tezlik";
}
$("slowBtn").addEventListener("click", () => {
  haptic();
  state.slow = !state.slow;
  localStorage.setItem("sado-slow", state.slow ? "1" : "0");
  applySlow();
  toast(state.slow ? "🐢 Sado endi sekinroq va aniqroq gapiradi" : "🐇 Sado odatdagi tezlikda gapiradi", 2500);
});

function applyTr() {
  $("trBtn").hidden = state.lessonMode === "tutor"; // ustoz rejimida Sado o'zi o'zbekcha gapiradi
  $("trBtn").classList.toggle("on", state.tr);
  // Matn qismi alohida — tor ekranda faqat belgi qoladi (sarlavha sig'ishi uchun)
  $("trBtn").innerHTML = "";
  $("trBtn").append("🇺🇿", el("span", "chip-txt", state.tr ? " Tarjima ✓" : " Tarjima"));
  $("trBtn").title = "O'zbekcha tarjima";
}
$("trBtn").addEventListener("click", () => {
  haptic();
  state.tr = !state.tr;
  localStorage.setItem("sado-tr", state.tr ? "1" : "0");
  applyTr();
  toast(state.tr ? "Sado gaplarining o'zbekcha tarjimasini ham aytadi" : "Sado faqat inglizcha gapiradi (xatolar baribir o'zbekcha tushuntiriladi)", 3000);
});

// Yozma rejimda yoki ovoz ijro etilmasa subtitr majburan ko'rsatiladi — aks holda Sado gapi umuman ko'rinmay qoladi
function applySubs() {
  const on = state.subs || state.textOnly || state.audioFail;
  $("subs").hidden = !on;
  $("subsBtn").classList.toggle("on", on);
  if (on) keepSubsVisible();
}
$("subsBtn").addEventListener("click", () => {
  haptic();
  if (state.lessonMode === "live") {
    // Jonli rejimda "Subtitrlar" suhbat tarixini yashiradi/ko'rsatadi
    $("chatlog").hidden = !$("chatlog").hidden;
    $("subsBtn").classList.toggle("on", !$("chatlog").hidden);
    return;
  }
  state.subs = !state.subs;
  localStorage.setItem("sado-subs", state.subs ? "1" : "0");
  applySubs();
});

$("endBtn").addEventListener("click", () => {
  haptic("medium");
  confirmEnd();
});

// ---------------- Yozib olish ----------------
function startRecorder() {
  audio.chunks = [];
  const rec = new MediaRecorder(audio.stream, audio.mime ? { mimeType: audio.mime } : undefined);
  rec.ondataavailable = (e) => e.data.size && audio.chunks.push(e.data);
  rec.start();
  audio.recorder = rec;
  return rec;
}

function stopRecorder() {
  return new Promise((resolve) => {
    const rec = audio.recorder;
    if (!rec || rec.state === "inactive") return resolve(null);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      const type = rec.mimeType || audio.mime || "audio/webm";
      resolve(audio.chunks?.length ? new Blob(audio.chunks, { type }) : null);
    };
    rec.onstop = finish;
    // ⏱ Ba'zi Android WebView'larda "onstop" kelmay qoladi — 2 s dan keyin borini yuboramiz (aks holda qotib qolardi)
    const guard = setTimeout(finish, 2000);
    try { rec.stop(); } catch { finish(); }
    audio.recorder = null;
  });
}

function cancelRecording() {
  cancelAnimationFrame(audio.vadRaf);
  const rec = audio.recorder;
  audio.recorder = null;
  if (rec && rec.state !== "inactive") {
    rec.onstop = null;
    rec.stop();
  }
  mascot.setLevel(0);
}

// "Bosmasdan gapirish": ovoz faolligini aniqlash (VAD)
function listenAuto() {
  if (state.textOnly || !audio.micAnalyser || state.phase === "ended") return setPhase("idle");
  cancelRecording();
  setPhase("listening");
  startRecorder();

  const buf = new Float32Array(audio.micAnalyser.fftSize);
  const t0 = performance.now();
  let floor = 0.01, calibrated = false;
  let speechMs = 0, silenceMs = 0, heard = false, last = t0, started = t0;

  const tick = (now) => {
    if (state.phase !== "listening" || state.mode !== "auto") return;
    const dt = now - last;
    last = now;
    const v = rms(audio.micAnalyser, buf);

    if (!calibrated) {
      floor = floor * 0.8 + v * 0.2;
      if (now - t0 > 350) calibrated = true;
    }
    const thr = Math.max(0.018, floor * 2.8);
    mascot.setLevel(Math.min(1, v * 9));

    if (v > thr) {
      speechMs += dt;
      silenceMs = 0;
      if (speechMs > 180) heard = true;
    } else {
      silenceMs += dt;
      if (!heard) speechMs = Math.max(0, speechMs - dt);
      else floor = floor * 0.98 + v * 0.02;
    }

    const long = now - started;
    if (heard && (silenceMs > 1300 || long > 25000)) {
      cancelAnimationFrame(audio.vadRaf);
      stopRecorder().then((blob) => sendAudio(blob));
      return;
    }
    if (!heard && long > 15000) {
      // Uzoq jimlik: yozuvni tashlab, qayta boshlaymiz (fayl kattalashmasin)
      cancelRecording();
      return listenAuto();
    }
    audio.vadRaf = requestAnimationFrame(tick);
  };
  audio.vadRaf = requestAnimationFrame(tick);
}

// "Bosib gapirish"
function updateHoldBtn() {
  const b = $("holdBtn");
  const busy = state.phase === "thinking" || state.phase === "speaking";
  b.disabled = busy || !state.session;
  b.querySelector("span").textContent = state.phase === "listening" ? "Qo'yib yuboring — yuboriladi" : "Bosib turing va gapiring";
}

let holdStart = 0;
let holdLevelRaf = 0;
$("holdBtn").addEventListener("pointerdown", (e) => {
  if (state.mode !== "hold" || $("holdBtn").disabled || !audio.stream) return;
  e.preventDefault();
  $("holdBtn").setPointerCapture?.(e.pointerId);
  $("holdBtn").classList.add("pressed");
  haptic("medium");
  holdStart = performance.now();
  setPhase("listening");
  startRecorder();
  const buf = new Float32Array(audio.micAnalyser.fftSize);
  const label = $("holdBtn").querySelector("span");
  let lastSec = -1;
  const meter = () => {
    if (state.phase !== "listening") return;
    mascot.setLevel(Math.min(1, rms(audio.micAnalyser, buf) * 9));
    // 🔴 Yozib olish taymeri (25 soniyadan keyin avtomatik yuboriladi)
    const sec = Math.floor((performance.now() - holdStart) / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      label.textContent = `🔴 0:${String(sec).padStart(2, "0")} — qo'yib yuboring`;
      if (sec >= 25) return holdEnd();
    }
    holdLevelRaf = requestAnimationFrame(meter);
  };
  meter();
});

async function holdEnd() {
  if (!$("holdBtn").classList.contains("pressed")) return;
  $("holdBtn").classList.remove("pressed");
  cancelAnimationFrame(holdLevelRaf);
  if (state.phase !== "listening") return;
  const blob = await stopRecorder();
  if (performance.now() - holdStart < 500) {
    setPhase("idle");
    toast("Tugmani gapirib bo'lguncha bosib turing.");
    return;
  }
  sendAudio(blob);
}
$("holdBtn").addEventListener("pointerup", holdEnd);
$("holdBtn").addEventListener("pointercancel", holdEnd);
$("holdBtn").addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------- Serverga yuborish ----------------
async function sendAudio(blob) {
  mascot.setLevel(0);
  if (!blob || blob.size < 1500) {
    $("hint").textContent = "Eshitmadim, yana bir bor ayting.";
    return afterReply();
  }
  // ▶️ O'z ovozini qayta eshitish uchun oxirgi yozuvni saqlab qo'yamiz
  if (state.myVoiceUrl) URL.revokeObjectURL(state.myVoiceUrl);
  state.myVoiceUrl = URL.createObjectURL(blob);
  state.myVoicePending = true;
  await sendTurn({ body: blob, headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" } });
}

$("textForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("textInput").value.trim();
  if (!text || state.phase === "thinking" || state.phase === "speaking") return;
  $("textInput").value = "";
  state.myVoicePending = false;
  await sendTurn({ json: { text } });
});

// Internet uzilsa oxirgi gapni saqlab qo'yamiz va qayta yuborish tugmasini ko'rsatamiz
$("retryBtn").addEventListener("click", () => {
  const p = state.pendingTurn;
  if (!p || state.phase === "thinking" || state.phase === "speaking") return;
  haptic("medium");
  $("retryBtn").hidden = true;
  sendTurn(p);
});

async function sendTurn(payload) {
  if (!state.session) return;
  clearHints();
  $("retryBtn").hidden = true;
  state.pendingTurn = null;
  setPhase("thinking");
  try {
    const data = await api(
      `api/turn?session=${encodeURIComponent(state.session)}&tr=${state.tr ? 1 : 0}&slow=${state.slow ? 1 : 0}`,
      payload,
    );
    if (state.phase === "ended") return;
    if (data.empty) {
      $("hint").textContent = "Eshitmadim, yana bir bor ayting.";
      return afterReply();
    }
    applyHint();
    const tutorCurrent = Number.isInteger(data.current) ? data.current : null;
    setSubs(data.reply, data.reply_uz, data.heard, data.uz_say, data.say);
    trackStage(data.reply);
    markWords(data.heard);
    setWords(Number($("wordsLive").dataset.n || 0) + (String(data.heard || "").match(/[A-Za-z]+/g) || []).length);
    if (data.uz_say && !state.subs) toast("🇺🇿 " + data.uz_say, 6000);
    markUsed(data.used || []);
    if (tutorCurrent !== null && tutorCurrent !== state.phraseIdx) {
      state.phraseIdx = tutorCurrent;
      renderPhrase();
    }
    if (data.mood) mascot.setMood(data.mood);
    await playReply(data.parts, data.reply);
    afterReply();
  } catch (e) {
    if (state.phase === "ended") return;
    if (e.network || e.status >= 500 || e.status === 429) {
      state.pendingTurn = payload;
      $("retryBtn").hidden = false;
      toast(`${e.message} — gapingiz saqlandi, "Qayta yuborish" ni bosing`, 4000);
      if (e.status !== 429) return setPhase("idle", "📶 Aloqa uzildi");
    } else toast(e.message, 3500);
    if (e.status === 404 || e.status === 410) return finish();
    afterReply();
  }
}

function applyHint() {
  if (state.lessonMode === "tutor" && !state.textOnly && state.mode !== "text") {
    $("hint").textContent = "Sado aytgan iborani takrorlang yoki o'zbekcha so'rang.";
    return;
  }
  $("hint").textContent = state.textOnly || state.mode === "text"
    ? "Javobingizni inglizcha yozing."
    : state.mode === "hold"
      ? "Tugmani bosib turing, gapiring va qo'yib yuboring."
      : "Shunchaki gapiring — Sado tinglayapti.";
}

function markUsed(list) {
  const before = state.used.size;
  for (const i of list) state.used.add(i);
  if (state.used.size > before) {
    haptic("success");
    mascot.setMood("happy");
    state.phraseIdx = nextUnused(state.phraseIdx);
    renderPhrase();
    const card = $("phraseCard");
    card.classList.remove("pop");
    void card.offsetWidth;
    card.classList.add("pop");
    if (state.lesson.category === "Bolalar uchun") kidStar();
    else toast(`✅ Ibora qabul qilindi! (${state.used.size}/${state.lesson.phrases.length})`);
  }
}

// 📝 IELTS Part 2: 1 daqiqa tayyorlanish (mikrofon shu vaqtda yoqilmaydi)
function startCuePrep() {
  const c = state.lesson?.cue;
  if (!c || state.cueDone) return false;
  state.cueDone = true;
  $("cue").hidden = false;
  $("cueNotes").hidden = false;
  $("cueNotes").readOnly = false;
  $("cueTitle").textContent = c.title;
  const ul = $("cuePoints");
  ul.innerHTML = "";
  // ✅ Bandni bosib belgilash — gapirayotganda qaysi bandlarga to'xtalganini kuzatish
  for (const p of c.points) {
    const li = el("li", "", p);
    li.addEventListener("click", () => {
      haptic();
      li.classList.toggle("done");
      const n = ul.querySelectorAll(".done").length;
      $("cueSay").textContent = n ? `You should say: ✅ ${n}/${c.points.length}` : "You should say:";
      if (n === c.points.length) toast("🎉 Hamma bandlarga to'xtaldingiz — endi xulosa qiling", 2500);
    });
    ul.append(li);
  }
  $("cueSay").textContent = "You should say:";
  let left = 60;
  $("cueTimer").textContent = "1:00";
  setPhase("idle", "⏳ Tayyorlanish vaqti");
  $("hint").textContent = "Kartochkani o'qing va reja tuzing. Tayyor bo'lsangiz — «🎤 Tayyorman» ni bosing.";
  // 📋 Reja andozasi: kartochka bandlari qaydlar maydoniga qo'yiladi — har biriga 2-3 kalit so'z yoziladi
  if (!$("cueTpl")) {
    const tb = el("button", "cue-tpl", "📋 Reja andozasi");
    tb.id = "cueTpl";
    tb.addEventListener("click", () => {
      haptic();
      const pts = [...$("cuePoints").querySelectorAll("li")].map((x) => x.textContent.replace(/^[✅\s]+/, "").trim());
      const n = $("cueNotes");
      if (n.value.trim() && !confirm("Qaydlaringiz andoza bilan almashtirilsinmi?")) return;
      n.value = pts.map((t, i) => `${i + 1}. ${t} — `).join("\n");
      n.rows = Math.max(3, pts.length);
      n.focus();
      n.setSelectionRange(n.value.indexOf("\n") > 0 ? n.value.indexOf("\n") : n.value.length, n.value.indexOf("\n") > 0 ? n.value.indexOf("\n") : n.value.length);
    });
    $("cueNotes").before(tb);
  }
  clearInterval(state.cueTimer);
  state.cueTimer = setInterval(() => {
    left -= 1;
    $("cueTimer").textContent = `0:${String(Math.max(0, left)).padStart(2, "0")}`;
    if (left <= 10) $("cueTimer").classList.add("low");
    if (left <= 0) endCuePrep();
  }, 1000);
  return true;
}
function endCuePrep() {
  clearInterval(state.cueTimer);
  $("cueTimer").classList.remove("low");
  $("cue").classList.add("speaking");
  $("cueReady").hidden = true;
  $("cueNotes").readOnly = true;
  $("cueNotes").hidden = !$("cueNotes").value.trim(); // qayd yozilmagan bo'lsa joy egallamasin
  // ⏱ Gapirish sekundomeri: 1 daqiqadan keyin yashil (yetarli), 2 daqiqadan keyin to'xtash vaqti
  const clock = $("cueClock");
  const t0 = Date.now();
  clock.hidden = false;
  clock.className = "cue-clock";
  const tick = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    clock.textContent = `🎤 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    clock.classList.toggle("ok", sec >= 60 && sec < 120);
    clock.classList.toggle("over", sec >= 120);
    // ⏰ Imtihondagidek vaqt eslatmalari (bir martadan)
    if (sec === 60) {
      haptic("light");
      toast("✅ 1 daqiqa bo'ldi — zo'r, yana biroz davom eting", 2500);
    } else if (sec === 115) {
      haptic("medium");
      toast("⏰ Vaqt tugayapti — fikringizni yakunlang", 3000);
    }
    if (sec >= 150 || state.phase === "ended") clearInterval(state.cueClock);
  };
  tick();
  clearInterval(state.cueClock);
  state.cueClock = setInterval(tick, 1000);
  haptic("medium");
  toast("🎤 Gapiring! 1–2 daqiqa to'xtovsiz gapiring", 2500);
  afterReply();
}
$("cueReady").addEventListener("click", endCuePrep);

async function afterReply() {
  if (state.phase !== "ended" && startCuePrep()) return;
  if (state.phase === "ended") return;
  if (state.used.size >= state.lesson.phrases.length) {
    setTimeout(() => finish(), 600);
    return;
  }
  // Sado gapirayotganda mikrofon o'chirilgan edi - endi qayta yoqamiz
  if (!state.textOnly) {
    await ensureAudio();
    if (state.phase === "ended") return;
    applyMode();
  }
  if (!state.textOnly && state.mode === "auto") listenAuto();
  else setPhase("idle");
}

// ---------------- Javobni ijro etish ----------------
// parts: [{ lang: "uz"|"en", text, audio }] - ketma-ket ijro etiladi
async function playReply(parts, fallbackText) {
  if (state.phase === "ended") return;
  if (!Array.isArray(parts) || !parts.length) parts = [{ lang: "en", text: fallbackText, audio: null }];
  // Android: mikrofon yoniq tursa ovoz "qo'ng'iroq" rejimida (quloq dinamigidan, juda past) chiqadi.
  // Shuning uchun Sado gapirayotganda mikrofonni o'chiramiz; bu aks-sadoning ham oldini oladi.
  cancelRecording();
  releaseMic();
  // Ovoz xatosi haqida bir darsda faqat bir marta aytamiz
  if (!parts.some((p) => p.audio) && !state.ttsWarned) {
    state.ttsWarned = true;
    toast("⚠️ Ovoz serverdan kelmadi — matn bilan davom etamiz", 3500);
  }
  state.lastParts = parts;
  $("replayBtn").hidden = false;
  setPhase("speaking");
  for (const p of parts) {
    if (state.phase !== "speaking") break; // dars tugatilgan bo'lsa
    $("statusText").textContent = p.lang === "uz" ? "Sado tushuntirmoqda..." : "Sado gapirmoqda...";
    try {
      if (p.audio) await playMp3(p.audio, p.mime);
      else await speakBrowser(p.text, p.lang);
    } catch (e) {
      console.warn("Ijro:", e);
      toast("⚠️ Ijro xatosi: " + (e?.message || e), 5000);
    }
  }
  mascot.setLevel(0);
}

async function playMp3(b64, mime = "audio/mpeg") {
  // Android WebView'da AudioContext o'zi to'xtab qolishi mumkin - har safar qayta yoqamiz
  try {
    if (audio.ctx.state !== "running") await audio.ctx.resume();
  } catch {}
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let buffer;
  try {
    buffer = await audio.ctx.decodeAudioData(bytes.buffer);
  } catch {
    return playViaElement(b64, mime);
  }
  if (audio.ctx.state !== "running") {
    toast("ℹ️ Audio holati: " + audio.ctx.state, 3000);
    return playViaElement(b64, mime);
  }
  return new Promise((resolve) => {
    let raf = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      audio.source = null;
      resolve();
    };
    const src = audio.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(audio.outAnalyser);
    audio.source = src;
    const buf = new Float32Array(audio.outAnalyser.fftSize);
    const meter = () => {
      mascot.setLevel(Math.min(1, rms(audio.outAnalyser, buf) * 6));
      raf = requestAnimationFrame(meter);
    };
    src.onended = finish;
    src.start();
    meter();
    setTimeout(finish, (buffer.duration + 1.5) * 1000); // onended kelmasa ham davom etamiz
  });
}

// Zaxira usul: oddiy <audio> elementi orqali ijro
function playViaElement(b64, mime = "audio/mpeg") {
  return new Promise((resolve) => {
    const el = new Audio(`data:${mime};base64,` + b64);
    let raf = 0;
    const fake = (t) => {
      mascot.setLevel(0.35 + Math.abs(Math.sin(t / 90)) * 0.5);
      raf = requestAnimationFrame(fake);
    };
    const done = () => {
      cancelAnimationFrame(raf);
      resolve();
    };
    el.onended = done;
    el.onerror = done;
    el.play()
      .then(() => (raf = requestAnimationFrame(fake)))
      .catch((e) => {
        // Faqat dars ekranida ogohlantiramiz (hisobot sahifasida ortiqcha xabar chiqmasin)
        state.audioFail = true;
        applySubs();
        if ($("lesson").classList.contains("active"))
          toast(e?.name === "NotAllowedError" ? "🔇 Ovozni yoqish uchun ekranga bir marta bosing" : "⚠️ Ovoz ijro etilmadi — Sado gapini subtitrdan o'qing", 4000);
        done();
      });
    setTimeout(done, 30000);
  });
}

function speakBrowser(text, lang = "en") {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) return setTimeout(resolve, 1200);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "uz" ? "uz-UZ" : "en-US";
    u.rate = state.slow ? 0.75 : 0.95;
    let raf = 0;
    const fake = (t) => {
      mascot.setLevel(0.35 + Math.abs(Math.sin(t / 90)) * 0.5);
      raf = requestAnimationFrame(fake);
    };
    const done = () => {
      cancelAnimationFrame(raf);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    raf = requestAnimationFrame(fake);
    setTimeout(done, 20000);
  });
}

// ---------------- Tugatish ----------------
function stopAll() {
  clearInterval(state.timer);
  clearInterval(state.cueClock);
  $("lesson").classList.remove("is-live");
  $("wordsLive").hidden = true;
  state.live?.stop();
  state.live = null;
  cancelRecording();
  try { audio.source?.stop(); } catch {}
  try { window.speechSynthesis?.cancel(); } catch {}
}

async function finish() {
  if (state.phase === "ended" && $("result").classList.contains("active")) return;
  state.phase = "ended";
  stopAll();
  releaseMic();
  const session = state.session;
  state.session = null;
  // Avvalgi eng yaxshi natija (yangilanishdan oldin)
  state.prevBest = state.progress?.lessons?.[state.lesson?.id]?.best ?? null;
  showResult();
  if (!session) return;
  $("report").hidden = false;
  $("report").innerHTML = '<div class="rep-loading"><span class="spin"></span>Sado hisobot tayyorlamoqda...</div>';
  try {
    const data = await api("api/end", { json: { session }, timeout: 45000 });
    // 🙊 Hech narsa aytilmagan: maqtov o'rniga tushuntirish, limit sarflanmaydi
    if (data.empty) {
      $("report").hidden = true;
      $("resultTitle").textContent = "Hali hech narsa demadingiz 🙂";
      $("resultSub").textContent = "Hisobot va ball uchun Sado bilan kamida bir-ikki gap almashing. Bu urinish kunlik limitdan hisoblanmadi.";
      $("resultList").hidden = true;
      $("againBtn").textContent = "🎤 Qaytadan boshlash";
      if (state.progress) state.progress.startedToday = data.progress?.startedToday ?? Math.max(0, (state.progress.startedToday || 1) - 1);
      return;
    }
    if (data.progress) {
      const before = new Set(Object.keys(state.progress?.lessons || {}));
      state.progress = { ...data.progress, limit: state.progress?.limit, startedToday: state.progress?.startedToday };
      checkCourseDone(before);
      renderChips(); // 🔁 Takrorlash chipi yangilanishi uchun
      renderLessons();
    }
    renderReport(data.report, data.score);
    if (data.fixedNow) toast(`✅ ${data.fixedNow} ta xatoingiz tuzatildi deb belgilandi!`, 3500);
    announceBadges();
    renderTranscript(data.transcript, data.report?.mistakes);
    renderSpeakStats(data.transcript, data.prevMaxWords);
  } catch {
    // Hisobot kelmadi — aylanib turgan belgini qoldirmaymiz
    $("report").innerHTML = "";
    $("report").append(el("div", "muted", "⏱ Hisobot hozir tayyor bo'lmadi (internet sekin bo'lishi mumkin)."));
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 🎓 Kurs tugatildi: shu dars kursning oxirgi o'tilmagan darsi bo'lsa
function checkCourseDone(before) {
  const l = state.lesson;
  $("cert").hidden = true;
  if (!l || !/kursi$|Grammatika/.test(l.category || "")) return;
  const all = state.lessons.filter((x) => x.category === l.category);
  const done = state.progress?.lessons || {};
  const wasDone = all.every((x) => before.has(x.id));
  if (wasDone || !all.every((x) => done[x.id])) return;
  const avg = Math.round(all.reduce((s, x) => s + (done[x.id]?.best || 0), 0) / all.length);
  const box = $("cert");
  box.innerHTML = "";
  box.append(
    el("div", "cert-ico", "🎓"),
    el("div", "cert-t", "Tabriklaymiz! Kurs tugatildi"),
    el("div", "cert-c", l.category),
    el("div", "cert-s", `${all.length} ta dars · o'rtacha ${avg} ball${l.category === "CEFR kursi" && state.progress?.ml != null ? ` · Multilevel ~${state.progress.ml}/75` : ""}`),
  );
  // 👤 Shaxsiy sertifikat: Telegram ismi va sana
  const who = [tg?.initDataUnsafe?.user?.first_name, tg?.initDataUnsafe?.user?.last_name].filter(Boolean).join(" ");
  const d = new Date();
  box.append(el("div", "cert-who", `${who ? who + " · " : ""}${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`));
  const share = el("button", "btn share wide", "📤 Yutuqni ulashish");
  share.addEventListener("click", () => {
    const text = `🎓 Sado AI'da «${l.category}» ni to'liq tugatdim!\n${all.length} ta dars · o'rtacha ${avg} ball\nSen ham sinab ko'r 👇`;
    const link = `https://t.me/share/url?url=${encodeURIComponent(state.shareUrl || "https://t.me")}&text=${encodeURIComponent(text)}`;
    if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, "_blank");
  });
  box.append(share);
  // ➡️ Keyingi kursni tavsiya qilamiz
  const NEXT = { "Grammatika gapirib": "CEFR kursi", "CEFR kursi": "IELTS kursi", "IELTS kursi": "Imtihonlar" };
  const nc = NEXT[l.category];
  if (nc && state.lessons.some((x) => x.category === nc)) {
    const go = el("button", "btn ghost wide cert-next", `➡️ Keyingi bosqich: ${CAT_ICONS[nc] || "📚"} ${nc}`);
    go.addEventListener("click", () => {
      haptic();
      show("home");
      state.filter.cat = nc;
      renderChips();
      renderLessons();
      setTimeout(() => scrollToList(), 50);
    });
    box.append(go);
  }
  box.hidden = false;
  confetti();
  haptic("success");
}

// 📜 Suhbat matni
// 🗣 Qancha gapirildi: gaplar va so'zlar soni (ayniqsa erkin suhbat uchun foydali)
function renderSpeakStats(list, serverBest) {
  const mine = (list || []).filter((t) => t.who === "student" && t.text?.trim());
  const box = $("report");
  if (!mine.length || box.hidden) return;
  const words = mine.reduce((n, t) => n + t.text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length, 0);
  state.lastWords = words; // 📤 ulashish matni uchun
  const longest = mine.reduce((m, t) => Math.max(m, t.text.trim().split(/\s+/).length), 0);
  const row = el("div", "speak-stats");
  row.append(
    el("span", "", `🗣 ${mine.length} ta gap`),
    el("span", "", `🔤 ${words} ta inglizcha so'z`),
    el("span", "", `📏 eng uzun gap: ${longest} so'z`),
  );
  // 🏆 Bir darsda eng ko'p gapirilgan so'zlar rekordi
  // Rekord serverda saqlanadi (boshqa telefondan kirsa ham); eski versiyadagi mahalliy qiymat ham hisobga olinadi
  const best = Math.max(Number(serverBest) || 0, Number(localStorage.getItem("sado-maxwords")) || 0);
  if (words > best) {
    localStorage.setItem("sado-maxwords", String(words));
    if (best > 0) row.append(el("span", "rec", `🏆 Yangi rekord! (avval ${best})`));
  } else if (best) row.append(el("span", "rec-old", `🏆 Rekord: ${best} so'z`));
  box.firstChild ? box.firstChild.after(row) : box.append(row);
}

function renderTranscript(list, mistakes = []) {
  // ✏️ Hisobotdagi xatolar o'quvchi gapida qizil chiziq bilan belgilanadi (ustiga bosilsa — to'g'risi)
  const wrongs = (mistakes || []).filter((m) => m?.wrong && m.wrong.length >= 3);
  const box = $("transcript");
  const log = $("trLog");
  log.innerHTML = "";
  const items = (list || []).filter((t) => t.text && t.text.trim());
  box.hidden = !items.length;
  box.open = false;
  for (const t of items) {
    const b = el("div", "bubble " + (t.who === "sado" ? "b-sado" : "b-me"));
    const span = el("span", "", "");
    const txt = t.text.trim();
    const m = t.who === "sado" ? null : wrongs.find((w) => txt.toLowerCase().includes(w.wrong.toLowerCase().replace(/[.!?]+$/, "")));
    if (m) {
      const key = m.wrong.replace(/[.!?]+$/, "");
      const i = txt.toLowerCase().indexOf(key.toLowerCase());
      const mark = el("mark", "tr-err", txt.slice(i, i + key.length));
      mark.title = "To'g'risi: " + m.right;
      mark.addEventListener("click", () => toast("✅ " + m.right, 3500));
      span.append(document.createTextNode(txt.slice(0, i)), mark, document.createTextNode(txt.slice(i + key.length)));
    } else span.textContent = txt;
    b.append(el("small", "", t.who === "sado" ? "Sado" : "Siz"), span);
    log.append(b);
  }
  // 📋 Suhbat matnini nusxalash
  if (items.length) {
    const cp = el("button", "btn ghost wide tr-copy", "📋 Suhbat matnini nusxalash");
    cp.addEventListener("click", async () => {
      haptic();
      const text = `💬 Sado bilan suhbat: ${state.lesson?.title || ""}\n\n` + items.map((t) => `${t.who === "sado" ? "Sado" : "Men"}: ${t.text.trim()}`).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        toast("📋 Suhbat matni nusxalandi");
      } catch {
        toast("Nusxalab bo'lmadi");
      }
    });
    log.append(cp);
  }
}

// ⬆ Uzun ro'yxatda tepaga qaytish
let topRaf = 0;
window.addEventListener("scroll", () => {
  cancelAnimationFrame(topRaf);
  topRaf = requestAnimationFrame(() => {
    $("toTop").hidden = !$("home").classList.contains("active") || window.scrollY < 1200;
  });
}, { passive: true });
$("toTop").addEventListener("click", () => {
  haptic();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// 👥 Do'stni taklif qilish
$("inviteBtn").addEventListener("click", () => {
  haptic();
  const p = state.progress;
  const text = [
    "🎤 Men Sado AI bilan ingliz tilida gaplashishni mashq qilyapman!",
    p?.streak ? `🔥 ${p.streak} kunlik seriyam bor` : "",
    "IELTS, CEFR, grammatika va erkin suhbat — o'zbekcha tushuntirish bilan. Sen ham qo'shil 👇",
  ].filter(Boolean).join("\n");
  const url = state.shareUrl || "https://t.me";
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
  else if (navigator.share) navigator.share({ text: text + "\n" + url }).catch(() => {});
  else window.open(link, "_blank");
});

$("setInvite").addEventListener("click", () => $("inviteBtn").click());

// 📤 Natijani Telegram orqali ulashish
$("shareBtn").addEventListener("click", () => {
  const { r, score } = state.lastResult || {};
  const l = state.lesson;
  const sc = r?.score ?? score;
  const text = [
    `🎤 Sado AI bilan ingliz tilida gaplashdim!`,
    `${l.emoji} ${l.title}: ${sc} ball${r?.level && l.category !== "Bolalar uchun" ? ` · ${r.level}` : ""}`, // bolalarda daraja ko'rsatilmaydi
    // Erkin suhbatda iboralar yo'q — "0/0 ta ibora" yozilmasin
    l.category === "Bolalar uchun" && l.phrases.length
      ? `${"⭐".repeat(state.used.size)}${"☆".repeat(Math.max(0, l.phrases.length - state.used.size))} — ${state.used.size} ta yulduz yig'dim!`
      : !l.liveOnly && l.phrases.length ? `✅ ${state.used.size}/${l.phrases.length} ta ibora` : "",
    state.lastWords ? `🗣 ${state.lastWords} ta inglizcha so'z gapirdim` : "",
    r?.ml_score != null && Number.isFinite(Number(r.ml_score)) ? `🇺🇿 Multilevel: ~${Math.round(Number(r.ml_score))}/75` : "",
    r?.criteria ? `📊 Fluency ${r.criteria.fluency} · Lexical ${r.criteria.vocabulary} · Grammar ${r.criteria.grammar} · Pronunciation ${r.criteria.pronunciation}` : "",
    r?.new_words?.length ? `📚 ${r.new_words.length} ta yangi so'z o'rgandim` : "",
    state.progress?.streak ? `🔥 ${state.progress.streak} kunlik seriya` : "",
    sc != null ? `Meni ${sc} balldan o'zib ko'r! 💪👇` : `Sen ham sinab ko'r 👇`,
  ].filter(Boolean).join("\n");
  const url = state.shareUrl || "https://t.me";
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  haptic();
  if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
  else if (navigator.share) navigator.share({ text: text + (state.shareUrl ? "\n" + state.shareUrl : "") }).catch(() => {});
  else window.open(link, "_blank");
});

// ✏️ Xato gaplarga qarab mos grammatika darsini topish (oddiy qoidalar bo'yicha)
function grammarLessonFor(mistakes) {
  const words = (t) => new Set(String(t || "").toLowerCase().match(/[a-z']+/g) || []);
  const PREP = ["in", "on", "at", "to", "for", "from", "by", "with", "about"];
  const rules = [
    [(w) => /\b(i|you|we|they) (wants|likes|goes|has|does|works|lives|studies)\b|\b(he|she|it) (want|like|go|have|work|live|study)\b|doesn't \w+s\b/.test(w), "gr-simple"],
    [(w) => /\b(i|he|she|it) were\b|\b(we|you|they) was\b/.test(w), "gr-pastcont"],
    [(w) => /\b(goed|eated|buyed|catched|thinked|runned|did \w+ed|didn't \w+ed)\b/.test(w), "gr-past"],
    [(w) => /\b(more (big|good|bad|small|tall|cheap|fast)|gooder|baddest|most (big|good))\b/.test(w), "gr-compare"],
    // Predlog almashtirilgan (on → in, on → to ...)
    [(w, r) => { const a = words(w), b = words(r); return PREP.some((x) => a.has(x) !== b.has(x)); }, "gr-prepositions"],
    // Artikl qo'shilgan/olib tashlangan yoki a ↔ an
    [(w, r) => { const a = words(w), b = words(r); return ["a", "an", "the"].some((x) => a.has(x) !== b.has(x)); }, "gr-articles"],
    [(w, r) => /\b(have|has) (been|seen|done|gone|visited|lived)\b/.test(r) && !/\b(have|has)\b/.test(w), "gr-perfect"],
    [(w, r) => /\bwill\b|going to/.test(r), "gr-future"],
    [(w, r) => /\b(much|many|some|any|a few|a little)\b/.test(r), "gr-quantity"],
    [(w, r) => /\bthere (is|are)\b/.test(r), "gr-there"],
    [(w, r) => /\b(his|her|their|our)\b|'s\b/.test(r), "gr-possessive"],
    [(w) => /\b(can|should|must|might) \w+s\b|\b(can|should|must) to\b/.test(w), "gr-modals"],
    [(w, r) => /\?/.test(r) && /\b(do|does|did)\b/.test(r) && !/\b(do|does|did)\b/.test(w), "gr-questions"],
  ];
  for (const m of mistakes || []) {
    const w = String(m.wrong || "").toLowerCase(), r = String(m.right || "").toLowerCase();
    if (!w || !r) continue;
    for (const [test, id] of rules) if (test(w, r)) return state.lessons.find((l) => l.id === id) || null;
  }
  return null;
}

// 📝 AI hisobot: ball, daraja, xatolar, maslahatlar, yangi so'zlar
// 🎉 Konfetti (80+ ball)
function confetti() {
  const c = document.createElement("canvas");
  c.className = "confetti";
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext("2d");
  const colors = ["#4f46e5", "#14b8a6", "#f59e0b", "#e11d48", "#16a34a", "#a855f7"];
  const ps = Array.from({ length: 120 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, r: 4 + Math.random() * 4,
    a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3, col: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const tick = (t) => {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
    }
    if (t - t0 < 3200) requestAnimationFrame(tick);
    else c.remove();
  };
  requestAnimationFrame(tick);
}

function renderReport(r, score) {
  const box = $("report");
  box.innerHTML = "";
  // Sarlavha va maskot AI baliga qarab
  const sc = r?.score ?? score;
  if (sc != null && !state.lesson?.liveOnly) {
    if (state.lesson?.category !== "Bolalar uchun") // bolalarda yulduzli sarlavha qoladi
      $("resultTitle").textContent = sc >= 85 ? "Ajoyib! 🎉" : sc >= 65 ? "Barakalla! 👏" : sc >= 40 ? "Yaxshi harakat! 💪" : "Boshlanishi yomon emas! 🌱";
    resultMascot.setMood(sc >= 65 ? "happy" : "neutral");
  }
  if (sc >= 80) {
    confetti();
    haptic("success");
  }
  state.lastResult = { r, score };
  $("shareBtn").hidden = !(r || score != null);
  if (!r) {
    if (score == null) return (box.hidden = true);
    box.append(el("div", "rep-score-row", ""));
    box.firstChild.append(el("div", "rep-score", String(score)), el("div", "rep-level", "ball"));
    return;
  }
  const top = el("div", "rep-score-row");
  const ring = el("div", "rep-score", String(r.score));
  ring.style.setProperty("--p", r.score);
  // Ballga qarab rang: past — to'q sariq, o'rta — ko'k, yuqori — yashil
  ring.style.setProperty("--ring", r.score >= 75 ? "#16a34a" : r.score >= 50 ? "var(--primary)" : "#f59e0b");
  const right = el("div", "rep-top-text");
  right.append(el("div", "rep-level", r.level || ""));
  // 🇺🇿 Milliy CEFR (Multilevel) imtihon shkalasi: 0–75
  const ml = r.ml_score == null ? NaN : Number(r.ml_score); // null → 0 bo'lib qolmasin
  if (Number.isFinite(ml) && ml >= 0 && ml <= 75) {
    const next = ml < 38 ? [38, "B1"] : ml < 51 ? [51, "B2"] : ml < 65 ? [65, "C1"] : null;
    const pill = el("button", "rep-ml", `🇺🇿 Multilevel: ~${Math.round(ml)}/75${next ? ` · ${next[1]} gacha ${next[0] - Math.round(ml)} ball` : " · C1 🎉"} ⓘ`);
    // ⓘ Bosilsa — Multilevel shkalasi: qaysi ball qaysi darajaga to'g'ri keladi, siz qayerdasiz
    const scale = el("div", "ml-scale");
    scale.hidden = true;
    const bands = [["B1 gacha", 0, 37], ["B1", 38, 50], ["B2", 51, 64], ["C1", 65, 75]];
    const bar = el("div", "ml-bar");
    for (const [name, lo, hi] of bands) {
      const seg = el("div", "ml-seg" + (ml >= lo && ml <= hi + 0.99 ? " on" : ""));
      seg.append(el("b", "", name), el("small", "", `${lo}–${hi}`));
      bar.append(seg);
    }
    const mark = el("i", "ml-mark");
    // Bo'laklar teng kenglikda — belgi o'z bo'lagi ichida joylashadi
    const bi = bands.findIndex(([, lo, hi]) => ml >= lo && ml < hi + 1);
    const [, blo, bhi] = bands[Math.max(0, bi)];
    mark.style.left = `${((Math.max(0, bi) + (ml - blo) / (bhi - blo + 1)) / bands.length) * 100}%`;
    bar.append(mark);
    scale.append(bar, el("small", "ml-note", "Milliy sertifikat (Multilevel) speaking bo'limi 75 ballik. Bu — taxminiy baho, haqiqiy imtihonda farq qilishi mumkin."));
    pill.addEventListener("click", () => {
      haptic();
      scale.hidden = !scale.hidden;
    });
    right.append(pill, scale);
  }
  right.append(el("div", "rep-summary", r.summary_uz || ""));
  // 📈 Avvalgi natija bilan solishtirish
  if (state.prevBest != null) {
    const d = r.score - state.prevBest;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    const txt = d > 0 ? `▲ +${d} — yangi rekord! (avval ${state.prevBest})` : d < 0 ? `▼ ${d} (eng yaxshisi ${state.prevBest})` : `= Rekordingizga teng (${state.prevBest})`;
    right.append(el("div", "rep-cmp " + cls, txt));
  }
  top.append(ring, right);
  box.append(top);
  // 🪜 Past ball: yengilroq rejimni taklif qilamiz (inglizcha suhbat/jonli → ustoz)
  if (r.score < 50 && state.lessonMode !== "tutor" && !state.lesson?.liveOnly && state.lesson?.id !== "review") {
    const tip = el("div", "rep-easier");
    tip.append(el("span", "", "🪜 Bu dars hozircha qiyinroq bo'ldi. Ustoz rejimida Sado har bir iborani o'zbekcha tushuntirib, birma-bir takrorlatadi."));
    const b = el("button", "btn ghost wide", "🇺🇿 Ustoz bilan qayta o'tish");
    b.addEventListener("click", () => {
      haptic();
      startLesson(state.lesson, "tutor");
    });
    tip.append(b);
    box.append(tip);
  }

  const section = (title, items, render) => {
    if (!items || !items.length) return;
    box.append(el("div", "rep-title", title));
    const ul = el("ul", "rep-list");
    items.forEach((it) => ul.append(render(it)));
    box.append(ul);
  };
  const CRIT_INFO = {
    fluency: "Ravonlik: to'xtab qolmasdan, uzun va bog'langan javob bera olish. Oshirish uchun: «Well, ...», «Actually, ...» kabi to'ldiruvchilar, firstly/then/finally kabi bog'lovchilar.",
    vocabulary: "So'z boyligi: mavzuga mos va xilma-xil so'zlar, iboralar. Oshirish uchun: bir so'zni takrorlamang, sinonim ishlating (good → great, helpful).",
    grammar: "Grammatika: zamonlarni to'g'ri qo'llash va murakkab gaplar (because, which, if). Oshirish uchun: har javobda bitta murakkab gap tuzing.",
    pronunciation: "Talaffuz: so'zlar aniq va tushunarli, urg'u va ohang to'g'ri. Oshirish uchun: «Tinglab takrorlash» mashqi va iboralarni Sado ovozida tinglash.",
  };
  // IELTS: 4 ta rasmiy mezon bo'yicha band
  if (r.criteria) {
    const NAMES = { fluency: "Ravonlik (Fluency)", vocabulary: "So'z boyligi (Lexical)", grammar: "Grammatika", pronunciation: "Talaffuz" };
    const box2 = el("div", "crit");
    for (const [k, name] of Object.entries(NAMES)) {
      const v = r.criteria[k] || 0;
      const row = el("div", "crit-row");
      const bar = el("span", "crit-bar");
      const fill = el("i", "");
      fill.style.width = `${(v / 9) * 100}%`;
      bar.append(fill);
      const nm = el("span", "crit-name", "");
      const [uz, en] = name.split(" (");
      nm.append(uz, en ? el("small", "crit-en", " (" + en) : "");
      row.append(nm, bar, el("b", "", v.toFixed(1)));
      // ℹ️ Bosilganda mezon nimani baholashi tushuntiriladi
      const info = el("div", "crit-info", CRIT_INFO[k]);
      info.hidden = true;
      row.addEventListener("click", () => {
        haptic();
        info.hidden = !info.hidden;
      });
      box2.append(row, info);
    }
    box.append(el("div", "rep-title", "📊 IELTS mezonlari"), box2, el("small", "crit-hint", "ℹ️ Mezonni bosing — nimani baholashini bilib oling"));
    // 🎯 Eng zaif mezon bo'yicha aniq maslahat va bir bosishda mashq
    const weak = Object.keys(NAMES).filter((k) => Number.isFinite(r.criteria[k])).sort((a, b) => r.criteria[a] - r.criteria[b])[0];
    const ADVICE = {
      fluency: ["To'xtovsiz gapirishni mashq qiling: «Well, ...», «Let me think...» kabi to'ldiruvchilar yordam beradi.", "📞 Erkin suhbatda mashq qilish"],
      vocabulary: ["Bir xil so'zlarni takrorlamang, sinonim ishlating (good → excellent, useful). Lug'atingizni takrorlang.", "📒 Lug'atimni ochish"],
      grammar: ["Zamonlar va savol tuzishdagi xatolar ballni pasaytiradi. Grammatika darslari aynan shu uchun.", "✏️ Grammatika darslariga o'tish"],
      pronunciation: ["So'zlarni aniq va sekinroq ayting. «Tinglab takrorlash» mashqi talaffuzni tez yaxshilaydi.", "🔁 Darsni qayta o'tish"],
    };
    // ✏️ Xatolarga qarab aniq grammatika darsi (masalan "I wants" → Present Simple)
    const grPick = weak === "grammar" ? grammarLessonFor(r.mistakes) : null;
    if (grPick) ADVICE.grammar[1] = `✏️ Tavsiya: ${grPick.emoji} ${grPick.title.replace(/^\d+\.\s*/, "")}`;
    if (weak && ADVICE[weak]) {
      const w = el("div", "crit-weak");
      w.append(el("b", "", `🎯 Eng zaif tomon: ${NAMES[weak]} — ${r.criteria[weak].toFixed(1)}`), el("span", "", ADVICE[weak][0]));
      const go = el("button", "btn ghost wide", ADVICE[weak][1]);
      go.addEventListener("click", () => {
        haptic();
        const free = state.lessons.find((l) => l.liveOnly);
        if (weak === "fluency" && free && state.liveEnabled) return startLesson(free, "live");
        if (weak === "vocabulary") return $("vocabBtn").click();
        if (weak === "grammar" && grPick) {
          show("home");
          return openSheet(grPick);
        }
        if (weak === "grammar") {
          show("home");
          state.filter.cat = "Grammatika gapirib";
          renderChips();
          renderLessons();
          return setTimeout(() => {
            scrollToList();
            const on = $("chips").querySelector(".chip-f.on");
            if (on) $("chips").scrollLeft = on.offsetLeft - ($("chips").clientWidth - on.offsetWidth) / 2;
          }, 50);
        }
        $("againBtn").click();
      });
      w.append(go);
      box.append(w);
    }
  }
  section("👍 Yaxshi chiqdi", r.strengths_uz, (t) => el("li", "", t));
  section("✏️ Xatolar ustida ishlaymiz", r.mistakes, (m) => {
    const li = el("li", "rep-mistake");
    const line = el("div", "");
    line.append(el("s", "rep-wrong", m.wrong), document.createTextNode(" → "), el("b", "rep-right", m.right));
    li.append(line, el("div", "rep-why", m.why_uz || ""));
    // ✏️ Shu xatoga mos grammatika darsi (hozirgi dars bo'lmasa)
    const gl = grammarLessonFor([m]);
    if (gl && gl.id !== state.lesson?.id) {
      const go = el("button", "rep-grlink", `✏️ Dars: ${gl.title.replace(/^\d+\.\s*/, "").replace(/\s*\([^)]*\)$/, "")} ›`);
      go.addEventListener("click", (e) => {
        e.stopPropagation();
        haptic();
        show("home");
        openSheet(gl);
      });
      li.append(go);
    }
    li.classList.add("rep-word"); // bosilganda to'g'ri variant eshittiriladi
    li.addEventListener("click", () => sayPhrase(m.right).then(() => mascot.setLevel(0)));
    return li;
  });
  // 🔁 Xatolar 2 tadan ko'p bo'lsa — darhol shular ustida qisqa mashq
  if ((r.mistakes || []).length >= 2 && state.lesson?.id !== "review") {
    const b = el("button", "btn ghost wide rep-fixbtn", "🔁 Shu xatolarni hoziroq mashq qilish");
    b.addEventListener("click", () => {
      haptic();
      $("reviewBtn").click();
    });
    box.append(b);
  }
  // 📖 Grammatika darsida xato bo'lsa — qoida shu yerda eslatiladi (bosib ochiladi)
  if (state.lesson?.rule && (r.mistakes || []).length) {
    const d = document.createElement("details");
    d.className = "rule rep-rule";
    const sm = document.createElement("summary");
    sm.textContent = "📖 Qoidani yana bir ko'rib chiqing";
    d.append(sm, ruleBody(state.lesson.rule));
    box.append(d);
  }
  // 🧩 Grammatika darsidan keyin — mustahkamlash mashqi (qisqa test)
  if (state.lesson?.quiz?.length) {
    const qz = el("div", "quiz rep-quiz");
    box.append(qz);
    renderQuiz(state.lesson, qz, "🧩 Mustahkamlash: 4 ta tez savol");
  }
  // 📝 IELTS Part 2: namunaviy javob (Band 7)
  const cefrTask = /^cefr-\d+$/.test(state.lesson?.id || "") && state.lesson.id !== "cefr-8";
  if (state.lesson?.cue || state.lesson?.questions || cefrTask) {
    const sb = el("button", "btn ghost wide sample-btn", cefrTask ? "📝 Namunaviy javob (B2) — solishtirib ko'ring" : state.lesson.cue ? "📝 Namunaviy javob (Band 7) — solishtirib ko'ring" : "📝 Savollarga namunaviy javoblar (Band 7)");
    const out = el("div", "sample-box");
    out.hidden = true;
    sb.addEventListener("click", async () => {
      haptic();
      if (!out.hidden) return (out.hidden = true);
      out.hidden = false;
      if (out.dataset.ok) return;
      out.innerHTML = '<div class="rep-loading"><span class="spin"></span>Namuna tayyorlanmoqda...</div>';
      try {
        const d = await api("api/sample", { json: { lessonId: state.lesson.id } });
        out.innerHTML = "";
        out.dataset.ok = "1";
        const paras = d.answer.split(/\n+/).filter((x) => x.trim());
        // 🔊 Butun namunani tinglash (paragraflar ketma-ket, o'qilayotgani ajratiladi; yana bosilsa — to'xtaydi)
        const play = el("button", "rule-all sample-play", "▶ Namunani tinglash");
        let run = 0;
        play.addEventListener("click", async () => {
          haptic();
          const my = ++run;
          const ps = [...out.querySelectorAll(":scope > p")];
          if (play.classList.contains("on")) { play.classList.remove("on"); play.textContent = "▶ Namunani tinglash"; ps.forEach((x) => x.classList.remove("now")); return; }
          play.classList.add("on");
          play.textContent = "⏹ To'xtatish";
          for (const x of ps) {
            if (my !== run || !out.isConnected) break;
            ps.forEach((y) => y.classList.toggle("now", y === x));
            await sayPhrase(x.textContent).catch(() => {});
          }
          if (my === run) { play.classList.remove("on"); play.textContent = "▶ Namunani tinglash"; ps.forEach((y) => y.classList.remove("now")); }
          mascot.setLevel(0);
        });
        out.append(play);
        for (const para of paras) out.append(el("p", "", para));
        if (d.phrases?.length) {
          out.append(el("b", "", "💬 Foydali iboralar:"));
          const ul = el("ul", "rep-list");
          for (const ph of d.phrases) {
            const li = el("li", "rep-word");
            li.append(el("b", "", ph.en), el("span", "muted", " — " + ph.uz));
            li.addEventListener("click", () => sayPhrase(ph.en).then(() => mascot.setLevel(0)));
            // 📒 Lug'atga saqlash (kartochkalarda takrorlanadi)
            if (state.progress) {
              const has = (state.progress.words || []).some((w) => w.en === ph.en);
              const keep = el("button", "ph-keep" + (has ? " on" : ""), has ? "✓" : "＋");
              keep.title = has ? "Lug'atda" : "Lug'atga saqlash";
              keep.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (keep.classList.contains("on")) return toast("📒 Bu ibora lug'atingizda bor");
                haptic();
                try {
                  const r = await api("api/word", { json: { en: ph.en } });
                  if (r.progress) state.progress = { ...state.progress, words: r.progress.words };
                  renderVocabBtn();
                  keep.classList.add("on");
                  keep.textContent = "✓";
                  toast("📒 Lug'atga saqlandi — kartochkalarda takrorlanadi");
                } catch (err) { toast(err.message); }
              });
              li.append(keep);
            }
            ul.append(li);
          }
          out.append(ul);
        }
      } catch (e) {
        out.innerHTML = "";
        out.append(el("div", "muted", e.message));
      }
    });
    box.append(sb, out);
  }
  section("💡 Keyingi safar", r.tips_uz, (t) => el("li", "", t));
  section("📚 Yangi so'zlar", r.new_words, (w) => {
    const li = el("li", "rep-word");
    li.append(el("b", "", w.en), el("span", "muted", " — " + (w.uz || "")));
    li.addEventListener("click", () => sayPhrase(w.en).then(() => mascot.setLevel(0)));
    return li;
  });
  if ((r.new_words || []).length || (r.mistakes || []).length)
    box.append(el("div", "rep-saved", "📒 Yangi so'zlar va xatolar lug'atingizga saqlandi"));
}

function showResult() {
  const { lesson, used } = state;
  const n = lesson.phrases.length;
  const k = used.size;
  $("resultTitle").textContent = k === n ? "Ajoyib! 🎉" : k >= n / 2 ? "Barakalla! 👏" : "Yaxshi boshlanish! 💪";
  $("resultSub").textContent = `${lesson.title}: ${n} tadan ${k} ta iborani ishlatdingiz.`;
  resultMascot.setState(k === n ? "speaking" : "idle");
  resultMascot.setMood(k >= n / 2 ? "happy" : "neutral");
  const ul = $("resultList");
  ul.innerHTML = "";
  // 🗂️ Sarlavha: nechta ibora ishlatildi; har bir iborani bosib eshitish mumkin
  const kidsRes = lesson.category === "Bolalar uchun";
  const head = el("li", "res-title", kidsRes ? `⭐ So'zlarim — ${k}/${n} ta aytildi` : `🗂️ Dars iboralari — ${k}/${n} ishlatildi`);
  if (k < n) head.append(el("small", "", kidsRes ? "Bosing, eshiting va baland ovozda takrorlang! 🔊" : "Ishlatilmaganlarini bosib eshiting va keyingi safar ayting"));
  ul.append(head);
  lesson.phrases.forEach((p, i) => {
    const li = document.createElement("li");
    if (used.has(i)) li.className = "ok";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = used.has(i) ? "✓" : "";
    const div = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = p.en;
    // 🖼 Bolalar darsida ibora rasmi ham
    if (p.pic) b.prepend(el("span", "res-pic", p.pic + " "));
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = p.uz;
    div.append(b, s);
    li.append(mark, div, el("span", "res-say", "🔊"));
    li.addEventListener("click", () => {
      haptic();
      li.classList.add("busy");
      sayPhrase(p.en).finally(() => li.classList.remove("busy"));
    });
    ul.appendChild(li);
  });
  $("report").hidden = true;
  $("report").innerHTML = "";
  document.querySelectorAll(".new-badge").forEach((x) => x.remove());
  $("shareBtn").hidden = true;
  state.lastWords = 0; // oldingi darsning so'z soni ulashishga o'tib qolmasin
  $("transcript").hidden = true;
  $("cert").hidden = true;
  // ➡️ Kurs ichidagi keyingi dars (IELTS/CEFR kursi, grammatika)
  const course = state.lessons.filter((x) => x.category === lesson.category);
  const idx = course.findIndex((x) => x.id === lesson.id);
  let nxt = /kursi$|Grammatika/.test(lesson.category || "") && idx >= 0 ? course[idx + 1] : null;
  // 🏠 Mavzuli bo'limlarda (Kundalik hayot, Sayohat, Bolalar ...) — shu bo'limdagi hali o'tilmagan keyingi dars
  if (!nxt && idx >= 0 && !lesson.liveOnly && !/Imtihon|Erkin/.test(lesson.category || "")) {
    const done = state.progress?.lessons || {};
    const rest = [...course.slice(idx + 1), ...course.slice(0, idx)].filter((x) => !x.liveOnly);
    nxt = rest.find((x) => !done[x.id]) || null;
  }
  state.nextAfter = nxt || null;
  $("nextBtn").hidden = !nxt;
  if (nxt) $("nextBtn").textContent = `➡️ Keyingi dars: ${nxt.emoji} ${nxt.title.replace(/^\d+\.\s*/, "")}`;
  // Erkin suhbatda iboralar ro'yxati ma'nosiz - yashiramiz
  ul.hidden = Boolean(lesson.liveOnly);
  // 🧒 Bolalar: ball o'rniga yig'ilgan yulduzlar
  $("result").classList.toggle("kids", lesson.category === "Bolalar uchun");
  if (lesson.category === "Bolalar uchun") {
    $("resultTitle").textContent = k ? `${k} ta yulduz yig'ding! 🎉` : "Yaxshi urinish! 💪";
    $("resultSub").textContent = "⭐".repeat(k) + "☆".repeat(Math.max(0, n - k));
  }
  $("againBtn").textContent = lesson.liveOnly ? "📞 Yana gaplashish" : state.lessonMode === "live" ? "📞 Yana qo'ng'iroq qilish" : "Qaytadan mashq qilish";
  document.querySelectorAll(".again-topics").forEach((x) => x.remove());
  if (lesson.liveOnly && state.liveEnabled) {
    // 🔄 Boshqa mavzuda darhol yana gaplashish
    const box = el("div", "again-topics");
    box.append(el("small", "", "Boshqa mavzuda gaplashamizmi?"));
    const row = el("div", "topic-pick");
    for (const [t, label] of TOPICS.filter(([t]) => t && t !== state.topic).slice(0, 6)) {
      const b = el("button", "tp", label);
      b.addEventListener("click", () => {
        haptic("medium");
        state.topic = t;
        localStorage.setItem("sado-topic", t);
        renderTopicPick();
        startLesson(lesson, "live");
      });
      row.append(b);
    }
    box.append(row);
    $("againBtn").after(box);
  }
  if (lesson.liveOnly) {
    $("resultTitle").textContent = "Ajoyib suhbat bo'ldi! 🎉";
    $("resultSub").textContent = "Sado bilan erkin suhbat yakunlandi.";
  }
  haptic(k === n ? "success" : "light");
  show("result");
}

document.addEventListener("visibilitychange", () => {
  // Ilova yopilsa/fon rejimiga o'tsa yozishni to'xtatamiz
  if (document.hidden && state.phase === "listening") {
    cancelRecording();
    setPhase("idle");
  } else if (!document.hidden && state.phase === "idle" && state.session && state.mode === "auto" && !state.textOnly) {
    ensureAudio().then(() => listenAuto());
  }
});

show("home");
// 👋 Birinchi marta ochganlar uchun qisqa qo'llanma (bir marta ko'rsatiladi)
const ONB = [
  ["Salom! Men Sado 👋", "Ingliz tilida gapirishni o'rgatadigan AI ustozingizman. Men bilan ovoz chiqarib gaplashasiz — xuddi odam bilan gaplashgandek."],
  ["Qanday o'rganamiz? 🎯", "📞 Jonli suhbat — erkin gaplashish.\n🇺🇿 Ustoz — o'zbekcha tushuntirib, iboralarni takrorlatadi.\n🇬🇧 Suhbat — inglizcha rolli o'yin."],
  ["Har kuni oz-ozdan 🔥", "Har darsdan keyin ball, xatolar tahlili va yangi so'zlar chiqadi. Kunlik maqsad qo'ying va seriyani uzmang!"],
];
function showOnboarding() {
  if (localStorage.getItem("sado-onb") === "1") return;
  let i = 0;
  const m = new Mascot($("onbMascot"));
  m.setMood("happy");
  const render = () => {
    const [t, d] = ONB[i];
    const box = $("onbSlides");
    box.innerHTML = "";
    box.append(el("h2", "", t), el("p", "", d));
    // 🎚 Oxirgi slayd: o'z darajasini tanlash (tavsiyalar shunga moslanadi)
    if (i === ONB.length - 1) {
      const lv = el("div", "onb-level");
      lv.append(el("small", "", "Ingliz tilingiz qanday?"));
      const row = el("div", "onb-lv-row");
      for (const [k, label] of [["beg", "🌱 Boshlovchi"], ["mid", "🌿 O'rtacha"], ["adv", "🌳 Yaxshi"]]) {
        const b = el("button", "chip-f" + (localStorage.getItem("sado-level") === k ? " on" : ""), label);
        b.addEventListener("click", () => {
          haptic();
          localStorage.setItem("sado-level", k);
          for (const x of row.children) x.classList.toggle("on", x === b);
        });
        row.append(b);
      }
      lv.append(row);
      // 🎯 Maqsad: bosh sahifa shu bo'limdan ochiladi va birinchi dars shunga mos tanlanadi
      lv.append(el("small", "", "Maqsadingiz nima?"));
      const goals = el("div", "onb-lv-row onb-goals");
      for (const [k, label] of [["IELTS kursi", "🎓 IELTS"], ["CEFR kursi", "📗 CEFR"], ["Grammatika gapirib", "✏️ Grammatika"], ["Kundalik hayot", "💬 Kundalik"], ["Bolalar uchun", "🧒 Bolalar"]]) {
        const b = el("button", "chip-f" + (localStorage.getItem("sado-aim") === k ? " on" : ""), label);
        b.addEventListener("click", () => {
          haptic();
          localStorage.setItem("sado-aim", k);
          for (const x of goals.children) x.classList.toggle("on", x === b);
        });
        goals.append(b);
      }
      lv.append(goals);
      box.append(lv);
    }
    $("onbDots").innerHTML = ONB.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("");
    $("onbNext").textContent = i === ONB.length - 1 ? "🚀 Boshladik!" : "Keyingisi ›";
  };
  const close = () => {
    localStorage.setItem("sado-onb", "1");
    $("onb").hidden = true;
    // Daraja tanlangan bo'lsa — mos birinchi darsni darhol taklif qilamiz
    const lvl = localStorage.getItem("sado-level");
    renderNext(); // "Shu yerdan boshlang" darajaga moslanadi
    const goal = localStorage.getItem("sado-aim");
    if (goal && state.lessons.some((l) => l.category === goal)) {
      state.filter.cat = goal;
      renderChips();
      renderLessons();
    }
    // ✏️ Grammatika: darajaga mos boshlang'ich mavzu
    const grStart = lvl === "adv" ? "gr-perfect" : lvl === "mid" ? "gr-past" : "gr-tobe";
    const byGoal = { "IELTS kursi": "ielts-intro", "CEFR kursi": "cefr-1", "Bolalar uchun": "kid-colors", "Grammatika gapirib": grStart }[goal];
    const first = byGoal ? state.lessons.find((l) => l.id === byGoal)
      : lvl === "beg" ? state.lessons.find((l) => l.id === "cafe")
      : lvl === "mid" ? state.lessons.find((l) => l.id === "meet")
      : lvl === "adv" ? state.lessons.find((l) => l.liveOnly) || state.lessons.find((l) => l.id === "ielts")
      : null;
    if (first && !state.progress?.recent?.length) setTimeout(() => openSheet(first), 300);
  };
  $("onbNext").onclick = () => {
    haptic();
    if (i < ONB.length - 1) {
      i++;
      render();
    } else close();
  };
  $("onbSkip").onclick = close;
  render();
  $("onb").hidden = false;
}
showOnboarding();

// ℹ️ Versiya va 🔄 yangilash: eski saqlangan darslar ro'yxatini tozalab, ilovani qayta yuklash
$("appVer").textContent = `Sado v${parseInt((document.querySelector('script[src^="app.js"]')?.getAttribute("src") || "").split("v=")[1]) || "?"}`;
// 🔄 Telefonda eski sahifa qolib ketgan bo'lsa (kesh) — serverdagi versiya yangiroq bo'lsa o'zini bir marta yangilaydi
(async () => {
  const mine = parseInt((document.querySelector('script[src^="app.js"]')?.getAttribute("src") || "").split("v=")[1]) || 0; // "298.a1b2c3d4" → 298
  try {
    const r = await fetch(`api/version?t=${Date.now()}`, { cache: "no-store" });
    const { build } = await r.json();
    if (build > mine && sessionStorage.getItem("sado-upd") !== String(build)) {
      sessionStorage.setItem("sado-upd", String(build)); // cheksiz qayta yuklanmasin
      sessionStorage.setItem("sado-upd-from", String(mine));
      const u = new URL(location.href);
      u.searchParams.set("r", String(build)); // yangi manzil — eski kesh ishlatilmaydi
      location.replace(u.toString());
    }
  } catch {}
  // ✅ Yangilanishdan keyin bir marta: o'quvchi nima bo'lganini bilsin
  if (sessionStorage.getItem("sado-upd-manual")) {
    sessionStorage.removeItem("sado-upd-manual");
    setTimeout(() => toast(`✅ Eng so'nggi versiya: v${mine}`, 3000), 600);
  }
  const from = sessionStorage.getItem("sado-upd-from");
  if (from && Number(sessionStorage.getItem("sado-upd")) === mine) {
    sessionStorage.removeItem("sado-upd-from");
    setTimeout(() => toast(`✅ Sado yangilandi (v${from} → v${mine})`, 3500), 600);
  }
})();
$("appRefresh").addEventListener("click", () => {
  haptic();
  localStorage.removeItem("sado-lessons");
  toast("🔄 Yangilanmoqda...", 1500);
  // Manzilni o'zgartirib ochamiz — telefon keshidagi eski sahifa ishlatilmaydi
  sessionStorage.setItem("sado-upd-manual", "1");
  setTimeout(() => { const u = new URL(location.href); u.searchParams.set("r", String(Date.now())); location.replace(u.toString()); }, 300);
});

// 🆕 Nima yangi: versiya o'zgarganda bir marta ko'rsatiladi (yangi foydalanuvchiga emas)
const NEWS_VERSION = "2026-11-23-v2";
// Har bir yangilik bosilsa — tegishli joy ochiladi
const toGrammar = () => { state.filter.cat = "Grammatika gapirib"; renderChips(); renderLessons(); scrollToList(true); };
const NEWS = [
  // Sonlar darslardan hisoblanadi — yangi dars qo'shilganda eskirib qolmaydi
  [() => { const g = state.lessons.filter((l) => l.category === "Grammatika gapirib"); const q = g.reduce((a, l) => a + (l.quiz?.length || 0), 0); return g.length ? `✏️ Grammatika: ${g.length} ta mavzu va ${q} ta test savoli (for/since, both/either, inversiya va boshqalar)` : "✏️ Grammatikada yangi mavzular va testlar (for/since, both/either, inversiya va boshqalar)"; }, toGrammar],
  ["🎯 Aralash testda «Tanlash» — o'zingiz tanlagan mavzulardan yoki ⚠️ zaif mavzularingizdan test", () => { toGrammar(); openMixTest("pick"); }],
  ["📖 Qoidalarda misollarni ▶ ketma-ket tinglash; xato javobda 💡 aynan xatoingiz tushuntiriladi", () => { toGrammar(); openRules(); }],
  ["🧩 Lug'atimda so'z testi — o'zbekchasidan inglizchasini toping", () => { $("vocabBtn").click(); }],
  ["✋ Jonli suhbatda Sado gapirayotganda maskotni bosing — darhol to'xtaydi; endi u o'z ovozini eshitib chalkashmaydi", null],
  ["▶ Kurslarda «Davom etish» va har bir dars oxirida «➡️ Keyingi dars»", null],
];
function showNews() {
  const seen = localStorage.getItem("sado-news");
  if (seen === NEWS_VERSION) return;
  $("newsList").innerHTML = "";
  for (const [n, fn] of NEWS) {
    const li = el("li", fn ? "news-go" : "", typeof n === "function" ? n() : n);
    if (fn) {
      li.append(el("span", "news-arrow", " ›"));
      li.addEventListener("click", () => {
        haptic();
        localStorage.setItem("sado-news", NEWS_VERSION);
        $("newsSheet").hidden = true;
        setTimeout(fn, 150);
      });
    }
    $("newsList").append(li);
  }
  $("newsSheet").hidden = false;
}
$("newsClose").addEventListener("click", () => {
  localStorage.setItem("sado-news", NEWS_VERSION);
  $("newsSheet").hidden = true;
});
// Yangi foydalanuvchi tanishuvni ko'radi, "nima yangi" unga kerak emas
if (!$("onb").hidden) localStorage.setItem("sado-news", NEWS_VERSION);
else showNews();

// ❓ Yordam: ko'p beriladigan savollar
const FAQ = [
  ["Qaysi rejimni tanlay?", "Boshlovchi bo'lsangiz — 🇺🇿 Ustoz. O'rta darajada — 🇬🇧 Inglizcha suhbat. Erkin gaplashmoqchi bo'lsangiz — 📞 Jonli suhbat. Dars oynasidagi ⭐ Tavsiya belgisiga qarang."],
  ["Sado meni eshitmayapti", "Telegram'ga mikrofon ruxsatini bering, telefonni yaqin tuting va tinch joyda gapiring. Shovqinli joyda «Bosib gapirish» rejimini tanlang."],
  ["Sado ovozi eshitilmayapti", "Telefon ovozini balandlating va «ovozsiz» rejimni o'chiring. «🔁 Qayta eshitish» tugmasi yoki Sado (maskot)ning o'zini bosib, oxirgi gapni yana tinglashingiz mumkin.", "🔊 Ovozni hozir tekshirish", () => { $("helpSheet").hidden = true; $("setBtn").click(); setTimeout(() => $("soundTest").click(), 150); }],
  ["Ovoz chiqarib gapira olmayman (avtobusda, kutubxonada)", "Dars ekranining pastidagi «✍️ Yozish» tugmasini bosing — javobni yozib yuborasiz. Yozma rejimda ibora kartasini bossangiz, u javob maydoniga o'zi tushadi."],
  ["O'zim xohlagan mavzuda gaplashsam bo'ladimi?", "Ha! Bosh sahifadagi Erkin suhbat bannerida «✏️ O'z mavzuim» tugmasini bosing va istalgan mavzuni yozing — Sado shu mavzuda gaplashadi.", "✏️ Mavzu yozish", () => { $("helpSheet").hidden = true; openTopicSheet(state.topic.startsWith("custom:") ? state.topic.slice(7) : ""); }],
  ["«🔁 Takrorlash» nima?", "Toifalar qatoridagi bu filtr 60 balldan past olingan va 7 kundan beri o'tilmagan darslarni ko'rsatadi. Ularni qayta o'tsangiz, iboralar uzoq muddat esda qoladi."],
  ["Xatolarim qayerda saqlanadi?", "📒 Lug'atim → «✏️ Xatolarim». «🔁 Xatolarim ustida Sado bilan ishlash» darsida to'g'ri aytgan xatoingiz «✅ tuzatildi» bo'ladi.", "📒 Lug'atni ochish", () => { $("helpSheet").hidden = true; $("vocabBtn").hidden ? toast("Lug'at birinchi darsdan keyin paydo bo'ladi") : $("vocabBtn").click(); }],
  ["IELTS/CEFR uchun namunaviy javob bormi?", "Ha! IELTS va CEFR kurslaridagi dars tugagach, hisobot ostida «📝 Namunaviy javob» tugmasi chiqadi: o'sha savol yoki kartochkaga Band 7 / B2 darajadagi javob va foydali iboralar. O'z javobingizni u bilan solishtiring."],
  ["Jonli suhbatda Sado gapini tushunmadim", "Sado gapi yozilgan pufakchani bosing — ostida o'zbekcha tarjimasi chiqadi. Erkin suhbatda mavzu yoqmasa, «🔀 Boshqa mavzu» tugmasini bosing."],
  ["Jonli suhbatda Sado gapini qanday to'xtataman?", "Sado gapirayotganda maskotni (yoki «✋ to'xtatish» yozuvini) bosing — Sado darhol jim bo'ladi va siz gapirasiz. Sado o'z ovozini eshitib chalkashmasligi uchun u gapirayotganda mikrofon vaqtincha eshitmaydi. Javob topa olmay 15 soniya jim qolsangiz, Sado o'zi yordam beradi."],
  ["Iboralarni qanday tez yodlayman?", "Dars oynasida «🎧 Tinglab takrorlash» (🐢 sekin tezlik bilan), dars ekranida «🙈 Yoddan» rejimi (inglizchasi yashirinadi), 📒 Lug'atda «🃏 Kartochkalar», «🎧 Tinglash» va «🧩 Test» (o'zbekchasidan inglizchasini topish)."],
  ["Grammatikani qanday mustahkamlayman?", "Grammatika bo'limidagi «🧪 Testlar» panelida: 📅 Bugungi test (har kuni 5 savol), 📝 Aralash test (daraja yoki «🎯 Tanlash» bilan o'zingiz tanlagan mavzular), ⚡ 60 soniya, 📊 Daraja testi, 📖 Qoidalar (misollarni tinglash bilan) va 🔁 Xatolarim. «🎯 %» ni bosing — qaysi mavzu zaif ekanini ko'rasiz. Har bir darsda ham «🧩 Tez mashq» bor.", "✏️ Grammatika darslari", () => { $("helpSheet").hidden = true; state.filter.cat = "Grammatika gapirib"; renderChips(); renderLessons(); scrollToList(true); }],
  ["O'zbekcha gapirsam bo'ladimi?", "Ha! Sado o'zbekcha tushunadi, o'zbekcha tushuntiradi va buni inglizcha qanday aytishni o'rgatadi."],
  ["Ball qanday qo'yiladi?", "Dars oxirida AI gaplaringizni tahlil qilib 0–100 ball, daraja (CEFR yoki IELTS band), xatolar va maslahatlar beradi."],
  ["Kuniga nechta dars?", "Cheklov yo'q — xohlaganingizcha mashq qiling! Kunlik maqsadni (1–3 dars) bosh sahifadagi «🎯 Bugungi maqsad» blokida yoki ⚙️ Sozlamalarda tanlaysiz."],
  ["Ma'lumotlarim xavfsizmi?", "Ovozingiz dars paytida tahlil uchun AI xizmatlariga (OpenAI, Google, Anthropic) yuboriladi, lekin Sado serverida saqlanmaydi. Serverda faqat ballar, o'tilgan darslar va lug'at saqlanadi."],
];
function renderFaq() {
  const box = $("faq");
  box.innerHTML = "";
  // 🔍 Savollar ichidan qidirish
  const norm = (t) => t.toLowerCase().replace(/[‘’`ʻʼ]/g, "'");
  const search = el("input", "faq-search");
  search.type = "search";
  search.placeholder = "🔍 Savol qidirish: mikrofon, ball, lug'at...";
  const none = el("p", "muted faq-none", "Topilmadi — boshqa so'z bilan qidirib ko'ring.");
  none.hidden = true;
  search.addEventListener("input", () => {
    const q = norm(search.value.trim());
    let n = 0;
    for (const d of box.querySelectorAll(".faq-item")) {
      const hit = !q || norm(d.textContent).includes(q);
      d.hidden = !hit;
      if (hit) n++;
      d.open = Boolean(q) && hit && n === 1; // birinchi topilgani ochiq
    }
    none.hidden = n > 0;
  });
  box.append(search, none);
  for (const [q, a, label, fn] of FAQ) {
    const d = document.createElement("details");
    d.className = "faq-item";
    // Bittasi ochilsa — qolganlari yopiladi (ro'yxat qisqa qoladi)
    d.addEventListener("toggle", () => {
      if (d.open) for (const x of box.querySelectorAll(".faq-item[open]")) if (x !== d) x.open = false;
    });
    const s = document.createElement("summary");
    s.textContent = q;
    d.append(s, el("p", "", a));
    if (label) {
      const b = el("button", "btn ghost faq-act", label);
      b.addEventListener("click", () => {
        haptic();
        fn();
      });
      d.append(b);
    }
    box.append(d);
  }
}
$("helpBtn").addEventListener("click", () => {
  haptic();
  renderFaq();
  $("helpSheet").hidden = false;
});
$("helpClose").addEventListener("click", () => ($("helpSheet").hidden = true));
$("helpSheet").addEventListener("click", (e) => {
  if (e.target.id === "helpSheet") $("helpSheet").hidden = true;
});
$("onbAgain").addEventListener("click", () => {
  $("helpSheet").hidden = true;
  localStorage.removeItem("sado-onb");
  showOnboarding();
});

loadLessons();
