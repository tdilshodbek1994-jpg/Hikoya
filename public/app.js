import { Mascot } from "./mascot.js";
import { LiveCall } from "./live.js?v=3";

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
  mode: localStorage.getItem("sado-mode") || "auto",
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
  const dark = inTelegram ? tg.colorScheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
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

async function api(path, { json, body, headers = {}, method = "POST" } = {}) {
  const h = { "X-Telegram-Init-Data": tg?.initData || "", ...headers };
  if (json) h["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: json ? JSON.stringify(json) : body });
  } catch {
    throw Object.assign(new Error("Internet bilan aloqa yo'q 📶"), { network: true });
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
  const back = id !== "home" || canExit;
  if (inTelegram) back ? tg.BackButton.show() : tg.BackButton.hide();
  else $("backBtn").hidden = !back;
  window.scrollTo(0, 0);
}

$("backBtn").addEventListener("click", () => onBack());

function onBack() {
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
async function loadLessons() {
  try {
    const data = await api("api/lessons", { method: "GET" });
    state.lessons = data.lessons;
    state.voiceEnabled = data.voiceEnabled;
    state.liveEnabled = Boolean(data.liveEnabled);
    state.sessionMinutes = data.sessionMinutes;
    state.shareUrl = data.shareUrl || "";
    renderChips();
    renderLessons();
    loadProgress();
    if (!inTelegram) $("homeNote").textContent = "Eslatma: ilova Telegram bot orqali ochilganda to'liq ishlaydi.";
  } catch (e) {
    $("lessonList").innerHTML = "";
    $("homeNote").textContent = "Darslarni yuklab bo'lmadi. Internetni tekshiring.";
  }
}

async function loadProgress() {
  try {
    state.progress = await api("api/progress", { method: "GET" });
    renderLessons();
  } catch {
    // Telegram'siz ochilgan bo'lsa progress ko'rsatilmaydi
  }
}

// 🎯 Kunlik maqsad: bugun nechta dars (maqsadni bosib 1 → 2 → 3 ga almashtirish mumkin)
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
  if (pr) {
    b.classList.add("done");
    b.querySelector(".lesson-sub").textContent = `✅ O'tildi · ${pr.best} ball`;
  }
  b.addEventListener("click", () => openSheet(l));
  return b;
}

// Bo'lim filtrlari (gorizontal chiplar)
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
    const all = state.lessons.filter((l) => !l.liveOnly);
    const fresh = all.filter((l) => !done[l.id]);
    const pool = fresh.length ? fresh : all;
    openSheet(pool[Math.floor(Math.random() * pool.length)]);
  });
  box.append(rnd);
  const favChip = state.favs.size ? [["__fav", `⭐ Sevimlilar (${state.favs.size})`]] : [];
  if (!state.favs.size && state.filter.cat === "__fav") state.filter.cat = "";
  [["", "📚 Hammasi"], ...favChip, ...cats.map((c) => [c, `${CAT_ICONS[c] || "📚"} ${c}`])].forEach(([c, label]) => {
    const b = el("button", "chip-f" + (state.filter.cat === c ? " on" : ""), label);
    b.addEventListener("click", () => {
      haptic();
      state.filter.cat = c;
      renderChips();
      box.querySelector(".chip-f.on")?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      renderLessons();
      $("lessonList").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    box.append(b);
  });
}

// IELTS/CEFR kursidagi birinchi o'tilmagan dars
function nextLesson() {
  const done = state.progress?.lessons || {};
  for (const cat of ["IELTS kursi", "CEFR kursi"]) {
    const list = state.lessons.filter((l) => l.category === cat);
    if (list.some((l) => done[l.id])) {
      const n = list.find((l) => !done[l.id]);
      if (n) return n;
    }
  }
  return state.lessons.find((l) => l.category === "IELTS kursi" && !done[l.id]) || null;
}

function renderNext() {
  const box = $("nextBox");
  const n = state.filter.q || state.filter.cat ? null : nextLesson();
  if (!n) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  const started = Object.keys(state.progress?.lessons || {}).length > 0;
  box.append(el("div", "next-label", started ? "➡️ Keyingi dars" : "🚀 Shu yerdan boshlang"));
  box.append(lessonButton(n));
}

// 📒 Lug'atim
state.vocabTab = "word";
function renderVocabBtn() {
  const words = state.progress?.words || [];
  const btn = $("vocabBtn");
  btn.hidden = !words.length;
  const n = words.filter((w) => w.type !== "fix").length;
  const f = words.length - n;
  btn.textContent = `📒 Mening lug'atim · ${n} ta so'z · ${f} ta xato  ›`;
}
function renderVocab() {
  const ul = $("vocabList");
  ul.innerHTML = "";
  const items = (state.progress?.words || []).filter((w) => (state.vocabTab === "fix" ? w.type === "fix" : w.type !== "fix"));
  if (!items.length) ul.append(el("li", "muted", state.vocabTab === "fix" ? "Hozircha xato yo'q 👏" : "Hozircha so'z yo'q"));
  for (const w of items) {
    const li = el("li", "rep-word");
    if (w.type === "fix") {
      const line = el("div", "");
      line.append(el("s", "rep-wrong", w.wrong || ""), document.createTextNode(" → "), el("b", "rep-right", w.en));
      li.append(line, el("div", "rep-why", w.uz || ""));
    } else {
      li.append(el("b", "", w.en), el("span", "muted", " — " + (w.uz || "")));
    }
    li.addEventListener("click", () => speakBrowser(w.en, "en"));
    ul.append(li);
  }
}
$("vocabBtn").addEventListener("click", () => {
  haptic();
  renderVocab();
  $("vocabSheet").hidden = false;
});
$("vocabClose").addEventListener("click", () => {
  $("vocabSheet").hidden = true;
  stopFlash();
});

// 🃏 Kartochka mashqi: o'zbekchasi ko'rsatiladi, inglizchasini eslash kerak
function stopFlash() {
  state.flash = null;
  $("flash").hidden = true;
  $("vocabList").hidden = false;
  $("flashBtn").hidden = false;
}
function startFlash() {
  const words = (state.progress?.words || []).filter((w) => w.en && w.uz);
  if (!words.length) return toast("Lug'atda hali so'z yo'q");
  const deck = words.map((w) => w).sort(() => Math.random() - 0.5).slice(0, 10);
  state.flash = { deck, i: 0, known: 0, open: false };
  $("vocabList").hidden = true;
  $("flashBtn").hidden = true;
  $("flash").hidden = false;
  renderFlash();
}
function renderFlash() {
  const f = state.flash;
  const box = $("flash");
  box.innerHTML = "";
  if (f.i >= f.deck.length) {
    box.append(
      el("div", "flash-done", `${f.known >= f.deck.length * 0.7 ? "🎉" : "💪"} ${f.deck.length} tadan ${f.known} tasini bildingiz!`),
    );
    const again = el("button", "btn primary wide", "🔁 Yana bir marta");
    again.addEventListener("click", startFlash);
    const back = el("button", "btn ghost wide", "Lug'atga qaytish");
    back.addEventListener("click", stopFlash);
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
      speakBrowser(w.en, "en");
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
    f.i++;
    f.open = false;
    renderFlash();
  }
}
$("flashBtn").addEventListener("click", () => {
  haptic();
  startFlash();
});
$("vocabSheet").addEventListener("click", (e) => {
  if (e.target.id === "vocabSheet") $("vocabSheet").hidden = true;
});
for (const b of document.querySelectorAll(".vocab-tabs .chip-f")) {
  b.addEventListener("click", () => {
    state.vocabTab = b.dataset.t;
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
  for (const r of recent) {
    const l = state.lessons.find((x) => x.id === r.lessonId);
    const col = el("div", "tb");
    const bar = el("i", r.score >= 70 ? "hi" : r.score >= 45 ? "mid" : "lo");
    bar.style.height = `${Math.max(8, r.score)}%`;
    col.append(el("em", "", String(r.score)), el("span", "tb-track", ""), el("small", "", l?.emoji || "📘"));
    col.querySelector(".tb-track").append(bar);
    col.title = `${l?.title || ""} · ${r.level || ""}`;
    bars.append(col);
  }
  box.append(bars);
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
];
function renderBadges() {
  const p = state.progress;
  const box = $("badges");
  if (!p) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  const got = BADGES.filter((b) => b[3](p)).length;
  const head = el("div", "trend-head");
  head.append(el("b", "", "🏅 Yutuqlar"), el("span", "", `${got} / ${BADGES.length}`));
  box.append(head);
  const row = el("div", "badge-row");
  for (const [ico, name, how, test] of BADGES) {
    const on = test(p);
    const b = el("button", "badge" + (on ? " on" : ""));
    b.append(el("span", "badge-ico", ico), el("small", "", name));
    b.addEventListener("click", () => toast(on ? `🏅 ${name} — qo'lga kiritilgan!` : `🔒 ${name}: ${how}`, 2500));
    row.append(b);
  }
  box.append(row);
}

function renderMoreStats() {
  const p = state.progress;
  const box = $("moreStats");
  box.hidden = !p;
  if (!p) return;
  const got = BADGES.filter((b) => b[3](p)).length;
  $("moreStatsHint").textContent = `🏅 ${got}/${BADGES.length}`;
  if (!box.dataset.init) {
    box.dataset.init = "1";
    box.open = localStorage.getItem("sado-more") === "1";
    box.addEventListener("toggle", () => localStorage.setItem("sado-more", box.open ? "1" : "0"));
  }
}

// 🌟 Kun iborasi: sanaga qarab har kuni boshqa ibora (hamma uchun bir xil)
function renderDaily() {
  const box = $("daily");
  const pool = state.lessons.filter((l) => !l.liveOnly).flatMap((l) => l.phrases.filter((p) => !p.en.includes("...")).map((p) => ({ p, l })));
  if (!pool.length) return (box.hidden = true);
  const d = new Date();
  const dayNo = Math.floor((d.getTime() + 5 * 3600_000) / 86400_000); // Toshkent vaqti
  const { p, l } = pool[(dayNo * 7919) % pool.length];
  box.hidden = false;
  box.innerHTML = "";
  const top = el("div", "daily-top");
  top.append(el("span", "daily-tag", "🌟 Kun iborasi"), el("span", "daily-from", `${l.emoji} ${l.title.replace(/^\d+\.\s*/, "")}`));
  const en = el("button", "daily-en", p.en + "  🔊");
  en.addEventListener("click", () => {
    haptic();
    speakBrowser(p.en, "en");
  });
  const go = el("button", "daily-go", "Shu darsni ochish ›");
  go.addEventListener("click", () => openSheet(l));
  box.append(top, en, el("div", "daily-uz", p.uz), go);
}

function renderLessons() {
  renderDaily();
  renderGoal();
  renderMoreStats();
  renderBadges();
  renderStats();
  renderVocabBtn();
  renderTrend();
  renderNext();
  const list = $("lessonList");
  list.innerHTML = "";
  const q = state.filter.q.trim().toLowerCase();
  const items = state.lessons.filter(
    (l) =>
      !l.liveOnly &&
      (!state.filter.cat || (state.filter.cat === "__fav" ? state.favs.has(l.id) : l.category === state.filter.cat)) &&
      (!q || (l.title + " " + l.category + " " + l.phrases.map((p) => p.en + " " + p.uz).join(" ")).toLowerCase().includes(q)),
  );
  if (!items.length) {
    list.append(el("p", "note", "Hech narsa topilmadi. Boshqa so'z bilan qidirib ko'ring."));
    return;
  }
  const done = state.progress?.lessons || {};
  const partOf = (l) => (l.id.match(/^ielts-p(\d)/) || [])[1];
  const PART_NAMES = { 1: "Part 1 — qisqa savollar", 2: "Part 2 — kartochka (monolog)", 3: "Part 3 — muhokama" };
  let lastCat = null;
  let lastPart = null;
  for (const l of items) {
    if (l.category && l.category !== lastCat) {
      lastCat = l.category;
      lastPart = null;
      const head = el("div", "cat-title", `${CAT_ICONS[l.category] || "📚"} ${l.category}`);
      // Kurslar uchun progress: nechta dars o'tilgani
      if (/kursi$|Grammatika/.test(l.category)) {
        const all = state.lessons.filter((x) => x.category === l.category);
        const n = all.filter((x) => done[x.id]).length;
        const bar = el("span", "cat-progress");
        bar.append(el("i", ""), el("em", "", `${n}/${all.length}`));
        bar.firstChild.style.width = `${Math.round((n / all.length) * 100)}%`;
        head.append(bar);
      }
      list.append(head);
    }
    const part = l.category === "IELTS kursi" ? partOf(l) : null;
    if (part && part !== lastPart) {
      lastPart = part;
      list.append(el("div", "part-title", PART_NAMES[part]));
    }
    list.appendChild(lessonButton(l));
  }
}

function openSheet(lesson) {
  $("startLiveBtn").hidden = !state.liveEnabled;
  // Erkin suhbat faqat jonli rejimda bo'ladi
  $("startTutorBtn").hidden = Boolean(lesson.liveOnly) && state.liveEnabled;
  $("startChatBtn").hidden = Boolean(lesson.liveOnly) && state.liveEnabled;
  haptic();
  state.pendingLesson = lesson;
  $("sheetEmoji").textContent = lesson.emoji;
  renderFavBtn(lesson);
  $("sheetTitle").textContent = lesson.title;
  // Daraja, iboralar soni va oldingi natija
  const meta = $("sheetMeta");
  meta.innerHTML = "";
  meta.append(el("span", "pill", `📊 ${lesson.level}`), el("span", "pill", `🗂️ ${lesson.phrases.length} ta ibora`), el("span", "pill", `⏱️ ${lesson.minutes || state.sessionMinutes} daq`));
  const pr = state.progress?.lessons?.[lesson.id];
  if (pr) meta.append(el("span", "pill ok", `✅ ${pr.best} ball · ${pr.count} marta`));
  const ul = $("sheetPhrases");
  ul.innerHTML = "";
  const render = (all) => {
    ul.innerHTML = "";
    for (const p of all ? lesson.phrases : lesson.phrases.slice(0, 3)) {
      const li = el("li", "", p.en);
      li.append(el("span", "", p.uz));
      li.addEventListener("click", () => speakBrowser(p.en.replace(/\.\.\./g, "something"), "en"));
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
}

$("goal").addEventListener("click", () => {
  haptic();
  state.goal = (state.goal % 3) + 1;
  localStorage.setItem("sado-goal", String(state.goal));
  renderGoal();
  toast(`🎯 Yangi maqsad: kuniga ${state.goal} ta dars`, 2000);
});

let searchT;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    state.filter.q = e.target.value;
    renderLessons();
  }, 150);
});

// 🗣 Jonli suhbat ovozi: ayol yoki erkak
state.voice = localStorage.getItem("sado-voice") || "f";
function renderVoicePick() {
  const box = $("voicePick");
  box.innerHTML = "";
  box.append(el("span", "vp-label", "Sado ovozi:"));
  for (const [v, label] of [["f", "👩 Ayol"], ["m", "👨 Erkak"]]) {
    const b = el("span", "vp" + (state.voice === v ? " on" : ""), label);
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // bannerni bosgandek qo'ng'iroq boshlanmasin
      haptic();
      state.voice = v;
      localStorage.setItem("sado-voice", v);
      renderVoicePick();
    });
    box.append(b);
  }
}
renderVoicePick();

