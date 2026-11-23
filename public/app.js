import { Mascot } from "./mascot.js";
import { LiveCall } from "./live.js?v=4";

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
    renderChips();
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

// 60 balldan past darslar — takrorlash uchun
const WEAK = 60;
function weakIds() {
  const ls = state.progress?.lessons || {};
  return Object.keys(ls).filter((id) => id !== "review" && ls[id].best < WEAK && state.lessons.some((l) => l.id === id));
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
    // 🔁 Past ball — takrorlash tavsiya etiladi
    if (pr.best < WEAK) {
      b.classList.add("weak");
      b.querySelector(".lesson-sub").textContent = `🔁 Takrorlang · ${pr.best} ball`;
    }
  }
  b.addEventListener("click", () => openSheet(l));
  return b;
}

// Bo'lim filtrlari (gorizontal chiplar)
// 📖 Qoidadagi inglizcha misollarni ajratib, bosilganda eshittiramiz
const EN_HINT = /\b(I|I'm|you|he|she|it|we|they|is|are|am|do|does|did|will|the|a|an|can|was|were|have|has|my|your|to|used|should|must|there|this|that|any|some|isn't|aren't|wasn't|weren't|don't|doesn't|didn't)\b/i;
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
        speakBrowser(t, "en");
      });
      row.append(ex);
      last = m.index + t.length;
    }
    row.append(document.createTextNode(line.slice(last)));
    box.append(row);
  }
  if (box.querySelector(".rule-ex")) box.append(el("small", "rule-tip", "🔊 Misolni bosing — talaffuzini eshitasiz"));
  return box;
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
  box.append(el("b", "", "📖 Qoida"), ruleBody(lesson.rule));
}
$("ruleBtn").addEventListener("click", () => {
  haptic();
  const box = $("lessonRule");
  box.hidden = !box.hidden;
  $("ruleBtn").classList.toggle("on", !box.hidden);
});

// 🖼 Rasm/jadval topshiriqlari: o'quvchi ko'rib turib gapiradi
function renderVisual(lesson) {
  const box = $("visual");
  const v = lesson?.visual;
  box.hidden = !v;
  box.innerHTML = "";
  if (!v) return;
  if (v.type === "pictures") {
    box.append(el("div", "vis-title", "🖼 Rasmlar"));
    const row = el("div", "vis-pics");
    v.items.forEach((it, i) => {
      const c = el("div", "vis-pic");
      c.append(el("small", "", `${i + 1}-rasm`), el("div", "vis-emoji", it.emoji), el("b", "", it.en), el("span", "", it.uz));
      row.append(c);
    });
    box.append(row);
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
      const top = box.getBoundingClientRect().top + window.scrollY - document.querySelector(".topbar").offsetHeight - 4;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
    box.append(b);
  });
}

