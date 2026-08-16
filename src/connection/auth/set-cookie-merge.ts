/**
 * Merge `Set-Cookie` response headers into an existing `name=value; …` cookie
 * string, honoring deletions. A server clears a cookie by sending `Max-Age=0`
 * (or a negative Max-Age) or an `Expires` date in the past; such a header must
 * REMOVE the cookie, not record it as a blank value that keeps being sent.
 *
 * Shared by the two inline auth cookie merges (OAuth bootstrap and NTLM
 * sign-in). This is a request-cookie string builder, not a full jar: it tracks
 * only name/value and deletion, which is all the pre-`/csh` redirect chains
 * need. Domain/Path-scoped storage lives in `saas/cookie-jar.ts`.
 */
export function mergeSetCookies(existing: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split('; ').filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq >= 0) map.set(part.slice(0, eq), part.slice(eq + 1));
    else map.set(part, '');
  }
  for (const header of setCookieHeaders) {
    const segments = header.split(';');
    const nameValue = segments[0];
    if (!nameValue) continue;
    const eq = nameValue.indexOf('=');
    if (eq < 0) continue;
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    if (isDeletion(segments.slice(1))) {
      map.delete(name);
    } else {
      map.set(name, value);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A Set-Cookie deletes when Max-Age <= 0 or Expires is in the past. */
function isDeletion(attributes: string[]): boolean {
  for (const attr of attributes) {
    const eq = attr.indexOf('=');
    const key = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? '' : attr.slice(eq + 1).trim();
    if (key === 'max-age') {
      const secs = Number(val);
      if (Number.isFinite(secs) && secs <= 0) return true;
    } else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t) && t <= Date.now()) return true;
    }
  }
  return false;
}