$("freeHero").addEventListener("click", () => {
  const free = state.lessons.find((l) => l.liveOnly);
  if (!free) return;
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

$("cancelBtn").addEventListener("click", () => ($("startSheet").hidden = true));
$("startSheet").addEventListener("click", (e) => {
  if (e.target.id === "startSheet") $("startSheet").hidden = true;
});
$("startLiveBtn").addEventListener("click", () => startLesson(state.pendingLesson, "live"));
$("startTutorBtn").addEventListener("click", () => startLesson(state.pendingLesson, "tutor"));
$("startChatBtn").addEventListener("click", () => startLesson(state.pendingLesson, "chat"));
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
    toast("Mikrofonga ruxsat berilmadi. Hozircha yozib javob bering.", 3500);
  }
}

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
  state.used = new Set();
  state.phraseIdx = 0;
  state.session = null;

  show("lesson");
  $("lessonTitle").textContent = lesson.title;
  renderPhrase();
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
      json: { lessonId: lesson.id, translate: state.tr, mode: state.lessonMode, slow: state.slow },
    });
    state.session = data.session;
    if (Number.isInteger(data.current)) {
      state.phraseIdx = data.current;
      renderPhrase();
    }
    state.seconds = state.left = data.seconds;
    startTimer();
    setSubs(data.reply, data.reply_uz, "", "");
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
  // Jonli rejimda tugmalar kerak emas: shunchaki gaplashiladi
  $("modeToggle").hidden = true;
  $("holdBtn").hidden = true;
  $("textForm").hidden = true;
  $("trBtn").hidden = true;
  $("slowBtn").hidden = true;
  $("subs").hidden = true; // jonli rejimda suhbat tarixi (chatlog) ko'rsatiladi
  $("listenBtn").hidden = true; // qo'ng'iroq paytida ibora ijrosi xalaqit beradi
  $("phraseCard").hidden = Boolean(lesson.liveOnly); // Erkin suhbatda ibora kartasi shart emas
  $("chatlog").hidden = false;
  $("chatlog").innerHTML = "";
  $("subsBtn").classList.add("on");
  $("muteBtn").hidden = false;
  $("hintBtn").hidden = true;
  $("replayBtn").hidden = true;
  clearHints();
  setMuteUi(false);
  setSubs("", "", "", "");
  setPhase("thinking", "Ulanmoqda...");
  $("hint").textContent = "Shunchaki gapiring. Sado gapirayotganda gapini bo'lishingiz ham mumkin.";

  ensureCtx();
  let sadoLine = "";
  let userLine = "";
  let lastSpeaker = "";
  try {
    const data = await api("api/session", { json: { lessonId: lesson.id, mode: "live" } });
    if (data.mode !== "live") throw new Error("Jonli suhbat serverda yoqilmagan.");
    state.session = data.session;
    state.seconds = state.left = data.seconds;

    const call = new LiveCall({
      ctx: audio.ctx,
      outAnalyser: audio.outAnalyser,
      onState: (st, level) => {
        if (state.phase === "ended") return;
        const label = st === "speaking" ? "Sado gapirmoqda..." : st === "muted" ? "🔇 Mikrofon o'chiq" : "Sizni tinglayapti...";
        const phase = st === "muted" ? "idle" : st;
        if (state.phase !== phase || $("statusText").textContent !== label) setPhase(phase, label);
        mascot.setLevel(level);
      },
      onEvent: (m) => {
        if (m.type === "ready") {
          startTimer();
          setPhase("speaking", "Sado gapirmoqda...");
        } else if (m.type === "sado" || m.type === "user") {
          if (lastSpeaker !== m.type) addBubble(m.type);
          lastSpeaker = m.type;
          appendBubble(m.text);
        } else if (m.type === "wrapup") {
          toast("⏳ 1 daqiqa qoldi — Sado suhbatni yakunlaydi", 4000);
          haptic("medium");
        } else if (m.type === "used") {
          markUsed(m.found || []);
        } else if (m.type === "error") {
          toast("⚠️ " + m.message, 4000);
        } else if (m.type === "closed") {
          if (state.phase !== "ended") finish();
        }
      },
    });
    state.live = call;
    await call.start(data.session, tg?.initData || "", state.voice);
  } catch (e) {
    console.warn("Jonli:", e);
    state.live?.stop();
    state.live = null;
    setPhase("idle", "");
    toast(e.name === "NotAllowedError" ? "Mikrofonga ruxsat bering." : e.message || "Jonli suhbatni boshlab bo'lmadi.", 4000);
    show("home");
  }
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
    box.append(el("div", "hint-title", "Shunday deyishingiz mumkin (bosing — eshitasiz):"));
    for (const h of hints || []) {
      const d = el("div", "hint-item");
      d.append(el("b", "", h.en), el("span", "", h.uz));
      d.addEventListener("click", () => speakBrowser(h.en, "en"));
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
  $("phraseCard").hidden = false;
}

