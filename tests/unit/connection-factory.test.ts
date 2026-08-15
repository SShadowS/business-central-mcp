import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { ok } from '../../src/core/result.js';
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
});
