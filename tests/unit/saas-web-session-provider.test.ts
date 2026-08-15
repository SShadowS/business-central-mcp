import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaasWebSessionProvider } from '../../src/connection/auth/saas-web-session-provider.js';
import { FileCookieStore } from '../../src/connection/auth/saas/cookie-store.js';
import { parseSaasUrl } from '../../src/connection/saas-url.js';
import { err, isErr, isOk, ok } from '../../src/core/result.js';
import { SignInRequiredError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { CookieRecord } from '../../src/connection/auth/saas/cookie-jar.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const PORTAL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
const HOST = 'msft1eu2as5743-3mujv5i.appservices.us.businesscentral.dynamics.com';
const RUNTIME = 'msft1a6720t30818544';
const TID = 'bb258e74-0d74-4054-b2d6-41f6c19bcd6e';
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.sig';
const saas = parseSaasUrl(PORTAL)!;

const authCookie: CookieRecord = {
  name: `${TENANT}.auth`,
  value: 'portal-auth',
  domain: 'businesscentral.dynamics.com',
  path: '/',
  secure: true,
};

const SHELL = [
  `<input id="RequestVerificationToken" value="fce-1">`,
  `FixedEndPoint.start({"authentication":{"accessToken":"${JWT}","authorizationCode":"authz","homeAccountId":"h","sharedAuthCookieName":""}});`,
].join('');

interface Call { url: string; method: string }

function recordFetch(handler: (url: string) => Response): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    return handler(url);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function defaultRouter(opts?: { csrfStatus?: number; skipJwt?: boolean; entra?: boolean }): (url: string) => Response {
  return (url) => {
    const u = new URL(url);
    if (u.hostname === 'businesscentral.dynamics.com' && !u.pathname.includes('/api/')) {
      if (opts?.entra) {
        return new Response('', { status: 302, headers: { Location: 'https://login.microsoftonline.com/x' } });
      }
      if (opts?.skipJwt) return new Response('no jwt', { status: 200 });
      return new Response(SHELL, { status: 200 });
    }
    if (u.pathname.includes('/api/deployment')) {
      return new Response(JSON.stringify({
        status: 'Ready',
        runtimeId: RUNTIME,
        data: `https://${HOST}/?tenant=${RUNTIME}&tid=${TID}`,
      }), { status: 200 });
    }
    if (u.pathname.includes('/setcookie')) return new Response('', { status: 200 });
    if (u.pathname === '/auth' || u.pathname.endsWith('/auth')) {
      return new Response(JSON.stringify({ result: { csrfToken: 'csrf-hint' } }), { status: 200 });
    }
    if (u.pathname.endsWith('/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'tab-csrf' }), { status: opts?.csrfStatus ?? 200 });
    }
    return new Response('ok', { status: 200 });
  };
}

describe('SaasWebSessionProvider', () => {
  let dir: string;
  let ensurePortalSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-saas-prov-'));
    ensurePortalSession = vi.fn(async () => err(new SignInRequiredError(
      'A display is required to sign in to Business Central Online.',
      { openedWindow: false, reason: 'no_display' },
    )));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCookies(): void {
    new FileCookieStore(join(dir, 'saas-web-cookies.json')).save(TENANT, 'DEV', [authCookie]);
  }

  function makeProvider(fetchFn: typeof fetch): SaasWebSessionProvider {
    return new SaasWebSessionProvider({
      saas,
      stateDir: dir,
      usernamePrefill: 'user@t.com',
      loginTimeoutMs: 1000,
      opener: { open: () => false },
      ensurePortalSession,
      fetchFn,
      logger: createNullLogger(),
    });
  }

  it('authenticate with valid stored cookies and portal GET 200 does not call ensurePortalSession', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isOk(result)).toBe(true);
    expect(ensurePortalSession).not.toHaveBeenCalled();
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getAccessToken).toBeUndefined();
  });

  it('stored cookies + portal 302 Entra invokes ensurePortalSession', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter({ entra: true }));
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(ensurePortalSession).toHaveBeenCalledOnce();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('SIGN_IN_REQUIRED');
  });

  it('isAuthenticated stays true after invalidate; getWebSocketUrl is undefined', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    await provider.prepareConnection();
    expect(provider.getWebSocketUrl()).toMatch(/\/csh$/);
    provider.invalidate();
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getWebSocketUrl()).toBeUndefined();
  });

  it('second prepareConnection does not GET the portal or POST /auth', async () => {
    seedCookies();
    const { fetchFn, calls } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    const first = await provider.prepareConnection();
    expect(isOk(first)).toBe(true);
    const afterFirst = calls.length;
    const second = await provider.prepareConnection();
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(second.value.tabId).not.toBe(first.value.tabId);
    }
    const extra = calls.slice(afterFirst);
    expect(extra.some((c) => c.url === PORTAL && c.method === 'GET')).toBe(false);
    expect(extra.some((c) => c.url.includes('/auth?'))).toBe(false);
    expect(extra.some((c) => c.url.includes('/csrf'))).toBe(true);
  });

  it('missing JWT fails closed without mintTab', async () => {
    seedCookies();
    const { fetchFn, calls } = recordFetch(defaultRouter({ skipJwt: true }));
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    const result = await provider.prepareConnection();
    expect(isErr(result)).toBe(true);
    expect(calls.some((c) => c.url.includes('/csrf'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/auth?'))).toBe(false);
  });

  it('mintTab /csrf HTTP 401 unbinds the cluster so the next prepare POSTs /auth', async () => {
    seedCookies();
    let csrfStatus = 401;
    const { fetchFn, calls } = recordFetch((url) => defaultRouter({ csrfStatus })(url));
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    const first = await provider.prepareConnection();
    expect(isErr(first)).toBe(true);
    expect(provider.isClusterBound).toBe(false);
    csrfStatus = 200;
    const authCallsBefore = calls.filter((c) => c.url.includes('/auth?')).length;
    const second = await provider.prepareConnection();
    expect(isOk(second)).toBe(true);
    expect(calls.filter((c) => c.url.includes('/auth?')).length).toBeGreaterThan(authCallsBefore);
  });

  it('missing cookies returns SignInRequiredError from ensurePortalSession', async () => {
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(SignInRequiredError);
      expect(result.error.code).toBe('SIGN_IN_REQUIRED');
    }
  });
});