// IELTS/CEFR kursidagi birinchi o'tilmagan dars
function nextLesson() {
  const done = state.progress?.lessons || {};
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
  btn.innerHTML = "";
  btn.append(el("b", "", "📒 Lug'atim"), el("small", "", `${n} so'z · ${f} xato ›`));
}
function renderVocab() {
  const fixes = (state.progress?.words || []).filter((w) => w.type === "fix" && w.en);
  $("reviewBtn").hidden = state.vocabTab !== "fix" || fixes.length < 2 || Boolean(state.flash);
  const ul = $("vocabList");
  ul.innerHTML = "";
  const items = (state.progress?.words || []).filter((w) => (state.vocabTab === "fix" ? w.type === "fix" : w.type !== "fix"));
  if (!items.length) ul.append(el("li", "muted", state.vocabTab === "fix" ? "Hozircha xato yo'q 👏" : "Hozircha so'z yo'q"));
  for (const w of items) {
    const li = el("li", "rep-word" + (w.type === "fix" ? " rep-mistake" : ""));
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
  $("vocabCopy").hidden = !items.length || Boolean(state.flash);
}

// 📋 Lug'atni matn ko'rinishida nusxalash (Telegram "Saqlangan xabarlar"ga yoki daftarga)
$("vocabCopy").addEventListener("click", async () => {
  haptic();
  const fix = state.vocabTab === "fix";
  const items = (state.progress?.words || []).filter((w) => (fix ? w.type === "fix" : w.type !== "fix"));
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
  $("vocabCopy").hidden = true;
  $("flashBtn").hidden = true;
  $("reviewBtn").hidden = true;
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
// 🔁 Shaxsiy dars: xatolar asosida (server lessonId "review" bilan tuzadi)
$("reviewBtn").addEventListener("click", () => {
  const fixes = (state.progress?.words || []).filter((w) => w.type === "fix" && w.en).slice(0, 6);
  $("vocabSheet").hidden = true;
  startLesson(
    {
      id: "review",
      title: "Xatolarim ustida ishlash",
      emoji: "🔁",
      level: "Shaxsiy",
      phrases: fixes.map((f) => ({ en: f.en, uz: `Xato edi: ${f.wrong || ""}` })),
    },
    "chat",
  );
});

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
      const when = isNaN(d) ? "" : ` · ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
      info.textContent = `${l?.emoji || "📘"} ${l?.title || "Dars"} — ${r.score} ball${r.level ? ` (${r.level})` : ""}${when}`;
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

// 📊 Natijalar plitkasi: bosilganda grafik va yutuqlar ochiladi
function renderMoreStats() {
  const p = state.progress;
  const btn = $("moreBtn");
  btn.hidden = !p;
  if (!p) return ($("moreStats").hidden = true);
  const open = localStorage.getItem("sado-more") === "1";
  const got = BADGES.filter((b) => b[3](p)).length;
  btn.innerHTML = "";
  btn.append(el("b", "", "📊 Natijalar"), el("small", "", `🏅 ${got}/${BADGES.length} yutuq ${open ? "▴" : "▾"}`));
  btn.classList.toggle("on", open);
  $("moreStats").hidden = !open;
}

// 🌟 Kun iborasi: sanaga qarab har kuni boshqa ibora (hamma uchun bir xil)
function renderDaily() {
  const box = $("daily");
  const pool = state.lessons.filter((l) => !l.liveOnly).flatMap((l) => l.phrases.filter((p) => !p.en.includes("...")).map((p) => ({ p, l })));
  if (!pool.length) return (box.hidden = true);
  const d = new Date();
  const dayNo = Math.floor((d.getTime() + 5 * 3600_000) / 86400_000); // Toshkent vaqti
  const { p, l } = pool[(dayNo * 7919 + (state.dailyOff || 0) * 104729) % pool.length];
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
  const row = el("div", "daily-row");
  row.append(go, more);
  box.append(top, en, el("div", "daily-uz", p.uz), row);
}

// 📅 Haftalik xulosa
function renderWeek() {
  const w = state.progress?.week;
  const box = $("week");
  if (!w || !w.n) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = "";
  box.append(el("b", "", `📅 Bu hafta: ${w.n} ta dars · o'rtacha ${w.avg} ball`));
  if (w.prevAvg != null) {
    const d = w.avg - w.prevAvg;
    box.append(el("span", d > 0 ? "up" : d < 0 ? "down" : "", d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "= barqaror"));
  } else box.append(el("span", "", "birinchi hafta 🌱"));
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
    if (state.filter.cat && !(state.filter.cat === "__fav" ? state.favs.has(l.id) : state.filter.cat === "__weak" ? weakIds().includes(l.id) : l.category === state.filter.cat)) return false;
    if (!q) return true;
    if (norm(l.title + " " + l.category).includes(q)) return true;
    const p = l.phrases.find((x) => norm(x.en + " " + x.uz).includes(q));
    if (p) hits.set(l.id, p);
    return Boolean(p);
  });
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
  const PART_NAMES = { 1: "Part 1 — qisqa savollar", 2: "Part 2 — kartochka (monolog)", 3: "Part 3 — muhokama" };
  let lastCat = null;
  let lastPart = null;
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
      list.append(head);
    }
    const part = l.category === "IELTS kursi" ? partOf(l) : null;
    if (part && part !== lastPart) {
      lastPart = part;
      list.append(el("div", "part-title", PART_NAMES[part]));
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
  // ✏️ Grammatika qoidasi
  $("sheetRule").hidden = !lesson.rule;
  if (lesson.rule) {
    $("sheetRule").innerHTML = "";
    $("sheetRule").append(el("b", "", "📖 Qoida"), ruleBody(lesson.rule));
  }
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
  for (const t of TOPIC_IDEAS) {
    const b = el("button", "chip-f", t);
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
    ["🎚 Ingliz tilim darajasi", [["beg", "🌱 Boshlovchi"], ["mid", "🌿 O'rtacha"], ["adv", "🌳 Yaxshi"]], () => localStorage.getItem("sado-level") || "", (v) => { localStorage.setItem("sado-level", v); renderNext(); }],
    ["🎯 Kunlik maqsad", [["1", "1 dars"], ["2", "2 dars"], ["3", "3 dars"]], () => String(state.goal), (v) => { state.goal = Number(v); localStorage.setItem("sado-goal", v); renderGoal(); }],
    ["🌙 Ko'rinish", [["auto", "Avto"], ["light", "☀️ Kunduzgi"], ["dark", "🌙 Tungi"]], () => localStorage.getItem("sado-theme") || "auto", (v) => { localStorage.setItem("sado-theme", v); applyTheme(); }],
    ["Aa Matn o'lchami", [["0", "Oddiy"], ["1", "Katta"], ["2", "Juda katta"]], () => String((Number(localStorage.getItem("sado-font")) || 0) % 3), (v) => { localStorage.setItem("sado-font", v); applyFont(); }],
  ];
  const box = $("setRows");
  box.innerHTML = "";
  for (const [title, opts, get, set] of rows) {
    const r = el("div", "set-row");
    r.append(el("div", "set-title", title));
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
      for (const k of ["sado-favs", "sado-more"]) localStorage.removeItem(k);
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

// 🎧 Tinglab takrorlash: har bir ibora 2 marta eshittiriladi, orada takrorlash uchun pauza
async function sayPhrase(en) {
  const key = (state.slow ? "slow:" : "") + en;
  let part = sayCache.get(key);
  if (!part) {
    part = await api(`api/say?text=${encodeURIComponent(en)}&slow=${state.slow ? 1 : 0}`, { method: "GET" }).catch(() => null);
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
      const btns = el("div", "shadow-btns");
      btns.append(stop, next);
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
  if (e.target.id === "startSheet") $("startSheet").hidden = true;
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
  renderPhrase();
  renderVisual(lesson);
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
  $("phraseCard").hidden = Boolean(lesson.liveOnly); // Erkin suhbatda ibora kartasi shart emas
  $("chatlog").hidden = false;
  $("chatlog").innerHTML = "";
  $("subsBtn").classList.add("on");
  $("muteBtn").hidden = false;
  $("hintBtn").hidden = false; // 💡 jonli suhbatda ham javob namunalari
  $("lesson").classList.add("is-live");
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
  let connected = false;
  let lastErr = "";
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
        const label = st === "speaking" ? "Sado gapirmoqda..." : st === "muted" ? "🔇 Mikrofon o'chiq" : "Sizni tinglayapti...";
        const phase = st === "muted" ? "idle" : st;
        if (state.phase !== phase || $("statusText").textContent !== label) setPhase(phase, label);
        mascot.setLevel(level);
      },
      onEvent: (m) => {
        if (m.type === "ready") {
          connected = true;
          clearTimeout(state.liveWait);
          startTimer();
          setPhase("speaking", "Sado gapirmoqda...");
        } else if (m.type === "sado" || m.type === "user") {
          if (lastSpeaker !== m.type) addBubble(m.type);
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
    box.append(el("div", "hint-title", live ? "Shulardan birini ovoz chiqarib ayting:" : "Shunday deyishingiz mumkin (bosing — eshitasiz):"));
    for (const h of hints || []) {
      const d = el("div", "hint-item");
      d.append(el("b", "", h.en), el("span", "", h.uz));
      if (!live) d.addEventListener("click", () => speakBrowser(h.en, "en"));
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
  if (who !== "sado" && state.live) clearHints(); // o'quvchi javob berdi — namunalar yopiladi
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
  // ⏳ 1 daqiqa qolganda ogohlantiramiz (jonli suhbatda Sado o'zi yakunlaydi)
  if (l === 60 && state.lessonMode !== "live" && state.seconds > 120) {
    const left = state.lesson ? state.lesson.phrases.length - state.used.size : 0;
    haptic("medium");
    toast(left > 0 ? `⏳ 1 daqiqa qoldi — yana ${left} ta ibora ishlatib ulgurasizmi?` : "⏳ 1 daqiqa qoldi — barcha iboralar bajarildi, zo'r! 🎉", 4000);
  }
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
  $("phraseEn").textContent = p.en.replace(/ (\.\.\.)/g, "\u00a0$1"); // "..." yolg'iz keyingi qatorga tushmasin
  $("phraseUz").textContent = p.uz;
  const done = used.has(state.phraseIdx);
  $("phraseCard").classList.toggle("done", done);
  $("phraseLabel").textContent = done ? "✓ Aytildi" : "Ovoz chiqarib ayting";
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

// ✍️ Yozma rejimda iborani bosish — uni javob maydoniga qo'yadi
$("phraseEn").addEventListener("click", () => {
  if ($("textForm").hidden || !state.lesson) return;
  const p = state.lesson.phrases[state.phraseIdx];
  if (!p) return;
  haptic();
  const inp = $("textInput");
  inp.value = inp.value.trim() ? `${inp.value.trim()} ${p.en}` : p.en;
  inp.focus();
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
  if (state.lessonMode === "live" || $("replayBtn").hidden) return;
  $("replayBtn").click();
});

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
      const b = el("button", "sub-en", x.text);
      b.addEventListener("click", () => {
        haptic();
        speakBrowser(x.text, "en");
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
  $("trBtn").textContent = state.tr ? "🇺🇿 Tarjima ✓" : "🇺🇿 Tarjima";
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
    toast(`✅ Ibora qabul qilindi! (${state.used.size}/${state.lesson.phrases.length})`);
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
  for (const p of c.points) ul.append(el("li", "", p));
  let left = 60;
  $("cueTimer").textContent = "1:00";
  setPhase("idle", "⏳ Tayyorlanish vaqti");
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
    const data = await api("api/end", { json: { session } });
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
    el("div", "cert-s", `${all.length} ta dars · o'rtacha ${avg} ball`),
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
      setTimeout(() => $("chips").scrollIntoView({ block: "start" }), 50);
    });
    box.append(go);
  }
  box.hidden = false;
  confetti();
  haptic("success");
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

// 📤 Natijani Telegram orqali ulashish
$("shareBtn").addEventListener("click", () => {
  const { r, score } = state.lastResult || {};
  const l = state.lesson;
  const sc = r?.score ?? score;
  const text = [
    `🎤 Sado AI bilan ingliz tilida gaplashdim!`,
    `${l.emoji} ${l.title}: ${sc} ball${r?.level ? ` · ${r.level}` : ""}`,
    // Erkin suhbatda iboralar yo'q — "0/0 ta ibora" yozilmasin
    !l.liveOnly && l.phrases.length ? `✅ ${state.used.size}/${l.phrases.length} ta ibora` : "",
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
  right.append(el("div", "rep-level", r.level || ""), el("div", "rep-summary", r.summary_uz || ""));
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
    // 🎯 Eng zaif mezon bo'yicha aniq maslahat va bir bosishda mashq
    const weak = Object.keys(NAMES).filter((k) => Number.isFinite(r.criteria[k])).sort((a, b) => r.criteria[a] - r.criteria[b])[0];
    const ADVICE = {
      fluency: ["To'xtovsiz gapirishni mashq qiling: «Well, ...», «Let me think...» kabi to'ldiruvchilar yordam beradi.", "📞 Erkin suhbatda mashq qilish"],
      vocabulary: ["Bir xil so'zlarni takrorlamang, sinonim ishlating (good → excellent, useful). Lug'atingizni takrorlang.", "📒 Lug'atimni ochish"],
      grammar: ["Zamonlar va savol tuzishdagi xatolar ballni pasaytiradi. Grammatika darslari aynan shu uchun.", "✏️ Grammatika darslariga o'tish"],
      pronunciation: ["So'zlarni aniq va sekinroq ayting. «Tinglab takrorlash» mashqi talaffuzni tez yaxshilaydi.", "🔁 Darsni qayta o'tish"],
    };
    if (weak && ADVICE[weak]) {
      const w = el("div", "crit-weak");
      w.append(el("b", "", `🎯 Eng zaif tomon: ${NAMES[weak]} — ${r.criteria[weak].toFixed(1)}`), el("span", "", ADVICE[weak][0]));
      const go = el("button", "btn ghost wide", ADVICE[weak][1]);
      go.addEventListener("click", () => {
        haptic();
        const free = state.lessons.find((l) => l.liveOnly);
        if (weak === "fluency" && free && state.liveEnabled) return startLesson(free, "live");
        if (weak === "vocabulary") return $("vocabBtn").click();
        if (weak === "grammar") {
          show("home");
          state.filter.cat = "Grammatika gapirib";
          renderChips();
          renderLessons();
          return setTimeout(() => {
            $("chips").scrollIntoView({ block: "start" });
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
    li.classList.add("rep-word"); // bosilganda to'g'ri variant eshittiriladi
    li.addEventListener("click", () => speakBrowser(m.right, "en"));
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
  section("💡 Keyingi safar", r.tips_uz, (t) => el("li", "", t));
  section("📚 Yangi so'zlar", r.new_words, (w) => {
    const li = el("li", "rep-word");
    li.append(el("b", "", w.en), el("span", "muted", " — " + (w.uz || "")));
    li.addEventListener("click", () => speakBrowser(w.en, "en"));
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
  $("cert").hidden = true;
  // ➡️ Kurs ichidagi keyingi dars (IELTS/CEFR kursi, grammatika)
  const course = state.lessons.filter((x) => x.category === lesson.category);
  const idx = course.findIndex((x) => x.id === lesson.id);
  const nxt = /kursi$|Grammatika/.test(lesson.category || "") && idx >= 0 ? course[idx + 1] : null;
  state.nextAfter = nxt || null;
  $("nextBtn").hidden = !nxt;
  if (nxt) $("nextBtn").textContent = `➡️ Keyingi dars: ${nxt.emoji} ${nxt.title.replace(/^\d+\.\s*/, "")}`;
  // Erkin suhbatda iboralar ro'yxati ma'nosiz - yashiramiz
  ul.hidden = Boolean(lesson.liveOnly);
  $("againBtn").textContent = lesson.liveOnly ? "📞 Yana gaplashish" : state.lessonMode === "live" ? "📞 Yana qo'ng'iroq qilish" : "Qaytadan mashq qilish";
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
      for (const [k, label] of [["beg", "🌱 Endi boshlayapman"], ["mid", "🌿 O'rtacha"], ["adv", "🌳 Yaxshi"]]) {
        const b = el("button", "chip-f" + (localStorage.getItem("sado-level") === k ? " on" : ""), label);
        b.addEventListener("click", () => {
          haptic();
          localStorage.setItem("sado-level", k);
          for (const x of row.children) x.classList.toggle("on", x === b);
        });
        row.append(b);
      }
      lv.append(row);
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
    const first = lvl === "beg" ? state.lessons.find((l) => l.id === "cafe")
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

// 🆕 Nima yangi: versiya o'zgarganda bir marta ko'rsatiladi (yangi foydalanuvchiga emas)
const NEWS_VERSION = "2026-11-24";
const NEWS = [
  "✏️ Erkin suhbatda o'z mavzuingizni yozing — Sado shu haqida gaplashadi",
  "✍️ «Yozish» rejimi: ovoz chiqarib bo'lmaydigan joyda yozib javob bering",
  "📝 IELTS Part 2: qaydlar maydoni va gapirish sekundomeri",
  "🖼 CEFR: rasm va jadval topshiriqlari endi ekranda ko'rinadi",
  "📖 Grammatika: qoidani dars davomida ochish, misollarni tinglash",
  "🎯 IELTS hisobotida eng zaif tomon va bir bosishda mashq",
  "🔊 Sozlamalarda ovozni tekshirish, 📋 lug'at va suhbatni nusxalash",
];
function showNews() {
  const seen = localStorage.getItem("sado-news");
  if (seen === NEWS_VERSION) return;
  $("newsList").innerHTML = "";
  for (const n of NEWS) $("newsList").append(el("li", "", n));
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
  ["O'zbekcha gapirsam bo'ladimi?", "Ha! Sado o'zbekcha tushunadi, o'zbekcha tushuntiradi va buni inglizcha qanday aytishni o'rgatadi."],
  ["Ball qanday qo'yiladi?", "Dars oxirida AI gaplaringizni tahlil qilib 0–100 ball, daraja (CEFR yoki IELTS band), xatolar va maslahatlar beradi."],
  ["Kuniga nechta dars?", "Kunlik limit bor — qolgan darslar soni bosh sahifadagi «Bugungi maqsad» blokida ko'rinadi. Limit har kuni yangilanadi."],
  ["Ma'lumotlarim xavfsizmi?", "Ovozingiz dars paytida tahlil uchun AI xizmatlariga (OpenAI, Google, Anthropic) yuboriladi, lekin Sado serverida saqlanmaydi. Serverda faqat ballar, o'tilgan darslar va lug'at saqlanadi."],
];
function renderFaq() {
  const box = $("faq");
  box.innerHTML = "";
  for (const [q, a, label, fn] of FAQ) {
    const d = document.createElement("details");
    d.className = "faq-item";
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
