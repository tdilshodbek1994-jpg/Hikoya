// Lists UI strings passed to t("...") that have no Russian entry in src/lib/ru.ts.
// usage: node scripts/i18n-check.cjs   (exit 1 if something is missing)
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "src");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !p.endsWith("ru.ts") && files.push(p); } })(root);
const keys = new Set();
for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/\bt\("((?:[^"\\]|\\.)*)"\)/g)) keys.add(JSON.parse(`"${m[1]}"`));
const ru = fs.readFileSync(path.join(root, "lib", "ru.ts"), "utf8");
const have = new Set([...ru.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1])));
const missing = [...keys].filter((k) => !have.has(k)).sort();
console.log(`${keys.size} strings, ${missing.length} without Russian`);
missing.forEach((m) => console.log("  " + JSON.stringify(m)));
process.exit(missing.length ? 1 : 0);
