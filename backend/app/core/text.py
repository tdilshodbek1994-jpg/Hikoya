"""Uzbek text helpers: Latin/Cyrillic conversion and search normalisation.

Latin↔Cyrillic conversion is transliteration of the same language (not translation).
"""

from __future__ import annotations

import re
import unicodedata

APOSTROPHES = "'`ʻʼ‘’ʹ′´"
_APOS_RE = re.compile(f"[{re.escape(APOSTROPHES)}]")

_CYR_TO_LAT = {
    "щ": "sh", "ш": "sh", "ч": "ch", "ё": "yo", "ю": "yu", "я": "ya", "ц": "s",
    "ғ": "g'", "ў": "o'", "қ": "q", "ҳ": "h", "ж": "j", "х": "x", "й": "y",
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "з": "z", "и": "i",
    "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s",
    "т": "t", "у": "u", "ф": "f", "ъ": "'", "ь": "", "э": "e", "ы": "i",
}

_LAT_TO_CYR_MULTI = [
    ("o'", "ў"), ("g'", "ғ"), ("sh", "ш"), ("ch", "ч"), ("yo", "ё"), ("yu", "ю"), ("ya", "я"), ("ye", "е"),
]
_LAT_TO_CYR = {
    "a": "а", "b": "б", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "ҳ", "i": "и", "j": "ж", "k": "к",
    "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "қ", "r": "р", "s": "с", "t": "т", "u": "у",
    "v": "в", "x": "х", "y": "й", "z": "з", "'": "ъ", "c": "с", "w": "в",
}


def unify_apostrophes(s: str) -> str:
    return _APOS_RE.sub("'", s)


def cyr_to_lat(s: str) -> str:
    out = []
    for ch in s:
        low = ch.lower()
        rep = _CYR_TO_LAT.get(low)
        if rep is None:
            out.append(ch)
        elif ch != low and rep:
            out.append(rep[0].upper() + rep[1:])
        else:
            out.append(rep)
    return "".join(out)


def lat_to_cyr(s: str) -> str:
    s = unify_apostrophes(s)
    out = []
    i = 0
    while i < len(s):
        ch = s[i]
        low2 = s[i : i + 2].lower()
        hit = next((c for l, c in _LAT_TO_CYR_MULTI if low2 == l), None)
        if hit:
            out.append(hit.upper() if ch.isupper() else hit)
            i += 2
            continue
        # word-initial "e" is "э" in Uzbek Cyrillic
        if ch.lower() == "e" and (i == 0 or not s[i - 1].isalpha()):
            out.append("Э" if ch.isupper() else "э")
            i += 1
            continue
        rep = _LAT_TO_CYR.get(ch.lower())
        if rep is None:
            out.append(ch)
        else:
            out.append(rep.upper() if ch.isupper() else rep)
        i += 1
    return "".join(out)


def to_script(s: str, script: str) -> str:
    return lat_to_cyr(s) if script == "cyrl" else s


def normalize_for_search(s: str) -> str:
    """Lowercase, Cyrillic→Latin, unify apostrophes then drop them, strip accents and punctuation."""
    s = unicodedata.normalize("NFKC", s or "")
    s = cyr_to_lat(s).lower()
    s = unify_apostrophes(s).replace("'", "")
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(s: str, max_len: int = 80) -> str:
    s = normalize_for_search(s).replace(" ", "-")
    s = re.sub(r"[^a-z0-9-]", "", s)
    return (s or "asar")[:max_len].strip("-") or "asar"


_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_plain(s: str, max_len: int | None = None) -> str:
    """User plain text: strip control chars, normalise newlines. HTML is kept as literal text."""
    s = _CTRL_RE.sub("", (s or "").replace("\r\n", "\n").replace("\r", "\n")).strip()
    return s[:max_len] if max_len else s


def word_count(s: str) -> int:
    return len(re.findall(r"\w+", s or ""))


def minutes_for_words(words: int, wpm: int = 180) -> int:
    return max(1, round(words / wpm)) if words else 0


def render_script(text: str, source_script: str, target_script: str) -> str:
    """Show text in the reader's chosen script (transliteration, not translation)."""
    if not text or source_script == target_script:
        return text
    if target_script == "cyrl":
        return lat_to_cyr(text)
    return cyr_to_lat(text)
