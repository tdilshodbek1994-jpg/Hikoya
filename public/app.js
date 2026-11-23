import { Mascot } from "./mascot.js";

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
  if (tg.colorScheme === "dark") document.body.classList.add("dark");
  try {
    const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
  } catch {}
  tg.BackButton?.onClick(() => onBack());
}

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
  const res = await fetch(path, { method, headers: h, body: json ? JSON.stringify(json) : body });
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
    state.sessionMinutes = data.sessionMinutes;
    renderLessons();
    if (!inTelegram) $("homeNote").textContent = "Eslatma: ilova Telegram bot orqali ochilganda to'liq ishlaydi.";
  } catch (e) {
    $("lessonList").innerHTML = "";
    $("homeNote").textContent = "Darslarni yuklab bo'lmadi. Internetni tekshiring.";
  }
}

function renderLessons() {
  const list = $("lessonList");
  list.innerHTML = "";
  for (const l of state.lessons) {
    const b = document.createElement("button");
    b.className = "lesson";
    b.innerHTML = `
      <div class="lesson-emoji"></div>
      <div class="lesson-info"><div class="lesson-title"></div><div class="lesson-sub"></div></div>
      <span class="lesson-level"></span>`;
    b.querySelector(".lesson-emoji").textContent = l.emoji;
    b.querySelector(".lesson-title").textContent = l.title;
    b.querySelector(".lesson-sub").textContent = `${l.phrases.length} ta ibora · ${state.sessionMinutes} daqiqa`;
    b.querySelector(".lesson-level").textContent = l.level;
    b.addEventListener("click", () => openSheet(l));
    list.appendChild(b);
  }
}

function openSheet(lesson) {
  haptic();
  state.pendingLesson = lesson;
  $("sheetEmoji").textContent = lesson.emoji;
  $("sheetTitle").textContent = lesson.title;
  const ul = $("sheetPhrases");
  ul.innerHTML = "";
  for (const p of lesson.phrases.slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = p.en;
    const s = document.createElement("span");
    s.textContent = p.uz;
    li.appendChild(s);
    ul.appendChild(li);
  }
  $("startSheet").hidden = false;
}

$("cancelBtn").addEventListener("click", () => ($("startSheet").hidden = true));
$("startSheet").addEventListener("click", (e) => {
  if (e.target.id === "startSheet") $("startSheet").hidden = true;
});
$("startBtn").addEventListener("click", () => startLesson(state.pendingLesson));
$("againBtn").addEventListener("click", () => startLesson(state.lesson));
$("homeBtn").addEventListener("click", () => show("home"));

// ---------------- Audio tayyorlash ----------------
function pickMime() {
  if (!window.MediaRecorder) return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
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
async function startLesson(lesson) {
  if (!lesson) return;
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
  setSubs("", "", "", "");
  setPhase("thinking", "Tayyorlanmoqda...");
  $("hint").textContent = "";

  await ensureAudio();
  applyMode();

  try {
    const data = await api("api/session", { json: { lessonId: lesson.id, translate: state.tr } });
    state.session = data.session;
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

function applyTr() {
  $("trBtn").classList.toggle("on", state.tr);
  $("trBtn").textContent = state.tr ? "🇺🇿 Tarjima: yoqiq" : "🇺🇿 Tarjima: o'chiq";
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

async function sendTurn(payload) {
  if (!state.session) return;
  setPhase("thinking");
  try {
    const data = await api(
      `api/turn?session=${encodeURIComponent(state.session)}&tr=${state.tr ? 1 : 0}`,
      payload,
    );
    if (state.phase === "ended") return;
    if (data.empty) {
      $("hint").textContent = "Eshitmadim, yana bir bor ayting.";
      return afterReply();
    }
    applyHint();
    setSubs(data.reply, data.reply_uz, data.heard, data.uz_say);
    if (data.uz_say && !state.subs) toast("🇺🇿 " + data.uz_say, 6000);
    markUsed(data.used || []);
    if (data.mood) mascot.setMood(data.mood);
    await playReply(data.parts, data.reply);
    afterReply();
  } catch (e) {
    if (state.phase === "ended") return;
    toast(e.message, 3500);
    if (e.status === 404 || e.status === 410) return finish();
    afterReply();
  }
}

function applyHint() {
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
  if (!parts.some((p) => p.audio)) toast("⚠️ Ovoz serverdan kelmadi (TTS)", 4000);
  setPhase("speaking");
  for (const p of parts) {
    if (state.phase !== "speaking") break; // dars tugatilgan bo'lsa
    $("statusText").textContent = p.lang === "uz" ? "Sado tushuntirmoqda..." : "Sado gapirmoqda...";
    try {
      if (p.audio) await playMp3(p.audio);
      else await speakBrowser(p.text, p.lang);
    } catch (e) {
      console.warn("Ijro:", e);
      toast("⚠️ Ijro xatosi: " + (e?.message || e), 5000);
    }
  }
  mascot.setLevel(0);
}

async function playMp3(b64) {
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
    return playViaElement(b64);
  }
  if (audio.ctx.state !== "running") {
    toast("ℹ️ Audio holati: " + audio.ctx.state, 3000);
    return playViaElement(b64);
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
function playViaElement(b64) {
  return new Promise((resolve) => {
    const el = new Audio("data:audio/mpeg;base64," + b64);
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
    u.rate = 0.95;
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
  if (session) api("api/end", { json: { session } }).catch(() => {});
  showResult();
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
