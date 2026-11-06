/* UI strings are written in Uzbek Latin; Cyrillic is produced by transliteration (same language,
   not translation). Russian can be added later as a separate dictionary. */

import { useAuth } from "./auth";

const MULTI: [string, string][] = [["o'", "ў"], ["g'", "ғ"], ["sh", "ш"], ["ch", "ч"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"], ["ye", "е"]];
const SINGLE: Record<string, string> = {
  a: "а", b: "б", d: "д", e: "е", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п",
  q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", x: "х", y: "й", z: "з", "'": "ъ", c: "с", w: "в",
};
const APOS = /[`ʻʼ‘’]/g;

export function latToCyr(input: string): string {
  const s = input.replace(APOS, "'");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const two = s.slice(i, i + 2).toLowerCase();
    const m = MULTI.find(([l]) => l === two);
    if (m) {
      out += ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? m[1].toUpperCase() : m[1];
      i++;
      continue;
    }
    if (ch.toLowerCase() === "e" && (i === 0 || !/[a-zA-Z']/.test(s[i - 1]))) {
      out += ch === "E" ? "Э" : "э";
      continue;
    }
    const r = SINGLE[ch.toLowerCase()];
    if (!r) out += ch;
    else out += ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? r.toUpperCase() : r;
  }
  return out;
}

export function useT() {
  const { me } = useAuth();
  const cyr = me?.script === "cyrl";
  return (s: string) => (cyr ? latToCyr(s) : s);
}

export function plural(n: number, word: string) {
  return `${n} ${word}`;
}

export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Tashkent" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("uz-UZ", opts);
}

export function relTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "hozirgina";
  if (diff < 3600) return `${Math.floor(diff / 60)} daq. oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} soat oldin`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} kun oldin`;
  return fmtDate(iso);
}

export const ACCESS_LABEL: Record<string, string> = {
  FREE: "Bepul",
  PREMIUM: "Premium",
  PURCHASE: "Alohida xarid",
  INCLUDED: "Premiumda",
  PURCHASED: "Xarid qilingan",
};

export const STATUS_LABEL: Record<string, string> = { ongoing: "Davom etmoqda", completed: "Tugallangan", paused: "Tanaffusda" };
export const FORMAT_LABEL: Record<string, string> = { short: "Qisqa hikoya", novella: "Qissa", novel: "Roman", series: "Turkum", diary: "Kundalik" };
