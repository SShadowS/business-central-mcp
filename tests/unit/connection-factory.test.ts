import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpStatusFromWsMessage } from '../../src/connection/bc-websocket.js';
import { isDeadClusterStatus } from '../../src/connection/auth/auth-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { ok, err } from '../../src/core/result.js';
import { ConnectionError, SignInRequiredError } from '../../src/core/errors.js';
import { bindingFromBaseUrl, type IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCWebSocketConfig } from '../../src/connection/bc-websocket.js';
import type { BCConfig } from '../../src/core/config.js';

function makeConfig(baseUrl: string): BCConfig {
  return {
    baseUrl,
    username: 'u',
    password: 'p',
    tenantId: 'default',
    profile: '',
    applicationId: '',
    clientVersionString: '27.0.0.0',
    serverMajor: 27,
    timeoutMs: 1000,
    invokeTimeoutMs: 1000,
    reconnectMaxRetries: 0,
    reconnectBaseDelayMs: 0,
    odataUrl: '',
    odataCompanyName: undefined,
  };
}

function authFor(baseUrl: string, extras: Partial<IBCAuthProvider> = {}): IBCAuthProvider {
  return {
    isAuthenticated: () => true,
    authenticate: async () => ok({ cookies: 'c=1', csrfToken: 'tok' }),
    prepare: async () => ok(bindingFromBaseUrl(baseUrl, 'default')),
    getWebSocketHeaders: () => ({ Cookie: 'c=1' }),
    getWebSocketQueryParams: () => ({ csrftoken: 'tok' }),
    invalidate: () => {},
    unboundCluster: () => {},
    ...extras,
  };
}

describe('dead-cluster status', () => {
  it('parses Unexpected server response from the ws client', () => {
    expect(httpStatusFromWsMessage('Unexpected server response: 500')).toBe(500);
    expect(httpStatusFromWsMessage('Unexpected server response: 403')).toBe(403);
    expect(httpStatusFromWsMessage('upgrade failed')).toBeUndefined();
  });

  it('treats only 401/403/500 as dead cluster', () => {
    expect(isDeadClusterStatus(500)).toBe(true);
    expect(isDeadClusterStatus(403)).toBe(true);
    expect(isDeadClusterStatus(401)).toBe(true);
    expect(isDeadClusterStatus(502)).toBe(false);
    expect(isDeadClusterStatus(undefined)).toBe(false);
  });
});

describe('ConnectionFactory WebSocket Origin (BC 28.3 origin validation)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends Origin from prepare() binding', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const factory = new ConnectionFactory(authFor('http://cronus28/BC'), makeConfig('http://cronus28/BC'), createNullLogger());
    await factory.create();
    expect(captured?.headers.Origin).toBe('http://cronus28');
    expect(captured?.url).toContain('ws://cronus28/BC/csh');
  });

  it('omits the base path and keeps a non-default port in the Origin', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const base = 'https://bc.example.com:8443/BC';
    const factory = new ConnectionFactory(authFor(base), makeConfig(base), createNullLogger());
    await factory.create();
    expect(captured?.headers.Origin).toBe('https://bc.example.com:8443');
  });

  it('omits empty query params such as a missing csrftoken', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const base = 'https://businesscentral.dynamics.com/t/DEV';
    const factory = new ConnectionFactory(
      authFor(base, { getWebSocketQueryParams: () => ({}) }),
      makeConfig(base),
      createNullLogger(),
    );
    await factory.create();
    expect(captured?.url).toContain('/csh?');
    expect(captured?.url).not.toContain('csrftoken=');
    expect(captured?.url).toContain('ackseqnb=-1');
    expect(captured?.headers.Origin).toBe('https://businesscentral.dynamics.com');
  });

  it('uses prepare() binding for SaaS cluster URL and portal Origin', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const prepares = vi.fn(async () => ok({
      wsUrl: 'wss://cluster.example/tenant/msft1/tab/TAB/csh',
      origin: 'https://businesscentral.dynamics.com',
      httpBaseUrl: 'https://cluster.example/tenant/msft1/tab/TAB',
      sessionTenantId: 'msft1',
    }));
    const saasAuth = authFor('https://businesscentral.dynamics.com/t/DEV', {
      getWebSocketHeaders: () => ({
        Cookie: 'c=1',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://businesscentral.dynamics.com/t/DEV',
      }),
      getWebSocketQueryParams: () => ({ csrftoken: 'csrf' }),
      prepare: prepares,
    });
    const factory = new ConnectionFactory(saasAuth, makeConfig('https://businesscentral.dynamics.com/t/DEV'), createNullLogger());
    await factory.create();
    await factory.create();
    expect(prepares).toHaveBeenCalledTimes(2);
    expect(captured?.headers.Origin).toBe('https://businesscentral.dynamics.com');
    expect(captured?.headers.Origin).not.toBe('https://cluster.example');
    expect(captured?.url).toContain('wss://cluster.example/tenant/msft1/tab/TAB/csh');
    expect(captured?.url).toContain('ackseqnb=-1');
    expect(captured?.url).toContain('csrftoken=csrf');
    expect(factory.sessionTenantId).toBe('msft1');
  });

  it('calls invalidate when the WebSocket connect fails', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(err(new ConnectionError('upgrade failed')));
    const invalidate = vi.fn();
    const factory = new ConnectionFactory(
      authFor('http://cronus28/BC', { invalidate }),
      makeConfig('http://cronus28/BC'),
      createNullLogger(),
    );
    const result = await factory.create();
    expect(result.ok).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('calls unboundCluster only when the WS error has a dead-cluster status', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(
      err(new ConnectionError('Unexpected server response: 500', { status: 500 })),
    );
    const invalidate = vi.fn();
    const unboundCluster = vi.fn();
    const factory = new ConnectionFactory(
      authFor('https://businesscentral.dynamics.com/t/DEV', { invalidate, unboundCluster }),
      makeConfig('https://businesscentral.dynamics.com/t/DEV'),
      createNullLogger(),
    );
    await factory.create();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(unboundCluster).toHaveBeenCalledOnce();
  });

  it('does not call unboundCluster on a connect failure without status', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(err(new ConnectionError('upgrade failed')));
    const unboundCluster = vi.fn();
    const factory = new ConnectionFactory(
      authFor('http://cronus28/BC', { unboundCluster }),
      makeConfig('http://cronus28/BC'),
      createNullLogger(),
    );
    await factory.create();
    expect(unboundCluster).not.toHaveBeenCalled();
  });

  it('passes SignInRequiredError through unwrapped', async () => {
    const signIn = new SignInRequiredError('need sign-in', { openedWindow: false, reason: 'no_display' });
    const factory = new ConnectionFactory(
      authFor('https://businesscentral.dynamics.com/t/DEV', {
        isAuthenticated: () => false,
        authenticate: async () => err(signIn),
      }),
      makeConfig('https://businesscentral.dynamics.com/t/DEV'),
      createNullLogger(),
    );
    const result = await factory.create();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(signIn);
      expect(result.error.code).toBe('SIGN_IN_REQUIRED');
    }
  });
});
