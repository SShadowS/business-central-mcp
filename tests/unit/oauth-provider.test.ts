import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthAuthProvider, mergeSetCookies, extractCsrf } from '../../src/connection/auth/oauth-provider.js';
import { OAuthTokenClient, type TokenSet } from '../../src/connection/auth/oauth-token-client.js';
import { FileTokenCache, FilePendingDeviceCache } from '../../src/connection/auth/token-cache.js';
import { AuthenticationError, DeviceLoginRequiredError } from '../../src/core/errors.js';
import { ok, err } from '../../src/core/result.js';
import { createNullLogger } from '../../src/core/logger.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const TOKENS: TokenSet = {
  accessToken: 'access-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  tokenType: 'Bearer',
};

function stubClient(overrides?: Partial<OAuthTokenClient>): OAuthTokenClient {
  return {
    startDeviceCode: async () => ok({
      deviceCode: 'dev',
      userCode: 'CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
      message: 'open the page',
      intervalSec: 5,
      expiresAt: Date.now() + 900_000,
    }),
    pollDeviceCodeOnce: async () => ok(TOKENS),
    refresh: async () => ok(TOKENS),
    ...overrides,
  } as unknown as OAuthTokenClient;
}

describe('cookie helpers', () => {
  it('mergeSetCookies overwrites by name', () => {
    const merged = mergeSetCookies('a=1; b=2', ['b=3; Path=/', 'c=4; Secure']);
    expect(merged).toBe('a=1; b=3; c=4');
  });

  it('extractCsrf prefers an Antiforgery-named cookie', () => {
    const cookies = `${TENANT}.Antiforgery.FCE=CfDJ8csrf; .AspNetCore.Cookies=CfDJ8other`;
    expect(extractCsrf(cookies)).toBe('CfDJ8csrf');
  });
});

describe('OAuthAuthProvider', () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeProvider(client: OAuthTokenClient) {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-p-'));
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    disk.save({
      accessToken: TOKENS.accessToken,
      refreshToken: TOKENS.refreshToken,
      expiresAt: TOKENS.expiresAt,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    return new OAuthAuthProvider({
      baseUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      aadTenantId: TENANT,
      clientId: CLIENT,
      scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
      stateDir: dir,
    }, createNullLogger(), client, disk);
  }

  it('cached token then captures antiforgery cookies from a same-origin 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: {
        get: () => null,
        getSetCookie: () => [
          `${TENANT}.Antiforgery.FCE=CfDJ8tok; Path=/${TENANT}; Secure; HttpOnly`,
          'ASLBSA=aff; Path=/; Secure',
        ],
      },
    })));

    const provider = makeProvider(stubClient());
    const result = await provider.authenticate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.csrfToken).toBe('CfDJ8tok');
    expect(provider.getWebSocketQueryParams()).toEqual({ csrftoken: 'CfDJ8tok' });
    expect(provider.getWebSocketHeaders()['Cookie']).toContain('Antiforgery');
    expect(provider.getWebSocketHeaders()['Authorization']).toBe('Bearer access-1');
  });

  it('clears cookies when the portal redirects to Entra login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 302,
      headers: {
        get: (n: string) => n.toLowerCase() === 'location'
          ? `https://login.microsoftonline.com/${TENANT}/oauth2/authorize?client_id=996def3d`
          : null,
        getSetCookie: () => ['.AspNetCore.Correlation.x=N; Path=/remote-sign-in'],
      },
    })));

    const provider = makeProvider(stubClient());
    const result = await provider.authenticate();
    expect(result.ok).toBe(true);
    expect(provider.getWebSocketHeaders()['Cookie']).toBeUndefined();
    expect(provider.getWebSocketQueryParams()).toEqual({});
    // Token is still usable for OData
    expect(await provider.getAccessToken()).toBe('access-1');
  });

  it('invalidate drops cookies but getAccessToken still returns the cached token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: () => null, getSetCookie: () => [`${TENANT}.Antiforgery.FCE=CfDJ8x`] },
    })));
    const provider = makeProvider(stubClient());
    await provider.authenticate();
    expect(provider.isAuthenticated()).toBe(true);
    provider.invalidate();
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getWebSocketHeaders()['Cookie']).toBeUndefined();
    expect(await provider.getAccessToken()).toBe('access-1');
  });

  it('reuses a cached unexpired token without calling device-code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-p-'));
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    disk.save({
      accessToken: 'cached-tok',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: () => null, getSetCookie: () => [] as string[] },
    })));
    const provider = new OAuthAuthProvider({
      baseUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      aadTenantId: TENANT,
      clientId: CLIENT,
      scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
      stateDir: dir,
    }, createNullLogger(), stubClient({
      startDeviceCode: async () => { throw new Error('should use cache'); },
      pollDeviceCodeOnce: async () => { throw new Error('should use cache'); },
    }), disk);

    expect(await provider.getAccessToken()).toBe('cached-tok');
  });
});

