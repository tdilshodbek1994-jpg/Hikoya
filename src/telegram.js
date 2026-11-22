import crypto from "node:crypto";

// Telegram Mini App'dan kelgan initData'ni tekshiradi.
// Rasmiy hujjat: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// To'g'ri bo'lsa foydalanuvchi obyektini, aks holda null qaytaradi.
export function verifyInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}
