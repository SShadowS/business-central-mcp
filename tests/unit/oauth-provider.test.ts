import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthAuthProvider, mergeSetCookies, extractCsrf } from '../../src/connection/auth/oauth-provider.js';
import { OAuthTokenClient, type TokenSet } from '../../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../../src/connection/auth/token-cache.js';
import { ok } from '../../src/core/result.js';
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
    clientCredentials: async () => ok(TOKENS),
    startDeviceCode: async () => { throw new Error('device code should not run'); },
    pollDeviceCode: async () => { throw new Error('device code should not run'); },
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

  function makeProvider(client: OAuthTokenClient, extra?: { accessToken?: string }) {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-p-'));
    return new OAuthAuthProvider({
      baseUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      aadTenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 's',
      scope: 'https://api.businesscentral.dynamics.com/.default',
      accessToken: extra?.accessToken,
      stateDir: dir,
    }, createNullLogger(), client, new FileTokenCache(join(dir, 'oauth-tokens.json')));
  }

  it('uses a pre-supplied access token and skips the token client', async () => {
    const client = stubClient({
      clientCredentials: async () => { throw new Error('should not acquire'); },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 302,
      headers: {
        get: (n: string) => n.toLowerCase() === 'location' ? 'https://login.microsoftonline.com/x/oauth2/authorize' : null,
        getSetCookie: () => [] as string[],
      },
    })));

    const provider = makeProvider(client, { accessToken: 'pre-supplied' });
    const result = await provider.authenticate();
    expect(result.ok).toBe(true);
    expect(await provider.getAccessToken()).toBe('pre-supplied');
    expect(provider.getWebSocketHeaders()['Authorization']).toBe('Bearer pre-supplied');
  });

  it('client-credentials then captures antiforgery cookies from a same-origin 200', async () => {
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

  it('reuses a cached unexpired token without calling clientCredentials', async () => {
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
      clientSecret: 's',
      scope: 'https://api.businesscentral.dynamics.com/.default',
      stateDir: dir,
    }, createNullLogger(), stubClient({
      clientCredentials: async () => { throw new Error('should use cache'); },
    }), disk);

    expect(await provider.getAccessToken()).toBe('cached-tok');
  });
});