describe('OAuthAuthProvider refresh single-flight', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeExpiredProvider(client: OAuthTokenClient) {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-sf-'));
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    disk.save({
      accessToken: 'stale',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 1000,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    return new OAuthAuthProvider({
      baseUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      aadTenantId: TENANT,
      clientId: CLIENT,
      scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
      stateDir: dir,
    }, createNullLogger(), client, disk);
  }

  it('concurrent getAccessToken at expiry runs ONE refresh grant (rotation-safe)', async () => {
    // Entra rotates refresh tokens: a second concurrent grant with the same
    // token gets invalid_grant and used to clear the freshly-persisted cache.
    const refresh = vi.fn(async (): Promise<ReturnType<typeof ok<TokenSet>>> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok({ ...TOKENS, accessToken: 'access-fresh', refreshToken: 'rt-new' });
    });
    const provider = makeExpiredProvider(stubClient({ refresh }));

    const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(a).toBe('access-fresh');
    expect(b).toBe('access-fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    expect(disk.load(CLIENT, TENANT)?.refreshToken).toBe('rt-new');
  });

  it('a loser of the old race no longer wipes the rotated token cache', async () => {
    // First grant succeeds; any (buggy) second grant would fail invalid_grant.
    let calls = 0;
    const refresh = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (calls === 1) return ok({ ...TOKENS, accessToken: 'access-fresh', refreshToken: 'rt-new' });
      return err(new AuthenticationError('invalid_grant', { oauthError: 'invalid_grant' }));
    });
    const start = vi.fn();
    const provider = makeExpiredProvider(stubClient({ refresh, startDeviceCode: start }));

    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    expect(disk.load(CLIENT, TENANT)?.accessToken).toBe('access-fresh');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('OAuthAuthProvider device-code state machine (fail-fast)', () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeProvider(client: OAuthTokenClient) {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-sm-'));
    return new OAuthAuthProvider({
      baseUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      aadTenantId: TENANT,
      clientId: CLIENT,
      scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
      stateDir: dir,
    }, createNullLogger(), client, new FileTokenCache(join(dir, 'oauth-tokens.json')));
  }

  function pendingCache(): FilePendingDeviceCache {
    return new FilePendingDeviceCache(join(dir, 'oauth-pending.json'));
  }

  function seedPending(userCode = 'OLD-CODE'): void {
    pendingCache().save({
      deviceCode: 'dev-pending',
      userCode,
      verificationUri: 'https://microsoft.com/devicelogin',
      intervalSec: 5,
      expiresAt: Date.now() + 900_000,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
  }

  it('no token, no pending: starts device code, saves pending, throws DEVICE_LOGIN_REQUIRED with URL + code', async () => {
    const start = vi.fn(async () => ok({
      deviceCode: 'dev',
      userCode: 'NEW-CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
      message: 'open the page',
      intervalSec: 5,
      expiresAt: Date.now() + 900_000,
    }));
    const provider = makeProvider(stubClient({ startDeviceCode: start }));

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: 'DEVICE_LOGIN_REQUIRED',
      userCode: 'NEW-CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
    });
    expect(pendingCache().load(CLIENT, TENANT)?.deviceCode).toBe('dev');
  });

  it('pending + authorization_pending: returns the SAME code without starting a new one', async () => {
    const start = vi.fn();
    const provider = makeProvider(stubClient({
      startDeviceCode: start,
      pollDeviceCodeOnce: async () => err(new AuthenticationError('authorization_pending', { oauthError: 'authorization_pending' })),
    }));
    seedPending('SAME-CODE');

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: 'DEVICE_LOGIN_REQUIRED',
      userCode: 'SAME-CODE',
    });
    expect(start).not.toHaveBeenCalled();
    expect(pendingCache().load(CLIENT, TENANT)?.userCode).toBe('SAME-CODE');
  });

  it('pending + sign-in completed: returns tokens, persists them, clears pending', async () => {
    const provider = makeProvider(stubClient({
      pollDeviceCodeOnce: async () => ok(TOKENS),
    }));
    seedPending();

    expect(await provider.getAccessToken()).toBe('access-1');
    expect(pendingCache().load(CLIENT, TENANT)).toBeUndefined();
    const disk = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    expect(disk.load(CLIENT, TENANT)?.accessToken).toBe('access-1');
  });

  it('pending + hard failure (expired_token): clears pending and starts a fresh code in the same call', async () => {
    const provider = makeProvider(stubClient({
      startDeviceCode: async () => ok({
        deviceCode: 'dev-2',
        userCode: 'FRESH-CODE',
        verificationUri: 'https://microsoft.com/devicelogin',
        message: 'open the page',
        intervalSec: 5,
        expiresAt: Date.now() + 900_000,
      }),
      pollDeviceCodeOnce: async () => err(new AuthenticationError('expired', { oauthError: 'expired_token' })),
    }));
    seedPending('OLD-CODE');

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: 'DEVICE_LOGIN_REQUIRED',
      userCode: 'FRESH-CODE',
    });
    expect(pendingCache().load(CLIENT, TENANT)?.deviceCode).toBe('dev-2');
  });

  it('expired pending entry: cleared and replaced by a fresh code', async () => {
    const poll = vi.fn();
    const provider = makeProvider(stubClient({
      startDeviceCode: async () => ok({
        deviceCode: 'dev-3',
        userCode: 'FRESH-CODE',
        verificationUri: 'https://microsoft.com/devicelogin',
        message: 'open the page',
        intervalSec: 5,
        expiresAt: Date.now() + 900_000,
      }),
      pollDeviceCodeOnce: poll,
    }));
    pendingCache().save({
      deviceCode: 'dev-old',
      userCode: 'OLD-CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
      intervalSec: 5,
      expiresAt: Date.now() - 1000,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });

    await expect(provider.getAccessToken()).rejects.toMatchObject({ userCode: 'FRESH-CODE' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('pending + network failure on poll: keeps the pending code and returns undefined (no churn)', async () => {
    const provider = makeProvider(stubClient({
      pollDeviceCodeOnce: async () => err(new AuthenticationError('Token request failed: fetch failed')),
    }));
    seedPending('KEEP-CODE');

    expect(await provider.getAccessToken()).toBeUndefined();
    expect(pendingCache().load(CLIENT, TENANT)?.userCode).toBe('KEEP-CODE');
  });

  it('pending + token-endpoint 5xx on poll: keeps the pending code (transient, no churn)', async () => {
    const provider = makeProvider(stubClient({
      pollDeviceCodeOnce: async () => err(new AuthenticationError('Token request failed: HTTP 503', { oauthError: 'http_503' })),
    }));
    seedPending('KEEP-CODE');

    expect(await provider.getAccessToken()).toBeUndefined();
    expect(pendingCache().load(CLIENT, TENANT)?.userCode).toBe('KEEP-CODE');
  });

  it('pending + non-JSON 200 on poll (captive portal): keeps the pending code, does not churn', async () => {
    // A proxy/captive-portal HTTP 200 that is not a token JSON yields the
    // synthetic oauthError 'http_200' (no real OAuth error field). Treating it
    // as a hard failure would clear the code the user is mid-typing.
    const start = vi.fn();
    const provider = makeProvider(stubClient({
      startDeviceCode: start,
      pollDeviceCodeOnce: async () => err(new AuthenticationError('Token request failed: HTTP 200', { oauthError: 'http_200' })),
    }));
    seedPending('KEEP-CODE');

    expect(await provider.getAccessToken()).toBeUndefined();
    expect(pendingCache().load(CLIENT, TENANT)?.userCode).toBe('KEEP-CODE');
    expect(start).not.toHaveBeenCalled();
  });

  it('authenticate() surfaces DEVICE_LOGIN_REQUIRED as a Result error (non-retryable for SessionManager)', async () => {
    const provider = makeProvider(stubClient());
    const result = await provider.authenticate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DeviceLoginRequiredError);
      expect(result.error.code).toBe('DEVICE_LOGIN_REQUIRED');
    }
  });
});
