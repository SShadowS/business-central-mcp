import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionFactory } from '../../src/session/session-factory.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok, err } from '../../src/core/result.js';
import { SignInRequiredError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
import type { BCConfig } from '../../src/core/config.js';

const auth: IBCAuthProvider = {
  isAuthenticated: () => true,
  authenticate: async () => ok({ cookies: 'c=1', csrfToken: 'tok' }),
  prepare: async () => ok({
    wsUrl: 'ws://cronus28/BC/csh',
    origin: 'http://cronus28',
    httpBaseUrl: 'http://cronus28/BC',
    sessionTenantId: 'default',
  }),
  getWebSocketHeaders: () => ({ Cookie: 'c=1' }),
  getWebSocketQueryParams: () => ({ csrftoken: 'tok' }),
  invalidate: () => {},
  unboundCluster: () => {},
};

function cfg(): BCConfig {
  return {
    baseUrl: 'http://cronus28/BC',
    username: 'u',
    password: 'p',
    tenantId: 'default',
    profile: '',
    applicationId: 'FIN',
    clientVersionString: '28.0.0.0',
    serverMajor: 28,
    timeoutMs: 1000,
    invokeTimeoutMs: 1000,
    reconnectMaxRetries: 0,
    reconnectBaseDelayMs: 0,
    odataUrl: '',
    odataCompanyName: undefined,
  };
}

describe('SessionFactory tenant override', () => {
  afterEach(() => vi.restoreAllMocks());

  it('initializes BCSession with prepare() sessionTenantId, not the AAD GUID', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(ok(undefined));
    const initialize = vi.spyOn(BCSession.prototype, 'initialize').mockResolvedValue(ok([]));
    const saasAuth: IBCAuthProvider = {
      ...auth,
      prepare: async () => ok({
        wsUrl: 'wss://cluster.example/tenant/msft1/tab/TAB/csh',
        origin: 'https://businesscentral.dynamics.com',
        httpBaseUrl: 'https://cluster.example/tenant/msft1/tab/TAB',
        sessionTenantId: 'msft1a6720t30818544',
      }),
    };
    const factory = new ConnectionFactory(saasAuth, cfg(), createNullLogger());
    const sf = new SessionFactory(
      factory,
      new EventDecoder(),
      new InteractionEncoder('28.0.0.0'),
      createNullLogger(),
      '7bcb54ae-6d5e-43c7-9402-928aed68ad00',
      1000,
      '',
    );
    const result = await sf.create();
    expect(result.ok).toBe(true);
    expect(initialize).toHaveBeenCalledWith('msft1a6720t30818544');
  });

  it('forwards SignInRequiredError from ConnectionFactory unchanged', async () => {
    const signIn = new SignInRequiredError('need sign-in', { openedWindow: false, reason: 'no_display' });
    const blocked: IBCAuthProvider = {
      ...auth,
      isAuthenticated: () => false,
      authenticate: async () => err(signIn),
    };
    const factory = new ConnectionFactory(blocked, cfg(), createNullLogger());
    const sf = new SessionFactory(
      factory,
      new EventDecoder(),
      new InteractionEncoder('28.0.0.0'),
      createNullLogger(),
      'default',
    );
    const result = await sf.create();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(signIn);
    }
  });
});
