import { SAAS_PORTAL_HOST } from './ests-types.js';

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires?: number;
  hostOnly?: boolean;
}

export class CookieJar {
  private cookies: CookieRecord[] = [];

  absorb(res: Response, requestUrl: string): void {
    let req: URL;
    try {
      req = new URL(requestUrl);
    } catch {
      return;
    }
    this.pruneExpired();
    const set = res.headers.getSetCookie?.() ?? [];
    for (const header of set) {
      const parsed = parseSetCookie(header, req);
      if (parsed) this.upsert(parsed);
    }
  }

  headerFor(url: string): string {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return '';
    }
    const now = Date.now();
    const parts: string[] = [];
    for (const c of this.cookies) {
      if (c.expires !== undefined && c.expires <= now) continue;
      if (!domainMatches(c, target.hostname)) continue;
      if (!pathMatches(c.path, target.pathname)) continue;
      if (c.secure && target.protocol !== 'https:') continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join('; ');
  }

  names(): string[] {
    const now = Date.now();
    return [...new Set(this.cookies.filter((c) => c.expires === undefined || c.expires > now).map((c) => c.name))];
  }

  hasPortalAuth(): boolean {
    const now = Date.now();
    return this.cookies.some((c) =>
      (c.expires === undefined || c.expires > now) && isPortalAuthCookie(c),
    );
  }

  persistable(): CookieRecord[] {
    const now = Date.now();
    return this.cookies
      .filter((c) => (c.expires === undefined || c.expires > now) && isPersistableDomain(c.domain))
      .map((c) => ({ ...c }));
  }

  load(records: CookieRecord[]): void {
    for (const rec of records) this.upsert({ ...rec });
  }

  /**
   * Drop the portal auth cookies. Used when the portal stops honoring the
   * stored session (redirect to Entra), so isAuthenticated() flips false and
   * a fresh sign-in can run.
   */
  clearPortalAuth(): void {
    this.cookies = this.cookies.filter((c) => !isPortalAuthCookie(c));
  }

  /**
   * Drop cookies scoped under a path prefix (e.g. a discarded per-tab path
   * `/tenant/{runtimeId}/tab/{tabId}`), so per-tab cookies do not accumulate
   * one set per WebSocket reconnect.
   */
  evictPathPrefix(prefix: string): void {
    if (!prefix || prefix === '/') return;
    this.cookies = this.cookies.filter((c) => !c.path.startsWith(prefix));
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
  }

  private upsert(cookie: CookieRecord): void {
    const idx = this.cookies.findIndex((c) =>
      c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (idx >= 0) this.cookies[idx] = cookie;
    else this.cookies.push(cookie);
  }
}

function parseSetCookie(header: string, req: URL): CookieRecord | undefined {
  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  const nv = parts[0];
  if (!nv) return undefined;
  const eq = nv.indexOf('=');
  if (eq < 0) return undefined;
  const name = nv.slice(0, eq);
  const value = nv.slice(eq + 1);
  if (!name) return undefined;

  let domain = req.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultPath(req.pathname);
  let secure = false;
  let expires: number | undefined;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i]!;
    const aEq = attr.indexOf('=');
    const key = (aEq < 0 ? attr : attr.slice(0, aEq)).trim().toLowerCase();
    const val = aEq < 0 ? '' : attr.slice(aEq + 1).trim();
    if (key === 'domain' && val) {
      const d = val.replace(/^\./, '').toLowerCase();
      // Reject a Domain scoped to a bare public suffix (a single label such as
      // "com" or "localhost"). Such a cookie would otherwise attach to every
      // host under that suffix the jar later contacts. A real registrable
      // domain (dynamics.com) has at least two labels and is kept.
      if (isBarePublicSuffix(d)) return undefined;
      if (!hostInDomain(req.hostname, d)) return undefined;
      domain = d;
      hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) {
      path = val;
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'max-age') {
      const secs = Number(val);
      if (Number.isFinite(secs)) expires = Date.now() + secs * 1000;
    } else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    }
  }

  return { name, value, domain, path, secure, expires, hostOnly };
}

function defaultPath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const i = pathname.lastIndexOf('/');
  if (i <= 0) return '/';
  return pathname.slice(0, i);
}

/**
 * A domain with no dot is a bare public suffix / TLD (e.g. "com", "localhost").
 * No legitimate cookie for a BC/ESTS host is scoped this broadly. This is a
 * pragmatic guard, not a full Public Suffix List: multi-label registrable
 * domains (dynamics.com) are allowed exactly as a browser would.
 */
function isBarePublicSuffix(domain: string): boolean {
  return !domain.includes('.');
}

function hostInDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function domainMatches(cookie: CookieRecord, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const d = cookie.domain.toLowerCase();
  if (cookie.hostOnly) return host === d;
  return host === d || host.endsWith(`.${d}`);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  const path = requestPath || '/';
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path.charAt(cookiePath.length) === '/';
}

function isPortalHost(domain: string): boolean {
  return domain.toLowerCase() === SAAS_PORTAL_HOST;
}

/**
 * The portal session cookie is `{tenantGuid}.auth`, named by the RESOLVED AAD
 * GUID — for a domain-form tenant URL (contoso.onmicrosoft.com) it never
 * equals the configured tenant id, so it is matched by suffix. The jar is
 * tenant-scoped (one store file per tenant+environment), so suffix matching
 * cannot cross tenants.
 */
function isPortalAuthCookie(c: CookieRecord): boolean {
  if (!isPortalHost(c.domain)) return false;
  return c.name.endsWith('.auth') || c.name === '.AspNetCore.Cookies';
}

function isPersistableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.includes('appservices.')) return false;
  return d === SAAS_PORTAL_HOST || d.endsWith(`.${SAAS_PORTAL_HOST}`);
}
