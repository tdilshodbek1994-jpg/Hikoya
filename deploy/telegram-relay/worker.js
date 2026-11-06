// Cloudflare Worker: a narrow relay to api.telegram.org for servers that cannot reach Telegram
// directly (HIKOYA_TELEGRAM_API_BASE=https://<name>.<account>.workers.dev).
//
// Only Bot API calls and file downloads of ONE bot are forwarded (set ALLOWED_BOT_ID in the
// Worker settings = the number before ":" in the bot token). Anything else gets 404, so the
// Worker is not an open proxy. The token passes through like it does to api.telegram.org and
// is never stored or logged here.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/(file\/)?bot(\d+):[A-Za-z0-9_-]+(\/test)?\/[A-Za-z0-9_./-]+$/);
    if (!m || !env.ALLOWED_BOT_ID || m[2] !== String(env.ALLOWED_BOT_ID)) {
      return new Response("not found", { status: 404 });
    }
    if (!["GET", "POST"].includes(request.method)) return new Response("method not allowed", { status: 405 });
    const target = "https://api.telegram.org" + url.pathname + url.search;
    const headers = new Headers();
    const ct = request.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const resp = await fetch(target, { method: request.method, headers, body: request.method === "POST" ? request.body : undefined });
    const out = new Headers();
    for (const h of ["content-type", "content-length", "retry-after"]) {
      const v = resp.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
