import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionFactory } from '../../src/session/session-factory.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok, err } from '../../src/core/result.js';
import { SignInRequiredError, ConnectionError, ProtocolError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
import type { BCConfig } from '../../src/core/config.js';
import { makeTestBCConfig } from '../helpers/test-config.js';

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
  return makeTestBCConfig({
    timeoutMs: 1000,
    invokeTimeoutMs: 1000,
    reconnectMaxRetries: 0,
    reconnectBaseDelayMs: 0,
  });
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

  it('drops the sign-in when OpenSession fails after the upgrade, so the next create signs in again (#48)', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(ok(undefined));
    vi.spyOn(BCSession.prototype, 'close').mockImplementation(() => {});
    const initialize = vi.spyOn(BCSession.prototype, 'initialize')
      .mockResolvedValueOnce(err(new ProtocolError(
        'JSON-RPC error: {"code":3,"errorType":"Microsoft.Dynamics.Nav.Types.NavCancelCredentialPromptException"}',
      )))
      .mockResolvedValueOnce(ok([]));
    let signedIn = true;
    const authenticate = vi.fn(async () => { signedIn = true; return ok({ cookies: 'c=2', csrfToken: 'tok2' }); });
    const stateful: IBCAuthProvider = {
      ...auth,
      isAuthenticated: () => signedIn,
      authenticate,
      invalidate: () => { signedIn = false; },
    };
    const sf = new SessionFactory(
      new ConnectionFactory(stateful, cfg(), createNullLogger()),
      new EventDecoder(),
      new InteractionEncoder('28.0.0.0'),
      createNullLogger(),
      'default',
    );

    const first = await sf.create();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBeInstanceOf(ConnectionError);
    expect(signedIn).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();

    const second = await sf.create();
    expect(second.ok).toBe(true);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('drops the sign-in when initialize throws (#48)', async () => {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(ok(undefined));
    vi.spyOn(BCSession.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(BCSession.prototype, 'initialize').mockRejectedValue(new Error('boom'));
    const invalidate = vi.fn();
    const sf = new SessionFactory(
      new ConnectionFactory({ ...auth, invalidate }, cfg(), createNullLogger()),
      new EventDecoder(),
      new InteractionEncoder('28.0.0.0'),
      createNullLogger(),
      'default',
    );
    const result = await sf.create();
    expect(result.ok).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
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