function setMuteUi(m) {
  $("muteBtn").classList.toggle("muted", m);
  $("muteBtn").textContent = m ? "🔇 Mikrofon o'chiq — yoqish uchun bosing" : "🎙️ Mikrofon yoqiq — o'chirish uchun bosing";
}

$("muteBtn").addEventListener("click", () => {
  if (!state.live) return;
  haptic("medium");
  const m = !state.live.muted;
  state.live.setMuted(m);
  setMuteUi(m);
});

// Jonli suhbat tarixi: Sado va o'quvchi gaplari pufakchalarda
function addBubble(who) {
  const log = $("chatlog");
  const b = el("div", "bubble " + (who === "sado" ? "b-sado" : "b-me"));
  b.append(el("small", "", who === "sado" ? "Sado" : "Siz"), el("span", "", ""));
  log.append(b);
  while (log.children.length > 40) log.firstChild.remove();
}
function appendBubble(text) {
  const log = $("chatlog");
  const last = log.lastElementChild;
  if (!last) return;
  last.lastElementChild.textContent += text;
  log.scrollTop = log.scrollHeight;
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
}

function renderPhrase() {
  const { lesson, used } = state;
  const seg = $("segments");
  seg.innerHTML = "";
  lesson.phrases.forEach((_, i) => {
    const el = document.createElement("i");
    if (used.has(i)) el.className = "done";
    else if (i === state.phraseIdx) el.className = "current";
    seg.appendChild(el);
  });
  $("countText").textContent = `${lesson.phrases.length} tadan ${used.size} ta ibora`;
  const p = lesson.phrases[state.phraseIdx];
  $("phraseEn").textContent = p.en;
  $("phraseUz").textContent = p.uz;
  const done = used.has(state.phraseIdx);
  $("phraseCard").classList.toggle("done", done);
  $("phraseLabel").textContent = done ? "✓ Aytildi" : "Ovoz chiqarib ayting";
}

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

