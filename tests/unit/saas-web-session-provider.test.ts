import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaasWebSessionProvider } from '../../src/connection/auth/saas-web-session-provider.js';
import { FileCookieStore } from '../../src/connection/auth/saas/cookie-store.js';
import { CookieJar } from '../../src/connection/auth/saas/cookie-jar.js';
import { parseSaasUrl } from '../../src/connection/saas-url.js';
import { isErr, isOk, ok } from '../../src/core/result.js';
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
      // A signed-out shell still renders FixedEndPoint.start — just without
      // an accessToken. (A 200 with no FixedEndPoint at all is an
      // interstitial and classifies as retryable, not signed-out.)
      if (opts?.skipJwt) {
        return new Response('FixedEndPoint.start({"authentication":{"type":"aad"}});', { status: 200 });
      }
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-saas-prov-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCookies(): void {
    new FileCookieStore(join(dir, 'saas-web-cookies.json')).save(TENANT, 'DEV', [authCookie]);
  }

  function makeProvider(fetchFn: typeof fetch, extras: { jar?: CookieJar; loginFn?: () => Promise<ReturnType<typeof ok<void>>> } = {}): SaasWebSessionProvider {
    return new SaasWebSessionProvider({
      saas,
      stateDir: dir,
      usernamePrefill: 'user@t.com',
      loginTimeoutMs: 1000,
      opener: { open: () => false },
      fetchFn,
      logger: createNullLogger(),
      jar: extras.jar,
      loginFn: extras.loginFn,
    });
  }

  it('authenticate with valid stored cookies and portal GET 200 does not open login', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isOk(result)).toBe(true);
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getAccessToken).toBeUndefined();
  });

  it('stored cookies + portal 302 Entra opens login and returns SIGN_IN_REQUIRED when no display', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter({ entra: true }));
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('SIGN_IN_REQUIRED');
  });

  it('isAuthenticated stays true after invalidate; lastTabWsUrl is undefined', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    const prepared = await provider.prepare();
    expect(isOk(prepared)).toBe(true);
    if (isOk(prepared)) expect(prepared.value.wsUrl).toMatch(/\/csh$/);
    expect(provider.lastTabWsUrl).toMatch(/\/csh$/);
    provider.invalidate();
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.lastTabWsUrl).toBeUndefined();
  });

  it('second prepare does not GET the portal or POST /auth', async () => {
    seedCookies();
    const { fetchFn, calls } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    const first = await provider.prepare();
    expect(isOk(first)).toBe(true);
    const afterFirst = calls.length;
    const second = await provider.prepare();
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(second.value.sessionTenantId).toBe(first.value.sessionTenantId);
      expect(second.value.wsUrl).not.toBe(first.value.wsUrl);
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
    const result = await provider.prepare();
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
    const first = await provider.prepare();
    expect(isErr(first)).toBe(true);
    expect(provider.isClusterBound).toBe(false);
    csrfStatus = 200;
    const authCallsBefore = calls.filter((c) => c.url.includes('/auth?')).length;
    const second = await provider.prepare();
    expect(isOk(second)).toBe(true);
    expect(calls.filter((c) => c.url.includes('/auth?')).length).toBeGreaterThan(authCallsBefore);
  });

  it('stored cookies + persistent signed-out shell (no accessToken) escalates to sign-in after the window', async () => {
    // A token-less shell is strong but not conclusive evidence of a dead
    // session (the portal's silent token acquisition can transiently fail on
    // a LIVE session), so it goes through the same windowed escalation as
    // unclassifiable shells instead of destroying cookies on one sighting.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(defaultRouter({ skipJwt: true }));
      const provider = makeProvider(fetchFn);
      const first = await provider.authenticate();
      expect(isErr(first) && first.error.code === 'CONNECTION_ERROR').toBe(true);
      await provider.authenticate();
      vi.setSystemTime(Date.now() + 61_000);
      const third = await provider.authenticate();
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stored cookies + same-origin 302 to the signed-in shell authenticates without login', async () => {
    seedCookies();
    const base = defaultRouter();
    let redirected = false;
    const { fetchFn } = recordFetch((url) => {
      if (url === PORTAL && !redirected) {
        redirected = true;
        return new Response('', { status: 302, headers: { Location: `${PORTAL}?canonical=1` } });
      }
      return base(url);
    });
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isOk(result)).toBe(true);
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('stored cookies + portal 500 fails retryably and keeps the cookies', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(() => new Response('outage', { status: 500 }));
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('CONNECTION_ERROR');
    // A transient portal outage must not destroy the stored session.
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('escalates to sign-in after three unclassifiable probe failures spanning the window', async () => {
    // A persistently unclassifiable portal state (e.g. a signed-out state
    // that renders without FixedEndPoint.start) must not wedge retryable
    // forever — once the streak AND the minimum window are both met, the
    // stored cookies are treated as dead.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('<html>one moment…</html>', { status: 200 }));
      const provider = makeProvider(fetchFn);
      const first = await provider.authenticate();
      const second = await provider.authenticate();
      expect(isErr(first) && first.error.code === 'CONNECTION_ERROR').toBe(true);
      expect(isErr(second) && second.error.code === 'CONNECTION_ERROR').toBe(true);
      vi.setSystemTime(Date.now() + 61_000);
      const third = await provider.authenticate();
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.code).toBe('SIGN_IN_REQUIRED');
      expect(provider.isAuthenticated()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rapid burst of unclassifiable shells within the escalation window stays retryable', async () => {
    // SessionManager's backoff ladder can produce 3+ attempts within seconds;
    // a portal interstitial lasting a few seconds must not destroy valid
    // persisted cookies — the streak alone is not enough, time must pass too.
    seedCookies();
    const { fetchFn } = recordFetch(() => new Response('<html>one moment…</html>', { status: 200 }));
    const provider = makeProvider(fetchFn);
    const a1 = await provider.authenticate();
    const p1 = await provider.prepare();
    const p2 = await provider.prepare();
    const a2 = await provider.authenticate();
    for (const r of [a1, p1, p2, a2]) {
      expect(isErr(r) && r.error.code === 'CONNECTION_ERROR').toBe(true);
    }
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('a thrown network error during prepare surfaces as a retryable Result, not an exception', async () => {
    seedCookies();
    let network: 'ok' | 'down' = 'ok';
    const base = defaultRouter();
    const { fetchFn } = recordFetch((url) => {
      if (network === 'down') throw new TypeError('fetch failed: ECONNRESET');
      return base(url);
    });
    const provider = makeProvider(fetchFn);
    const authed = await provider.authenticate();
    expect(isOk(authed)).toBe(true);
    network = 'down';
    const prepared = await provider.prepare();
    expect(isErr(prepared)).toBe(true);
    if (isErr(prepared)) expect(prepared.error.code).toBe('CONNECTION_ERROR');
  });

  it('a successful probe resets the failure streak', async () => {
    seedCookies();
    let broken = true;
    const base = defaultRouter();
    const { fetchFn } = recordFetch((url) =>
      broken && url === PORTAL ? new Response('<html>one moment…</html>', { status: 200 }) : base(url),
    );
    const provider = makeProvider(fetchFn);
    await provider.authenticate();
    await provider.authenticate();
    broken = false;
    const recovered = await provider.authenticate();
    expect(isOk(recovered)).toBe(true);
    broken = true;
    // Streak restarted: two more failures stay retryable, no sign-in pop.
    const again = await provider.authenticate();
    expect(isErr(again) && again.error.code === 'CONNECTION_ERROR').toBe(true);
  });

  it('escalates through the production create flow: authenticate once, then repeated prepare failures', async () => {
    // After the first authenticate(), isAuthenticated() stays true and
    // ConnectionFactory.create skips straight to prepare() — so escalation
    // must count unclassifiable shells seen by bindAndMint too, and the
    // threshold must flip isAuthenticated() false so create() re-enters
    // authenticate() and reopens sign-in.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('<html>one moment</html>', { status: 200 }));
      const provider = makeProvider(fetchFn);
      const auth1 = await provider.authenticate();
      expect(isErr(auth1) && auth1.error.code === 'CONNECTION_ERROR').toBe(true);
      expect(provider.isAuthenticated()).toBe(true);
      const prep1 = await provider.prepare();
      expect(isErr(prep1)).toBe(true);
      expect(provider.isAuthenticated()).toBe(true);
      vi.setSystemTime(Date.now() + 61_000);
      const prep2 = await provider.prepare();
      expect(isErr(prep2)).toBe(true);
      // Third unclassifiable shell past the window: cookies cleared, so
      // create() re-authenticates.
      expect(provider.isAuthenticated()).toBe(false);
      const auth2 = await provider.authenticate();
      expect(isErr(auth2)).toBe(true);
      if (isErr(auth2)) expect(auth2.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalation cleanses the persisted store — a canceled sign-in is re-offered immediately', async () => {
    // Clearing only the in-memory jar let loadStoredCookies() resurrect the
    // proven-dead cookies from disk on every authenticate(), forcing the user
    // through fresh retryable cycles after canceling the sign-in window.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('<html>one moment</html>', { status: 200 }));
      const provider = makeProvider(fetchFn);
      await provider.authenticate();
      await provider.prepare();
      vi.setSystemTime(Date.now() + 61_000);
      const offered = await provider.authenticate();
      expect(isErr(offered)).toBe(true);
      if (isErr(offered)) expect(offered.error.code).toBe('SIGN_IN_REQUIRED');
      // Sign-in was canceled (no display); the NEXT attempt must offer
      // sign-in again immediately, not resurrect dead cookies into more
      // retry cycles.
      const again = await provider.authenticate();
      expect(isErr(again)).toBe(true);
      if (isErr(again)) expect(again.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('unclassifiable shells accumulate across interleaved network failures without either resetting the other', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      let mode: 'shell' | 'net' = 'shell';
      const { fetchFn } = recordFetch(() => {
        if (mode === 'net') throw new Error('ECONNRESET');
        return new Response('<html>one moment</html>', { status: 200 });
      });
      const provider = makeProvider(fetchFn);
      const s1 = await provider.authenticate();
      expect(isErr(s1) && s1.error.code === 'CONNECTION_ERROR').toBe(true);
      mode = 'net';
      const n1 = await provider.authenticate();
      expect(isErr(n1) && n1.error.code === 'CONNECTION_ERROR').toBe(true);
      expect(provider.isAuthenticated()).toBe(true);
      mode = 'shell';
      await provider.authenticate();
      mode = 'net';
      await provider.authenticate();
      expect(provider.isAuthenticated()).toBe(true);
      vi.setSystemTime(Date.now() + 61_000);
      mode = 'shell';
      const third = await provider.authenticate();
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale streak ages out — an old burst plus one new interstitial does not kill the session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('<html>one moment</html>', { status: 200 }));
      const provider = makeProvider(fetchFn);
      // Quick burst: streak 3, but window unmet — all retryable.
      await provider.authenticate();
      await provider.authenticate();
      await provider.authenticate();
      expect(provider.isAuthenticated()).toBe(true);
      // Long idle gap: the old burst is no longer evidence about today.
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      const fresh = await provider.authenticate();
      expect(isErr(fresh) && fresh.error.code === 'CONNECTION_ERROR').toBe(true);
      expect(provider.isAuthenticated()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a persistent portal 403 with stored cookies escalates like an unclassifiable shell', async () => {
    // A bare 401/403 on the shell GET (session revoked without an Entra
    // redirect) must not stay retryable forever — it rides the same windowed
    // streak, so sign-in eventually reopens.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('forbidden', { status: 403 }));
      const provider = makeProvider(fetchFn);
      await provider.authenticate();
      await provider.authenticate();
      vi.setSystemTime(Date.now() + 61_000);
      const third = await provider.authenticate();
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sporadic usage escalates via failed episodes — no dead band between window and staleness', async () => {
    // Attempts separated by more than the staleness gap reset the streak, so
    // streak+window alone can never fire for a client polling every 15
    // minutes. Two fully-failed episodes plus fresh evidence must escalate.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('<html>one moment</html>', { status: 200 }));
      const provider = makeProvider(fetchFn);
      for (let episode = 0; episode < 2; episode++) {
        // A quick burst (backoff-ladder shaped): streak fills, window unmet.
        await provider.authenticate();
        await provider.authenticate();
        await provider.authenticate();
        expect(provider.isAuthenticated()).toBe(true);
        vi.setSystemTime(Date.now() + 15 * 60_000);
      }
      const escalated = await provider.authenticate();
      expect(isErr(escalated)).toBe(true);
      if (isErr(escalated)) expect(escalated.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('single attempts spaced beyond the staleness gap still escalate — no dependence on backoff bursts', async () => {
    // With BC_RECONNECT_MAX_RETRIES=0 each tool call probes once; a revoked
    // session must still reach sign-in. Three failures with zero successes
    // in between, however far apart, are enough.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      seedCookies();
      const { fetchFn } = recordFetch(() => new Response('forbidden', { status: 403 }));
      const provider = makeProvider(fetchFn);
      const first = await provider.authenticate();
      expect(isErr(first) && first.error.code === 'CONNECTION_ERROR').toBe(true);
      vi.setSystemTime(Date.now() + 15 * 60_000);
      const second = await provider.authenticate();
      expect(isErr(second) && second.error.code === 'CONNECTION_ERROR').toBe(true);
      vi.setSystemTime(Date.now() + 15 * 60_000);
      const third = await provider.authenticate();
      expect(isErr(third)).toBe(true);
      if (isErr(third)) expect(third.error.code).toBe('SIGN_IN_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('post-login verification rejects a session the portal does not accept (wrong account/tenant)', async () => {
    const { fetchFn } = recordFetch(() => new Response('', {
      status: 302,
      headers: { Location: 'https://login.microsoftonline.com/common/oauth2/authorize' },
    }));
    const jar = new CookieJar();
    // A sign-in that landed cookies for some OTHER tenant's GUID.
    jar.load([{ ...authCookie, name: 'bb258e74-0d74-4054-b2d6-41f6c19bcd6e.auth' }]);
    const provider = makeProvider(fetchFn, { jar });
    const verify = (provider as unknown as {
      verifyFreshLogin(): Promise<import('../../src/core/result.js').Result<unknown, { code: string; message: string }>>;
    }).verifyFreshLogin();
    const result = await verify;
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('AUTHENTICATION_ERROR');
      expect(result.error.message).toMatch(/account|tenant/i);
    }
    expect(provider.isAuthenticated()).toBe(false);
  });

  it('network failures do not count toward escalation — cookies survive an outage of any length', async () => {
    seedCookies();
    const { fetchFn } = recordFetch(() => { throw new Error('ECONNREFUSED'); });
    const provider = makeProvider(fetchFn);
    for (let i = 0; i < 4; i++) {
      const result = await provider.authenticate();
      expect(isErr(result) && result.error.code === 'CONNECTION_ERROR').toBe(true);
    }
    // 'Portal unreachable' is evidence of nothing about the session; only
    // 'portal reachable but shell unclassifiable' may escalate to sign-in.
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('missing cookies returns SignInRequiredError from the owned login window', async () => {
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn);
    const result = await provider.authenticate();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(SignInRequiredError);
      expect(result.error.code).toBe('SIGN_IN_REQUIRED');
    }
  });

  it('authenticate succeeds from a shared in-memory jar without a store file', async () => {
    const jar = new CookieJar();
    jar.load([authCookie]);
    const { fetchFn } = recordFetch(defaultRouter());
    const provider = makeProvider(fetchFn, { jar });
    const result = await provider.authenticate();
    expect(isOk(result)).toBe(true);
  });
});
