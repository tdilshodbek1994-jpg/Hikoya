/** startapp / ?p= parameter → route. A link never grants access by itself; pages re-check. */
export function routeForParam(p: string): string | null {
  if (!p) return null;
  if (p.startsWith("w_")) return `/w/${p.slice(2)}`;
  if (p.startsWith("c_")) return `/read/${p.slice(2)}`;
  if (p.startsWith("a_")) return `/a/${p.slice(2)}`;
  if (p.startsWith("st_")) return `/s/${p.slice(3)}`;
  if (p.startsWith("s_")) return `/studio/w/${p.slice(2)}`;
  if (p.startsWith("e_")) return `/studio/e/${p.slice(2)}`;
  if (p.startsWith("b_")) return `/beta/${p.slice(2)}`;
  const map: Record<string, string> = {
    premium: "/premium", library: "/library", notifications: "/notifications", q_review: "/studio/reviews", q_moderation: "/admin/moderation",
    studio: "/studio", support: "/support", settings: "/profile",
  };
  if (map[p]) return map[p];
  if (p.startsWith("admin/") || p.startsWith("studio/")) return `/${p}`;
  return null;
}