function setSubs(ai, aiUz, me, fix) {
  $("subAi").textContent = ai || "";
  $("subAiUz").textContent = aiUz || "";
  $("subMe").textContent = me || "";
  $("subMeWrap").hidden = !me;
  $("subFix").textContent = fix || "";
  $("subFixWrap").hidden = !fix;
}

// ---------------- Rejimlar ----------------
function applyMode() {
  for (const b of document.querySelectorAll(".mode")) b.classList.toggle("active", b.dataset.mode === state.mode);
  const text = state.textOnly;
  $("modeToggle").hidden = text;
  $("textForm").hidden = !text;
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
  localStorage.setItem("sado-mode", state.mode);
  applyMode();
  if (state.phase === "listening" && state.mode === "hold") {
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
  $("trBtn").textContent = state.tr ? "🇺🇿 Tarjima ✓" : "🇺🇿 Tarjima";
}
$("trBtn").addEventListener("click", () => {
  haptic();
  state.tr = !state.tr;
  localStorage.setItem("sado-tr", state.tr ? "1" : "0");
  applyTr();
  toast(state.tr ? "Sado gaplarining o'zbekcha tarjimasini ham aytadi" : "Sado faqat inglizcha gapiradi (xatolar baribir o'zbekcha tushuntiriladi)", 3000);
});

function applySubs() {
  $("subs").hidden = !state.subs;
  $("subsBtn").classList.toggle("on", state.subs);
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
    rec.onstop = () => {
      const type = rec.mimeType || audio.mime || "audio/webm";
      resolve(new Blob(audio.chunks, { type }));
    };
    rec.stop();
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
  const meter = () => {
    if (state.phase !== "listening") return;
    mascot.setLevel(Math.min(1, rms(audio.micAnalyser, buf) * 9));
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
  await sendTurn({ body: blob, headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" } });
}

$("textForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("textInput").value.trim();
  if (!text || state.phase === "thinking" || state.phase === "speaking") return;
  $("textInput").value = "";
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
    setSubs(data.reply, data.reply_uz, data.heard, data.uz_say);
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
  if (state.lessonMode === "tutor" && !state.textOnly) {
    $("hint").textContent = "Sado aytgan iborani takrorlang yoki o'zbekcha so'rang.";
    return;
  }
  $("hint").textContent = state.textOnly
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
    toast(`✅ Ibora qabul qilindi! (${state.used.size}/${state.lesson.phrases.length})`);
  }
}

async function afterReply() {
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
  // Android: mikrofon yoqiq tursa ovoz "qo'ng'iroq" rejimida (quloq dinamigidan, juda past) chiqadi.
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
        toast("⚠️ Telefon ovozni ijro etmadi: " + (e?.name || e), 5000);
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
  showResult();
  if (!session) return;
  $("report").hidden = false;
  $("report").innerHTML = '<div class="rep-loading"><span class="spin"></span>Sado hisobot tayyorlamoqda...</div>';
  try {
    const data = await api("api/end", { json: { session } });
    if (data.progress) {
      state.progress = data.progress;
      renderLessons();
    }
    renderReport(data.report, data.score);
    renderTranscript(data.transcript);
  } catch {
    $("report").hidden = true;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 📜 Suhbat matni
function renderTranscript(list) {
  const box = $("transcript");
  const log = $("trLog");
  log.innerHTML = "";
  const items = (list || []).filter((t) => t.text && t.text.trim());
  box.hidden = !items.length;
  box.open = false;
  for (const t of items) {
    const b = el("div", "bubble " + (t.who === "sado" ? "b-sado" : "b-me"));
    b.append(el("small", "", t.who === "sado" ? "Sado" : "Siz"), el("span", "", t.text.trim()));
    log.append(b);
  }
}

// 📤 Natijani Telegram orqali ulashish
$("shareBtn").addEventListener("click", () => {
  const { r, score } = state.lastResult || {};
  const l = state.lesson;
  const sc = r?.score ?? score;
  const text = [
    `🎤 Sado AI bilan ingliz tilida gaplashdim!`,
    `${l.emoji} ${l.title}: ${sc} ball${r?.level ? ` · ${r.level}` : ""}`,
    `✅ ${state.used.size}/${l.phrases.length} ta ibora`,
    state.progress?.streak ? `🔥 ${state.progress.streak} kunlik seriya` : "",
    `Sen ham sinab ko'r 👇`,
  ].filter(Boolean).join("\n");
  const url = state.shareUrl || "https://t.me";
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  haptic();
  if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
  else if (navigator.share) navigator.share({ text: text + (state.shareUrl ? "\n" + state.shareUrl : "") }).catch(() => {});
  else window.open(link, "_blank");
});

// 📝 AI hisobot: ball, daraja, xatolar, maslahatlar, yangi so'zlar
function renderReport(r, score) {
  const box = $("report");
  box.innerHTML = "";
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
  const right = el("div", "rep-top-text");
  right.append(el("div", "rep-level", r.level || ""), el("div", "rep-summary", r.summary_uz || ""));
  top.append(ring, right);
  box.append(top);

  const section = (title, items, render) => {
    if (!items || !items.length) return;
    box.append(el("div", "rep-title", title));
    const ul = el("ul", "rep-list");
    items.forEach((it) => ul.append(render(it)));
    box.append(ul);
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
      row.append(el("span", "crit-name", name), bar, el("b", "", v.toFixed(1)));
      box2.append(row);
    }
    box.append(el("div", "rep-title", "📊 IELTS mezonlari"), box2);
  }
  section("👍 Yaxshi chiqdi", r.strengths_uz, (t) => el("li", "", t));
  section("✏️ Xatolar ustida ishlaymiz", r.mistakes, (m) => {
    const li = el("li", "rep-mistake");
    const line = el("div", "");
    line.append(el("s", "rep-wrong", m.wrong), document.createTextNode(" → "), el("b", "rep-right", m.right));
    li.append(line, el("div", "rep-why", m.why_uz || ""));
    return li;
  });
  section("💡 Keyingi safar", r.tips_uz, (t) => el("li", "", t));
  if ((r.new_words || []).length || (r.mistakes || []).length)
    box.append(el("div", "rep-saved", "📒 Yangi so'zlar va xatolar lug'atingizga saqlandi"));
  section("📚 Yangi so'zlar", r.new_words, (w) => {
    const li = el("li", "rep-word");
    li.append(el("b", "", w.en), el("span", "muted", " — " + (w.uz || "")));
    li.addEventListener("click", () => speakBrowser(w.en, "en"));
    return li;
  });
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
  lesson.phrases.forEach((p, i) => {
    const li = document.createElement("li");
    if (used.has(i)) li.className = "ok";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = used.has(i) ? "✓" : "";
    const div = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = p.en;
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = p.uz;
    div.append(b, s);
    li.append(mark, div);
    ul.appendChild(li);
  });
  $("report").hidden = true;
  $("report").innerHTML = "";
  $("shareBtn").hidden = true;
  $("transcript").hidden = true;
  // ➡️ Kurs ichidagi keyingi dars (IELTS/CEFR kursi, grammatika)
  const course = state.lessons.filter((x) => x.category === lesson.category);
  const idx = course.findIndex((x) => x.id === lesson.id);
  const nxt = /kursi$|Grammatika/.test(lesson.category || "") && idx >= 0 ? course[idx + 1] : null;
  state.nextAfter = nxt || null;
  $("nextBtn").hidden = !nxt;
  if (nxt) $("nextBtn").textContent = `➡️ Keyingi dars: ${nxt.emoji} ${nxt.title.replace(/^\d+\.\s*/, "")}`;
  // Erkin suhbatda iboralar ro'yxati ma'nosiz - yashiramiz
  ul.hidden = Boolean(lesson.liveOnly);
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
loadLessons();
