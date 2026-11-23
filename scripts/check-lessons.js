// ✅ Darslarni tekshirish: yangi dars qo'shgandan keyin ishga tushiring
//    npm run check
// Takrorlangan ID, ibora soni, bo'sh tarjima, takrorlangan iboralar, kartochka/savollar va qoidalarni tekshiradi.
import { LESSONS, publicLesson } from "../src/lessons.js";

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
  if (l.category === "Grammatika gapirib" && !l.rule) warns.push(`${where}: grammatika qoidasi (RULES) yo'q`);
}

console.log(`📚 ${LESSONS.length} ta dars tekshirildi`);
for (const w of warns) console.log("⚠️  " + w);
for (const e of errors) console.log("❌ " + e);
if (errors.length) {
  console.log(`\n${errors.length} ta xato — tuzating.`);
  process.exit(1);
}
console.log(warns.length ? `\n✅ Xato yo'q (${warns.length} ta ogohlantirish)` : "\n✅ Hammasi joyida");
