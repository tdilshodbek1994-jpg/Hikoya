/* Typed API client. The session token lives in memory + sessionStorage only (never in URLs). */

export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;
  constructor(status: number, code: string, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "";
let token: string | null = sessionStorage.getItem("hk_token");
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem("hk_token", t);
  else sessionStorage.removeItem("hk_token");
}
export const hasToken = () => !!token;
export function onAuthLost(cb: () => void) {
  onUnauthorized = cb;
}

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

type Opts = { method?: string; body?: unknown; form?: FormData; idem?: string; signal?: AbortSignal; query?: Record<string, unknown> };

export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  let url = `${BASE}/api/v1${path}`;
  if (o.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
      else q.set(k, String(v));
    }
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (o.idem) headers["Idempotency-Key"] = o.idem;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: o.method || (body ? "POST" : "GET"), headers, body, signal: o.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "Internet aloqasi yo'q", {});
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, data?.error_code || "error", data?.message || "Xatolik yuz berdi", data || {});
  }
  return data as T;
}

export const get = <T = any>(p: string, query?: Record<string, unknown>) => api<T>(p, { query });
export const post = <T = any>(p: string, body?: unknown, idem?: string) => api<T>(p, { method: "POST", body: body ?? {}, idem });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "PUT", body: body ?? {} });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "PATCH", body: body ?? {} });
export const del = <T = any>(p: string, query?: Record<string, unknown>) => api<T>(p, { method: "DELETE", query });

/* ---------- shared types ---------- */

export type Access = "FREE" | "PREMIUM" | "PURCHASE" | "INCLUDED" | "PURCHASED";

export interface Card {
  id: number;
  code: string;
  title: string;
  cover_url: string | null;
  author: { id: number; pen_name: string; verified: boolean } | null;
  genre: { slug: string; name: string } | null;
  access: Access;
  format: string;
  completion_state: "ongoing" | "completed" | "paused";
  chapters: number;
  minutes: number;
  has_audio: boolean;
  is_demo: boolean;
  progress: { ratio: number; chapter_id: number; completed: boolean } | null;
  rank?: number;
  score?: number;
  reason?: string;
  sponsored?: boolean;
  new_chapters?: number;
  first_new_chapter_id?: number;
  continue?: { chapter_id: number; chapter_title: string; ratio: number; block_id: string };
  snippet?: string;
}

export interface Me {
  id: number;
  telegram_user_id?: number;
  language?: "uz" | "ru";
  display_name: string;
  script: "latn" | "cyrl";
  onboarding_done: boolean;
  favorite_genre_ids: number[];
  reader_settings: ReaderSettings;
  only_completed: boolean;
  daily_goal_minutes: number | null;
  bot_messages_allowed: boolean;
  roles: string[];
  permissions: string[];
  assigned_work_ids: number[];
  is_staff: boolean;
  author: { id: number; pen_name: string; slug: string; trusted: boolean } | null;
  unread_notifications: number;
  notification_prefs: { mode: string; quiet_start: string; quiet_end: string; disabled_types: string[] } | null;
}

export interface ReaderSettings {
  theme?: "light" | "dark" | "sepia";
  font?: "serif" | "sans";
  font_size?: number;
  line_height?: number;
  width?: "narrow" | "normal" | "wide";
  show_progress?: boolean;
  original_script?: boolean;
}

export type Inline = { type: "text"; text: string; marks?: { type: "bold" | "italic" }[] } | { type: "hardBreak" };
export type Block =
  | { type: "paragraph" | "blockquote"; attrs: { bid: string }; content: Inline[] }
  | { type: "heading"; attrs: { bid: string; level: 2 | 3 }; content: Inline[] }
  | { type: "horizontalRule"; attrs: { bid: string } }
  | { type: "image"; attrs: { bid: string; asset_id: number; caption: string } };
export interface Doc {
  type: "doc";
  content: Block[];
}
