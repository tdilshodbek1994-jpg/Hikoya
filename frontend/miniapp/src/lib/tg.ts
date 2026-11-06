/* Thin, defensive wrapper around Telegram.WebApp. Every optional capability is feature-detected
   so the reader keeps working in old clients and in a plain browser (dev). */

type Btn = { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void; isVisible?: boolean };

interface WebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  setBottomBarColor?(c: string): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  requestFullscreen?(): void;
  openInvoice?(url: string, cb?: (status: "paid" | "cancelled" | "failed" | "pending") => void): void;
  openLink?(url: string): void;
  openTelegramLink?(url: string): void;
  shareMessage?(msgId: string, cb?: (sent: boolean) => void): void;
  shareToStory?(mediaUrl: string, params?: { text?: string; widget_link?: { url: string; name?: string } }): void;
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  showConfirm?(message: string, cb: (ok: boolean) => void): void;
  BackButton?: Btn;
  HapticFeedback?: { impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void; notificationOccurred(t: "error" | "success" | "warning"): void; selectionChanged(): void };
  onEvent?(e: string, cb: () => void): void;
  offEvent?(e: string, cb: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

export const wa: WebApp | undefined = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
export const inTelegram = !!(wa && wa.initData);

const at = (v: string) => !!wa && typeof wa.isVersionAtLeast === "function" && wa.isVersionAtLeast(v);

export function initTelegram() {
  if (!wa) return;
  try {
    wa.ready();
    wa.expand();
    if (at("6.1")) {
      wa.setHeaderColor?.("#0B0D12");
      wa.setBackgroundColor?.("#0B0D12");
    }
    if (at("7.10")) wa.setBottomBarColor?.("#0B0D12");
    if (at("7.7")) wa.disableVerticalSwipes?.();
  } catch {
    /* old client */
  }
  const apply = () => {
    const s = wa.safeAreaInset, c = wa.contentSafeAreaInset;
    const root = document.documentElement.style;
    root.setProperty("--tg-safe-top", `${(s?.top || 0) + (c?.top || 0)}px`);
    root.setProperty("--tg-safe-bottom", `${(s?.bottom || 0) + (c?.bottom || 0)}px`);
  };
  apply();
  wa.onEvent?.("safeAreaChanged", apply);
  wa.onEvent?.("contentSafeAreaChanged", apply);
}

export function startParam(): string {
  const q = new URLSearchParams(location.search);
  return wa?.initDataUnsafe?.start_param || q.get("p") || q.get("tgWebAppStartParam") || "";
}

export const haptic = {
  tap: () => wa?.HapticFeedback?.impactOccurred("light"),
  ok: () => wa?.HapticFeedback?.notificationOccurred("success"),
  err: () => wa?.HapticFeedback?.notificationOccurred("error"),
  pick: () => wa?.HapticFeedback?.selectionChanged(),
};

export function backButton(show: boolean, cb?: () => void): () => void {
  const b = wa?.BackButton;
  if (!b || !at("6.1")) return () => {};
  if (show && cb) {
    b.onClick(cb);
    b.show();
    return () => {
      b.offClick(cb);
    };
  }
  b.hide();
  return () => {};
}

export function closingConfirmation(on: boolean) {
  if (!at("6.2")) return;
  if (on) wa?.enableClosingConfirmation?.();
  else wa?.disableClosingConfirmation?.();
}

export function openInvoice(url: string): Promise<"paid" | "cancelled" | "failed" | "pending" | "unsupported"> {
  return new Promise((resolve) => {
    if (wa?.openInvoice && at("6.1")) wa.openInvoice(url, (s) => resolve(s));
    else {
      window.open(url, "_blank");
      resolve("unsupported");
    }
  });
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (wa?.showConfirm && at("6.2")) wa.showConfirm(message, resolve);
    else resolve(window.confirm(message));
  });
}

export const canShareToStory = () => !!wa?.shareToStory && at("7.8");
export const canShareMessage = () => !!wa?.shareMessage && at("8.0");

/** Bot API 8.0: send a prepared card message (cover + «O'qish» button) to a chat the user picks. */
export function shareMessage(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!canShareMessage()) return resolve(false);
    wa!.shareMessage!(id, (sent) => resolve(!!sent));
  });
}

export function shareToStory(mediaUrl: string, text: string, link: string) {
  if (canShareToStory()) wa!.shareToStory!(mediaUrl, { text: text.slice(0, 200), widget_link: { url: link, name: "HIKOYA PRO" } });
}

export function shareLink(url: string, text: string) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (wa?.openTelegramLink) wa.openTelegramLink(share);
  else if (navigator.share) navigator.share({ url, text }).catch(() => {});
  else window.open(share, "_blank");
}

export function requestWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (wa?.requestWriteAccess && at("6.9")) wa.requestWriteAccess((g) => resolve(g));
    else resolve(false);
  });
}

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
