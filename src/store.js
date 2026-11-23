// O'quvchilar progressini saqlash (oddiy JSON fayl). Fayl yozib bo'lmasa, xotirada ishlayveradi.
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DIR, "progress.json");
const MAX_HISTORY = 200;

let db = { users: {} };
try {
  db = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!db.users) db = { users: {} };
} catch {
  // birinchi ishga tushish
}

let timer = null;
let warned = false;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      if (!warned) console.error("Progressni saqlab bo'lmadi:", e.message);
      warned = true;
    }
  }, 500);
}

// Toshkent vaqti bo'yicha sana (YYYY-MM-DD)
const today = (d = new Date()) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10);

function user(id) {
  db.users[id] ||= { lessons: {}, history: [], days: [], seconds: 0 };
  return db.users[id];
}

export function recordSession(userId, { lessonId, mode, used, total, seconds, report }) {
  const u = user(userId);
  const score = Number.isFinite(report?.score) ? report.score : Math.round((used / Math.max(1, total)) * 100);
  const l = (u.lessons[lessonId] ||= { best: 0, count: 0, last: "" });
  l.best = Math.max(l.best, score);
  l.count += 1;
  l.last = today();
  const d = today();
  if (!u.days.includes(d)) u.days.push(d);
  u.days = u.days.slice(-400);
  u.seconds += Math.max(0, Math.round(seconds || 0));
  u.history.push({
    at: new Date().toISOString(),
    lessonId,
    mode,
    used,
    total,
    score,
    level: report?.level || "",
  });
  u.history = u.history.slice(-MAX_HISTORY);
  // 📒 Lug'at: yangi so'zlar va tuzatilgan xatolar
  u.words ||= [];
  const add = (w) => {
    if (!w.en || u.words.some((x) => x.en.toLowerCase() === w.en.toLowerCase())) return;
    u.words.push({ ...w, at: today() });
  };
  for (const w of report?.new_words || []) add({ en: w.en, uz: w.uz || "", type: "word" });
  for (const m of report?.mistakes || []) add({ en: m.right, uz: m.why_uz || "", wrong: m.wrong, type: "fix" });
  u.words = u.words.slice(-300);
  save();
  return score;
}

function streak(days) {
  const set = new Set(days);
  let n = 0;
  let d = new Date();
  if (!set.has(today(d))) d = new Date(d.getTime() - 86400_000); // bugun hali mashq qilmagan bo'lsa, kechadan sanaymiz
  while (set.has(today(d))) {
    n += 1;
    d = new Date(d.getTime() - 86400_000);
  }
  return n;
}

export function summary(userId) {
  const u = user(userId);
  const lessons = {};
  for (const [id, l] of Object.entries(u.lessons)) lessons[id] = { best: l.best, count: l.count };
  return {
    streak: streak(u.days),
    best: u.history.reduce((m, h) => Math.max(m, h.score || 0), 0),
    bestStreak: (() => {
      // Eng uzun ketma-ket kunlar seriyasi
      const ds = [...new Set(u.days)].sort();
      let best = 0, cur = 0, prev = null;
      for (const d of ds) {
        cur = prev && (Date.parse(d) - Date.parse(prev)) === 86400_000 ? cur + 1 : 1;
        best = Math.max(best, cur);
        prev = d;
      }
      return best;
    })(),
    ielts: u.history.some((h) => /IELTS\s*(6|7|8|9)/.test(h.level || "")),
    today: u.history.filter((h) => today(new Date(h.at)) === today()).length,
    done: Object.keys(u.lessons).filter((id) => id !== "review").length,
    minutes: Math.round(u.seconds / 60),
    lessons,
    recent: u.history.slice(-10).reverse(),
    words: (u.words || []).slice(-150).reverse(),
  };
}

// 📊 Admin uchun umumiy statistika (shaxsiy ma'lumotsiz)
export function adminStats() {
  const users = Object.values(db.users);
  const d = today();
  const week = new Set(Array.from({ length: 7 }, (_, i) => today(new Date(Date.now() - i * 86400_000))));
  const all = users.flatMap((u) => u.history);
  const byLesson = {};
  for (const h of all) byLesson[h.lessonId] = (byLesson[h.lessonId] || 0) + 1;
  const byDay = {};
  for (const h of all) {
    const k = today(new Date(h.at));
    if (week.has(k)) byDay[k] = (byDay[k] || 0) + 1;
  }
  return {
    users: users.length,
    activeToday: users.filter((u) => u.days.includes(d)).length,
    activeWeek: users.filter((u) => u.days.some((x) => week.has(x))).length,
    lessons: all.length,
    lessonsToday: all.filter((h) => today(new Date(h.at)) === d).length,
    avgScore: all.length ? Math.round(all.reduce((s, h) => s + (h.score || 0), 0) / all.length) : 0,
    minutes: Math.round(users.reduce((s, u) => s + (u.seconds || 0), 0) / 60),
    top: Object.entries(byLesson).sort((a, b) => b[1] - a[1]).slice(0, 10),
    byDay: [...week].sort().map((k) => [k, byDay[k] || 0]),
  };
}
