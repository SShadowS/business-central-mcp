import { describe, it, expect, vi } from 'vitest';
import { OAuthTokenClient } from '../../src/connection/auth/oauth-token-client.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const CLIENT = '11111111-1111-1111-1111-111111111111';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function makeClient(fetchFn: typeof fetch, sleep = async () => {}) {
  return new OAuthTokenClient(
    {
      aadTenantId: TENANT,
      clientId: CLIENT,
      scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
    },
    fetchFn,
    sleep,
  );
}

describe('OAuthTokenClient.deviceCode', () => {
  it('starts a device code and polls through authorization_pending to a token', async () => {
    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/devicecode')) {
        return jsonResponse(200, {
          device_code: 'dev',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 1,
          message: 'open the page',
        });
      }
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return jsonResponse(400, { error: 'authorization_pending', error_description: 'waiting' });
      }
      return jsonResponse(200, { access_token: 'user-tok', refresh_token: 'rt', expires_in: 3600 });
    });

    const client = new OAuthTokenClient(
      { aadTenantId: TENANT, clientId: CLIENT, scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access' },
      fetchFn as unknown as typeof fetch,
      async () => {},
    );
    const started = await client.startDeviceCode();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.userCode).toBe('ABCD-EFGH');

    const tokens = await client.pollDeviceCode(started.value);
    expect(tokens.ok).toBe(true);
    if (!tokens.ok) return;
    expect(tokens.value.accessToken).toBe('user-tok');
    expect(tokens.value.refreshToken).toBe('rt');
  });

  it('increases the interval on slow_down and then succeeds', async () => {
    const sleeps: number[] = [];
    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/devicecode')) {
        return jsonResponse(200, {
          device_code: 'dev',
          user_code: 'X',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
          message: 'go',
        });
      }
      tokenCalls += 1;
      if (tokenCalls === 1) return jsonResponse(400, { error: 'slow_down' });
      return jsonResponse(200, { access_token: 'tok', expires_in: 100 });
    });
    const client = new OAuthTokenClient(
      { aadTenantId: TENANT, clientId: CLIENT, scope: 's' },
      fetchFn as unknown as typeof fetch,
      async (ms) => { sleeps.push(ms); },
    );
    const started = await client.startDeviceCode();
    if (!started.ok) throw new Error('start failed');
    const tokens = await client.pollDeviceCode(started.value);
    expect(tokens.ok).toBe(true);
    expect(sleeps[0]).toBe(5000);
    expect(sleeps[1]).toBe(10000);
  });

  it('pollDeviceCodeOnce does not sleep and returns pending as an error', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/devicecode')) {
        return jsonResponse(200, {
          device_code: 'dev',
          user_code: 'X',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        });
      }
      return jsonResponse(400, { error: 'authorization_pending' });
    });
    const client = new OAuthTokenClient(
      { aadTenantId: TENANT, clientId: CLIENT, scope: 's' },
      fetchFn as unknown as typeof fetch,
      async (ms) => { sleeps.push(ms); },
    );
    const started = await client.startDeviceCode();
    if (!started.ok) throw new Error('start failed');
    const once = await client.pollDeviceCodeOnce(started.value);
    expect(once.ok).toBe(false);
    if (once.ok) return;
    expect(once.error.context?.['oauthError']).toBe('authorization_pending');
    expect(sleeps).toEqual([]);
  });
});

describe('OAuthTokenClient.refresh', () => {
  it('posts the refresh_token grant', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {
      access_token: 'new',
      refresh_token: 'rt2',
      expires_in: 3600,
    }));
    const result = await makeClient(fetchFn as unknown as typeof fetch).refresh('rt1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accessToken).toBe('new');
    expect(String((fetchFn.mock.calls[0] as [string, RequestInit])[1]?.body)).toContain('grant_type=refresh_token');
  });
});
