// ✅ Darslarni tekshirish: yangi dars qo'shgandan keyin ishga tushiring
//    npm run check
// Takrorlangan ID, ibora soni, bo'sh tarjima, takrorlangan iboralar, kartochka/savollar va qoidalarni tekshiradi.
import { LESSONS, publicLesson } from "../src/lessons.js";

// public/app.js dagi EN_HINT bilan bir xil
const EN_HINT = /\b(I|I'm|I've|I'd|I'll|you|he|she|it|we|they|is|are|am|do|does|did|will|the|a|an|can|can't|was|were|have|has|had|my|your|his|her|our|their|its|me|him|us|them|to|used|should|must|there|this|that|these|those|any|some|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|let's|please|not|never|ever|been|would|could|might|of|in|on|at|for|with|than|so|such|very|too|what|where|when|who|how|why|if|unless|go|come)\b/i;
const errors = [];
const warns = [];
const ids = new Set();
const seen = new Map();

for (const l of LESSONS) {
  const where = `${l.id} (${l.title})`;
  if (ids.has(l.id)) errors.push(`Takrorlangan ID: ${where}`);
  ids.add(l.id);
  for (const k of ["category", "title", "emoji", "level", "role", "situation", "opener"]) {
    if (!l[k]) errors.push(`${where}: "${k}" yo'q`);
  }
  if (!l.liveOnly && l.phrases.length !== 6) warns.push(`${where}: ${l.phrases.length} ta ibora (odatda 6 ta)`);
  for (const p of l.phrases) {
    if (!p.en?.trim() || !p.uz?.trim()) errors.push(`${where}: bo'sh ibora yoki tarjima`);
    const key = p.en.toLowerCase().trim();
    if (key.includes("...")) continue; // "... " andozalar (bog'lovchilar) ataylab takrorlanadi
    if (seen.has(key)) warns.push(`Takrorlangan ibora "${p.en}": ${seen.get(key)} va ${l.id}`);
    else seen.set(key, l.id);
  }
  if (l.added && !/^\d{4}-\d{2}-\d{2}$/.test(l.added)) errors.push(`${where}: added "YYYY-MM-DD" ko'rinishida bo'lishi kerak`);
  const pub = publicLesson(l);
  if (/^ielts-p2/.test(l.id) && !pub.cue) errors.push(`${where}: Part 2 kartochkasi topilmadi ("Describe ... You should say: ...")`);
  if (/^ielts-p[13]/.test(l.id) && !pub.questions?.length) errors.push(`${where}: savollar topilmadi ("Ask these questions one at a time: ...")`);
  // 🖼 Bolalar darsida har bir ibora uchun rasm (KID_PICS) bo'lsin
  if (l.category === "Bolalar uchun" && pub.phrases.some((ph) => !ph.pic)) warns.push(`${where}: bolalar darsida rasm (KID_PICS) yo'q yoki to'liq emas`);
  if (l.category === "Grammatika gapirib" && !l.rule) warns.push(`${where}: grammatika qoidasi (RULES) yo'q`);
  // 🔊 Qoidada kamida 2 ta bosiladigan (eshitiladigan) to'liq inglizcha misol bo'lsin — app.js dagi ruleBody() bilan bir xil qoida
  const rule = pub.rule || l.rule;
  if (l.category === "Grammatika gapirib" && rule) {
    const ex = [];
    for (const line of rule.split("\n"))
      for (const m of line.matchAll(/[A-Z][A-Za-z0-9' ,]*[A-Za-z0-9][.?!]/g))
        if (m[0].split(" ").length >= 2 && EN_HINT.test(m[0]) && !/✗\s*$/.test(line.slice(0, m.index))) ex.push(m[0]);
    if (ex.length < 2) warns.push(`${where}: qoidada eshitiladigan misol kam (${ex.length} ta) — to'liq gap yozing: "She runs quickly."`);
  }
  if (l.category === "Grammatika gapirib" && pub.quiz.length < 2) warns.push(`${where}: tez mashq (QUIZ) yo'q yoki 2 tadan kam`);
  for (const q of pub.quiz) {
    const k = "quiz:" + q.text.toLowerCase().trim();
    if (seen.has(k)) warns.push(`Takrorlangan test savoli "${q.text}": ${seen.get(k)} va ${l.id}`);
    else seen.set(k, l.id);
  }
  for (const q of pub.quiz) if (!q.text.includes("___") || q.options.length < 2 || new Set(q.options).size !== q.options.length) errors.push(`${where}: noto'g'ri mashq "${q.text}"`);
}

// 🎨 Bir bo'lim ichida ikki dars bir xil belgida bo'lmasin (ro'yxatda adashtiriladi)
const emo = new Map();
for (const l of LESSONS) {
  const k = `${l.category} ${l.emoji}`;
  if (emo.has(k)) warns.push(`Bir xil belgi ${l.emoji} «${l.category}» bo'limida: ${emo.get(k)} va ${l.id}`);
  else emo.set(k, l.id);
}
console.log(`📚 ${LESSONS.length} ta dars tekshirildi`);
for (const w of warns) console.log("⚠️  " + w);
for (const e of errors) console.log("❌ " + e);
if (errors.length) {
  console.log(`\n${errors.length} ta xato — tuzating.`);
  process.exit(1);
}
console.log(warns.length ? `\n✅ Xato yo'q (${warns.length} ta ogohlantirish)` : "\n✅ Hammasi joyida");
