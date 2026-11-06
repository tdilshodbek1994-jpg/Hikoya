/* Tiptap configuration restricted to the server's rich-text schema, with stable block ids. */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import type { Block, Doc } from "../../lib/api";

const BLOCKS = ["paragraph", "heading", "blockquote", "horizontalRule", "image"];

export const newBid = () => "b" + Math.random().toString(36).slice(2, 12).padEnd(10, "0");

/** Every top-level block keeps a `bid`. New or duplicated (after a split) blocks get a fresh one. */
export const StableIds = Extension.create({
  name: "stableIds",
  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          bid: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-bid"),
            renderHTML: (attrs) => (attrs.bid ? { "data-bid": attrs.bid } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("stableIds"),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          let tr = state.tr;
          let changed = false;
          state.doc.forEach((node, pos) => {
            if (!BLOCKS.includes(node.type.name)) return;
            const bid = node.attrs.bid as string | null;
            if (!bid || seen.has(bid)) {
              const nb = newBid();
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, bid: nb });
              seen.add(nb);
              changed = true;
            } else seen.add(bid);
          });
          return changed ? tr.setMeta("addToHistory", false) : null;
        },
      }),
    ];
  },
});

export const Figure = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { asset_id: { default: null }, caption: { default: "" }, src: { default: null } };
  },
  parseHTML() {
    return [{ tag: "figure[data-asset]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const { src, caption, asset_id, ...rest } = HTMLAttributes;
    return ["figure", mergeAttributes(rest, { "data-asset": asset_id }), ["img", { src: src || "" }], ["figcaption", {}, caption || ""]];
  },
});

export const kit = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    codeBlock: false,
    code: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    strike: false,
    link: false,
    underline: false,
    listKeymap: false,
  } as any),
  StableIds,
  Figure,
];

/** Server doc → Tiptap JSON (blockquote needs an inner paragraph; images need a display src). */
export function toEditor(doc: Doc, images: Record<string, string>): any {
  return {
    type: "doc",
    content: (doc.content.length ? doc.content : [{ type: "paragraph", attrs: { bid: newBid() }, content: [] } as unknown as Block]).map((b: any) => {
      if (b.type === "blockquote") return { type: "blockquote", attrs: { bid: b.attrs.bid }, content: [{ type: "paragraph", content: b.content }] };
      if (b.type === "image") return { type: "image", attrs: { ...b.attrs, src: images[String(b.attrs.asset_id)] || null } };
      if (b.content && !b.content.length) return { type: b.type, attrs: b.attrs };
      return b;
    }),
  };
}

/** Tiptap JSON → server doc (the server sanitises again; this keeps payloads small). */
export function fromEditor(json: any): Doc {
  return {
    type: "doc",
    content: (json.content || []).map((n: any) => {
      if (n.type === "image") return { type: "image", attrs: { bid: n.attrs?.bid, asset_id: n.attrs?.asset_id, caption: n.attrs?.caption || "" } };
      return { type: n.type, attrs: n.attrs || {}, content: n.content || [] };
    }),
  };
}

export function countWords(json: any): number {
  let words = 0;
  const walk = (n: any) => {
    if (n.text) words += (n.text.match(/[\p{L}\p{N}']+/gu) || []).length;
    (n.content || []).forEach(walk);
  };
  walk(json);
  return words;
}
