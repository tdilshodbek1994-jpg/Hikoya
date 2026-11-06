/* Offline-safe progress queue: progress and reading events are stored locally first and sent
   when the network is back. Every event has its own id, so resending never double counts. */

import { api, ApiError, uuid } from "./api";

const KEY = "hk_queue_v1";
const DEV_KEY = "hk_device";
const SEQ_KEY = "hk_seq";

export function deviceId(): string {
  let d = localStorage.getItem(DEV_KEY);
  if (!d) {
    d = uuid();
    localStorage.setItem(DEV_KEY, d);
  }
  return d;
}

export function nextSeq(): number {
  const n = Number(localStorage.getItem(SEQ_KEY) || 0) + 1;
  localStorage.setItem(SEQ_KEY, String(n));
  return n;
}

type Item = { kind: "progress"; body: Record<string, unknown> } | { kind: "event"; body: Record<string, unknown> };

function load(): Item[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
function save(items: Item[]) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(-500)));
}

export function queueProgress(body: Record<string, unknown>) {
  // only the latest progress per work matters
  const items = load().filter((i) => !(i.kind === "progress" && i.body.work_id === body.work_id));
  items.push({ kind: "progress", body: { ...body, device_id: deviceId(), sequence: nextSeq(), client_ts: new Date().toISOString() } });
  save(items);
}

export function queueEvent(body: Record<string, unknown>) {
  const items = load();
  items.push({ kind: "event", body: { event_id: uuid(), sequence: nextSeq(), ...body } });
  save(items);
}

export type ConflictInfo = { work_id: number; other: { chapter_id: number; chapter_title: string; ratio: number }; mine: Record<string, unknown> };
let conflictHandler: ((c: ConflictInfo) => void) | null = null;
export function onProgressConflict(cb: (c: ConflictInfo) => void) {
  conflictHandler = cb;
}

let flushing = false;
export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let items = load();
    const events = items.filter((i) => i.kind === "event").map((i) => i.body);
    if (events.length) {
      await api("/reading/events/batch", { method: "POST", body: { events } });
      const sent = new Set(events.map((e) => e.event_id));
      items = load().filter((i) => !(i.kind === "event" && sent.has(i.body.event_id)));
      save(items);
    }
    for (const it of load().filter((i) => i.kind === "progress")) {
      try {
        const r = await api<{ status: string; other?: ConflictInfo["other"] }>("/reading/progress", { method: "PUT", body: it.body });
        if (r.status === "conflict" && r.other && conflictHandler) conflictHandler({ work_id: it.body.work_id as number, other: r.other, mine: it.body });
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) return; // still offline
      }
      save(load().filter((i) => i !== it && !(i.kind === "progress" && i.body.work_id === it.body.work_id && i.body.sequence === it.body.sequence)));
    }
  } catch {
    /* retry later */
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => flush());
  setInterval(() => flush(), 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
