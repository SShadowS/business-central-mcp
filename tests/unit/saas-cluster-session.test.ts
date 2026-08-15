import { describe, it, expect } from 'vitest';
import { SaasClusterSession } from '../../src/connection/auth/saas/cluster-session.js';
import { CookieJar } from '../../src/connection/auth/saas/cookie-jar.js';
import { parseSaasUrl } from '../../src/connection/saas-url.js';
import { isErr, isOk } from '../../src/core/result.js';
import type { Logger } from '../../src/core/logger.js';
import type { FixedEndPointAuth } from '../../src/connection/auth/saas/ests-types.js';
import { SAAS_PORTAL_ORIGIN, SAAS_BROWSER_UA } from '../../src/connection/auth/saas/ests-types.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const PORTAL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
const HOST = 'msft1eu2as5743-3mujv5i.appservices.us.businesscentral.dynamics.com';
const RUNTIME = 'msft1a6720t30818544';
const TID = 'bb258e74-0d74-4054-b2d6-41f6c19bcd6e';
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.sig';
const CODE = 'authz-code-fixture';

const saas = parseSaasUrl(PORTAL)!;

const auth: FixedEndPointAuth = {
  accessToken: JWT,
  authorizationCode: CODE,
  homeAccountId: 'oid.tid',
  sharedAuthCookieName: '',
};

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (msg: string, ctx?: Record<string, unknown>) => {
    lines.push(msg);
    if (ctx) lines.push(JSON.stringify(ctx));
  };
  return {
    lines,
    logger: { info: push, warn: push, error: push, debug: (_c, m, x) => push(m, x) },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers, body: String(init?.body ?? '') });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('SaasClusterSession', () => {
  it('discover GET includes autoProvision=true and parses Ready', async () => {
    const { fetchFn, calls } = recordFetch(() => new Response(JSON.stringify({
      status: 'Ready',
      runtimeId: RUNTIME,
      data: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
    }), { status: 200 }));
    const session = new SaasClusterSession(fetchFn, capturingLogger().logger);
    const result = await session.discover(new CookieJar(), saas);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.runtimeId).toBe(RUNTIME);
      expect(new URL(result.value.clusterAddress).host).toBe(HOST);
    }
    expect(calls[0]!.url).toContain('autoProvision=true');
    expect(calls[0]!.url).toContain('/api/deployment');
  });

  it('shareAuthCookie posts subPath and FCE-CSRF-TOKEN', async () => {
    const { fetchFn, calls } = recordFetch(() => new Response('', { status: 200 }));
    const session = new SaasClusterSession(fetchFn, capturingLogger().logger);
    const result = await session.shareAuthCookie(new CookieJar(), saas, RUNTIME, 'fce-tok');
    expect(isOk(result)).toBe(true);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/authcookie/setcookie');
    expect(calls[0]!.body).toBe(JSON.stringify({ subPath: `/tenant/${RUNTIME}` }));
    expect(calls[0]!.headers['fce-csrf-token']).toBe('fce-tok');
  });

  it('authenticateToken posts to cluster /auth?tenant= and never /tab/', async () => {
    let rpc: { method?: string; params?: unknown[] } = {};
    const { fetchFn, calls } = recordFetch((url, init) => {
      rpc = JSON.parse(String(init?.body ?? '{}')) as typeof rpc;
      return new Response(JSON.stringify({ result: { csrfToken: 'csrf-1' } }), { status: 200 });
    });
    const cap = capturingLogger();
    const session = new SaasClusterSession(fetchFn, cap.logger);
    const result = await session.authenticateToken(new CookieJar(), HOST, RUNTIME, TID, auth);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('csrf-1');
    const url = calls[0]!.url;
    expect(url.startsWith(`https://${HOST}/auth?`)).toBe(true);
    expect(url).toContain(`tenant=${RUNTIME}`);
    expect(url).toContain('deviceCategory=0');
    expect(url).not.toContain('/tab/');
    expect(rpc.method).toBe('AUTHENTICATETOKEN');
    expect(rpc.params).toEqual(['OAUTH', JWT, false, CODE, 'oid.tid', '']);
    expect(calls[0]!.headers['origin']).toBe(SAAS_PORTAL_ORIGIN);
    expect(calls[0]!.headers['user-agent']).toBe(SAAS_BROWSER_UA);
    expect(cap.lines.join('\n')).not.toContain(JWT);
    expect(cap.lines.join('\n')).not.toContain(CODE);
  });

  it('authenticateToken RPC error is err', async () => {
    const { fetchFn } = recordFetch(() => new Response(JSON.stringify({
      error: { message: 'Problem detected for the tenant' },
    }), { status: 200 }));
    const session = new SaasClusterSession(fetchFn, capturingLogger().logger);
    const result = await session.authenticateToken(new CookieJar(), HOST, RUNTIME, TID, auth);
    expect(isErr(result)).toBe(true);
  });

  it('mintTab boots /v /boot /csrf and issues a new tabId each call', async () => {
    const { fetchFn, calls } = recordFetch((url) => {
      if (url.includes('/csrf')) return new Response(JSON.stringify({ csrfToken: 'from-json' }), { status: 200 });
      return new Response('ok', { status: 200 });
    });
    const session = new SaasClusterSession(fetchFn, capturingLogger().logger);
    const a = await session.mintTab(new CookieJar(), HOST, RUNTIME, PORTAL, '');
    const b = await session.mintTab(new CookieJar(), HOST, RUNTIME, PORTAL, '');
    expect(isOk(a) && isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.value.tabId).not.toBe(b.value.tabId);
      expect(a.value.tabBaseUrl).toContain(`/tenant/${RUNTIME}/tab/${a.value.tabId}`);
      expect(a.value.csrfToken).toBe('from-json');
    }
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths.some((p) => p.endsWith('/v'))).toBe(true);
    expect(paths.some((p) => p.includes('/boot/browser/desktop'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/csrf'))).toBe(true);
    expect(calls[0]!.headers['origin']).toBe(SAAS_PORTAL_ORIGIN);
    expect(calls[0]!.headers['user-agent']).toBe(SAAS_BROWSER_UA);
    expect(calls[0]!.headers['referer']).toBe(PORTAL);
  });

  it('readPortalShell GETs the portal and fails closed without accessToken', async () => {
    const cap = capturingLogger();
    const { fetchFn, calls } = recordFetch(() => new Response(
      `FixedEndPoint.start({"authentication":{"type":"aad"}});`,
      { status: 200 },
    ));
    const session = new SaasClusterSession(fetchFn, cap.logger);
    const result = await session.readPortalShell(new CookieJar(), saas);
    expect(isErr(result)).toBe(true);
    expect(calls[0]!.url).toBe(saas.portalUrl);
    expect(calls[0]!.headers['origin']).toBe(SAAS_PORTAL_ORIGIN);
  });

  it('readPortalShell returns AuthenticationError on Entra 302', async () => {
    const { fetchFn } = recordFetch(() => new Response('', {
      status: 302,
      headers: { Location: 'https://login.microsoftonline.com/common/oauth2/authorize' },
    }));
    const session = new SaasClusterSession(fetchFn, capturingLogger().logger);
    const result = await session.readPortalShell(new CookieJar(), saas);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('AUTHENTICATION_ERROR');
  });

  it('readPortalShell parses FixedEndPoint auth and never logs the JWT', async () => {
    const cap = capturingLogger();
    const html = [
      `<input id="RequestVerificationToken" value="fce-1">`,
      `FixedEndPoint.start({"authentication":{"accessToken":"${JWT}","authorizationCode":"${CODE}","homeAccountId":"h","sharedAuthCookieName":""}});`,
    ].join('');
    const { fetchFn } = recordFetch(() => new Response(html, { status: 200 }));
    const session = new SaasClusterSession(fetchFn, cap.logger);
    const result = await session.readPortalShell(new CookieJar(), saas);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.fceToken).toBe('fce-1');
      expect(result.value.auth.accessToken).toBe(JWT);
    }
    expect(cap.lines.join('\n')).not.toContain(JWT);
    expect(cap.lines.join('\n')).not.toContain(CODE);
  });
});
