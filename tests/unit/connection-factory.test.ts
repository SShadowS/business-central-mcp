import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { ok, err } from '../../src/core/result.js';
import { ConnectionError, SignInRequiredError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCWebSocketConfig } from '../../src/connection/bc-websocket.js';
import type { IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
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

const auth: IBCAuthProvider = {
  isAuthenticated: () => true,
  authenticate: async () => ok({ cookies: 'c=1', csrfToken: 'tok' }),
  getWebSocketHeaders: () => ({ Cookie: 'c=1' }),
  getWebSocketQueryParams: () => ({ csrftoken: 'tok' }),
  invalidate: () => {},
};

describe('ConnectionFactory WebSocket Origin (BC 28.3 origin validation)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends an Origin header derived from baseUrl on the /csh upgrade', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const factory = new ConnectionFactory(auth, makeConfig('http://cronus28/BC'), createNullLogger());
    await factory.create();

    // BC 28.3's RequestOriginValidationMiddleware 403s WS upgrades whose Origin
    // is empty or cross-origin. Origin must be scheme+host+port only (no path).
    expect(captured?.headers.Origin).toBe('http://cronus28');
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

    const factory = new ConnectionFactory(auth, makeConfig('https://bc.example.com:8443/BC'), createNullLogger());
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

    const noCsrf: IBCAuthProvider = {
      ...auth,
      getWebSocketQueryParams: () => ({}),
    };
    const factory = new ConnectionFactory(noCsrf, makeConfig('https://businesscentral.dynamics.com/t/DEV'), createNullLogger());
    await factory.create();

    expect(captured?.url).toContain('/csh?');
    expect(captured?.url).not.toContain('csrftoken=');
    expect(captured?.url).toContain('ackseqnb=-1');
    expect(captured?.headers.Origin).toBe('https://businesscentral.dynamics.com');
  });

  it('uses getOrigin and getWebSocketUrl from a SaaS provider', async () => {
    let captured: BCWebSocketConfig | undefined;
    vi.spyOn(BCWebSocket.prototype, 'connect').mockImplementation(async function (
      this: BCWebSocket,
      config: BCWebSocketConfig,
    ) {
      captured = config;
      return ok(undefined);
    });

    const prepares = vi.fn(async () => ok({
      tabId: 'TAB',
      tabBaseUrl: 'https://cluster.example/tenant/msft1/tab/TAB',
      clusterHost: 'cluster.example',
      runtimeId: 'msft1',
      csrfToken: 'csrf',
    }));
    const saasAuth: IBCAuthProvider = {
      ...auth,
      getWebSocketHeaders: () => ({ Cookie: 'c=1', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', Referer: 'https://businesscentral.dynamics.com/t/DEV' }),
      getWebSocketQueryParams: () => ({ csrftoken: 'csrf' }),
      getOrigin: () => 'https://businesscentral.dynamics.com',
      getWebSocketUrl: () => 'wss://cluster.example/tenant/msft1/tab/TAB/csh',
      prepareConnection: prepares,
    };
    const factory = new ConnectionFactory(saasAuth, makeConfig('https://businesscentral.dynamics.com/t/DEV'), createNullLogger());
    await factory.create();
    await factory.create();
    expect(prepares).toHaveBeenCalledTimes(2);
    expect(captured?.headers.Origin).toBe('https://businesscentral.dynamics.com');
    expect(captured?.headers.Origin).not.toBe('https://cluster.example');
    expect(captured?.url).toContain('wss://cluster.example/tenant/msft1/tab/TAB/csh');
    expect(captured?.url).toContain('ackseqnb=-1');
    expect(captured?.url).toContain('csrftoken=csrf');
    expect(captured?.headers['User-Agent']).toMatch(/Chrome/);
    expect(captured?.headers.Referer).toContain('businesscentral.dynamics.com');
  });

  it('calls invalidate when the WebSocket connect fails', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(err(new ConnectionError('upgrade failed')));
    const invalidate = vi.fn();
    const failing: IBCAuthProvider = { ...auth, invalidate };
    const factory = new ConnectionFactory(failing, makeConfig('http://cronus28/BC'), createNullLogger());
    const result = await factory.create();
    expect(result.ok).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('calls markClusterUnbound on Unexpected server response: 500', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(
      err(new ConnectionError('Unexpected server response: 500')),
    );
    const invalidate = vi.fn();
    const markClusterUnbound = vi.fn();
    const failing: IBCAuthProvider = { ...auth, invalidate, markClusterUnbound };
    const factory = new ConnectionFactory(failing, makeConfig('https://businesscentral.dynamics.com/t/DEV'), createNullLogger());
    await factory.create();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(markClusterUnbound).toHaveBeenCalledOnce();
  });

  it('passes SignInRequiredError through unwrapped', async () => {
    const signIn = new SignInRequiredError('need sign-in', { openedWindow: false, reason: 'no_display' });
    const saasAuth: IBCAuthProvider = {
      ...auth,
      isAuthenticated: () => false,
      authenticate: async () => err(signIn),
    };
    const factory = new ConnectionFactory(saasAuth, makeConfig('https://businesscentral.dynamics.com/t/DEV'), createNullLogger());
    const result = await factory.create();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(signIn);
      expect(result.error.code).toBe('SIGN_IN_REQUIRED');
    }
  });
});
