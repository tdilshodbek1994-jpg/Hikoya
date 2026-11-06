"""Restricted rich-text schema for chapter content.

Stored format (ProseMirror-like JSON, a strict subset of what the Tiptap editor emits):

    {"type": "doc", "content": [block, ...]}
    block := {"type": "paragraph" | "heading" | "blockquote", "attrs": {"bid": str, "level"?: 2|3},
              "content": [inline, ...]}
           | {"type": "horizontalRule", "attrs": {"bid": str}}
           | {"type": "image", "attrs": {"bid": str, "asset_id": int, "caption": str}}
    inline := {"type": "text", "text": str, "marks"?: [{"type": "bold"|"italic"}]}
            | {"type": "hardBreak"}

Anything else (raw HTML, links, scripts, unknown nodes/marks/attrs) is dropped. Every block has a
stable id ``bid`` which is preserved across edits so progress and bookmarks survive revisions.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from typing import Any

from app.core.errors import Invalid
from app.core.text import clean_plain

BID_RE = re.compile(r"^b[a-z0-9]{6,16}$")
TEXT_BLOCKS = {"paragraph", "heading", "blockquote"}
MAX_BLOCKS = 5000
MAX_TEXT = 2_000_000


def new_bid() -> str:
    return "b" + secrets.token_hex(5)


def _inline(nodes: Any) -> list[dict]:
    out: list[dict] = []
    if not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        if t == "text":
            text = clean_plain(str(n.get("text", "")).replace("\n", " "))
            if not text:
                # keep single spaces between marks
                raw = str(n.get("text", ""))
                if raw.strip() == "" and raw:
                    text = " "
                else:
                    continue
            marks = []
            for m in n.get("marks") or []:
                mt = m.get("type") if isinstance(m, dict) else None
                if mt in ("bold", "italic") and {"type": mt} not in marks:
                    marks.append({"type": mt})
            node: dict = {"type": "text", "text": text}
            if marks:
                node["marks"] = marks
            out.append(node)
        elif t == "hardBreak":
            out.append({"type": "hardBreak"})
        elif t == "paragraph":  # flatten nested paragraphs (e.g. inside blockquote)
            if out:
                out.append({"type": "hardBreak"})
            out.extend(_inline(n.get("content")))
    return out


def sanitize_doc(doc: Any) -> dict:
    """Validate and normalise a document, assigning unique stable block ids."""
    if not isinstance(doc, dict) or doc.get("type") != "doc" or not isinstance(doc.get("content", []), list):
        raise Invalid("Matn formati noto'g'ri", code="content_invalid")
    seen: set[str] = set()
    blocks: list[dict] = []
    for n in doc.get("content", []):
        if not isinstance(n, dict):
            continue
        t = n.get("type")
        attrs = n.get("attrs") or {}
        bid = attrs.get("bid") if isinstance(attrs, dict) else None
        if not isinstance(bid, str) or not BID_RE.match(bid) or bid in seen:
            bid = new_bid()
            while bid in seen:
                bid = new_bid()
        if t in TEXT_BLOCKS:
            inline = _inline(n.get("content"))
            if t == "blockquote" and not inline:
                continue
            block: dict = {"type": t, "attrs": {"bid": bid}, "content": inline}
            if t == "heading":
                lvl = attrs.get("level", 2)
                block["attrs"]["level"] = 3 if lvl == 3 else 2
        elif t == "horizontalRule":
            block = {"type": "horizontalRule", "attrs": {"bid": bid}}
        elif t == "image":
            try:
                asset_id = int(attrs.get("asset_id"))
            except (TypeError, ValueError):
                continue
            block = {
                "type": "image",
                "attrs": {"bid": bid, "asset_id": asset_id, "caption": clean_plain(str(attrs.get("caption", "")), 300)},
            }
        elif t == "bulletList" or t == "orderedList":
            for li in n.get("content") or []:
                inline = _inline((li or {}).get("content"))
                if inline:
                    b2 = new_bid()
                    seen.add(b2)
                    blocks.append({"type": "paragraph", "attrs": {"bid": b2}, "content": [{"type": "text", "text": "• "}, *inline]})
            continue
        else:
            continue
        seen.add(bid)
        blocks.append(block)
        if len(blocks) > MAX_BLOCKS:
            raise Invalid("Bob juda uzun, uni bir nechta bobga bo'ling", code="content_too_long")
    # drop trailing empty paragraphs
    while blocks and blocks[-1]["type"] == "paragraph" and not blocks[-1]["content"]:
        blocks.pop()
    out = {"type": "doc", "content": blocks}
    if len(plain_text(out)) > MAX_TEXT:
        raise Invalid("Bob juda uzun", code="content_too_long")
    return out


def block_text(block: dict) -> str:
    parts = []
    for n in block.get("content") or []:
        if n.get("type") == "text":
            parts.append(n.get("text", ""))
        elif n.get("type") == "hardBreak":
            parts.append("\n")
    if block.get("type") == "image":
        parts.append(block.get("attrs", {}).get("caption", ""))
    return "".join(parts)


def plain_text(doc: dict) -> str:
    return "\n\n".join(t for t in (block_text(b) for b in doc.get("content", [])) if t)


def block_ids(doc: dict) -> list[str]:
    return [b["attrs"]["bid"] for b in doc.get("content", [])]


def content_hash(doc: dict) -> str:
    return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def preview_doc(doc: dict, n_blocks: int) -> dict:
    """Free sample: first N blocks only. The rest is never sent to the client."""
    return {"type": "doc", "content": doc.get("content", [])[: max(0, n_blocks)]}


def asset_ids(doc: dict) -> list[int]:
    return [b["attrs"]["asset_id"] for b in doc.get("content", []) if b["type"] == "image"]


_MD_INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_)")


def _md_inline(line: str) -> list[dict]:
    out: list[dict] = []
    for part in _MD_INLINE.split(line):
        if not part:
            continue
        if (part.startswith("**") and part.endswith("**")) or (part.startswith("__") and part.endswith("__")):
            out.append({"type": "text", "text": part[2:-2], "marks": [{"type": "bold"}]})
        elif (part.startswith("*") and part.endswith("*")) or (part.startswith("_") and part.endswith("_")):
            out.append({"type": "text", "text": part[1:-1], "marks": [{"type": "italic"}]})
        else:
            out.append({"type": "text", "text": part})
    return out


def text_to_doc(text: str, markdown: bool = True) -> dict:
    """Plain text / limited Markdown → document. Blank lines separate paragraphs."""
    text = clean_plain(text)
    blocks: list[dict] = []
    para: list[str] = []

    def flush():
        if para:
            content: list[dict] = []
            for i, line in enumerate(para):
                if i:
                    content.append({"type": "hardBreak"})
                content.extend(_md_inline(line) if markdown else [{"type": "text", "text": line}])
            blocks.append({"type": "paragraph", "attrs": {}, "content": content})
            para.clear()

    for raw in text.split("\n"):
        line = raw.rstrip()
        s = line.strip()
        if not s:
            flush()
            continue
        if markdown and re.fullmatch(r"(\*\s*){3,}|-{3,}|_{3,}", s):
            flush()
            blocks.append({"type": "horizontalRule", "attrs": {}})
        elif markdown and s.startswith("#"):
            flush()
            level = 3 if s.startswith("###") else 2
            blocks.append({"type": "heading", "attrs": {"level": level}, "content": _md_inline(s.lstrip("#").strip())})
        elif markdown and s.startswith(">"):
            flush()
            blocks.append({"type": "blockquote", "attrs": {}, "content": _md_inline(s.lstrip(">").strip())})
        else:
            para.append(s)
    flush()
    return sanitize_doc({"type": "doc", "content": blocks})


def nearest_preserved_block(old_ids: list[str], new_ids: list[str], block_id: str) -> tuple[str, bool]:
    """Map a position from an old revision onto a new one (T-17).

    Returns (block_id_in_new_revision, moved). If the block still exists it is returned unchanged.
    Otherwise the closest preceding block that survived is used, then the closest following one.
    """
    new_set = set(new_ids)
    if block_id in new_set:
        return block_id, False
    if not new_ids:
        return "", True
    if block_id in old_ids:
        i = old_ids.index(block_id)
        for j in range(i - 1, -1, -1):
            if old_ids[j] in new_set:
                return old_ids[j], True
        for j in range(i + 1, len(old_ids)):
            if old_ids[j] in new_set:
                return old_ids[j], True
    return new_ids[0], True
