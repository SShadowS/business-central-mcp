import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applicationIdProbeFor,
  parseApplicationId,
  probeApplicationId,
} from '../../src/connection/application-id-probe.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
import { makeTestBCConfig } from '../helpers/test-config.js';

// Shape of the live cronus29 boot script (ClientConfigurationSettings JSON).
const BOOT = 'x={"PlatformVersion":"29.0","DefaultApplicationId":"FIN","ApplicationId":"NAV","ShellType":0}';

describe('parseApplicationId', () => {
  it('reads ApplicationId, not DefaultApplicationId', () => {
    expect(parseApplicationId(BOOT)).toBe('NAV');
  });
  it('returns undefined when absent', () => {
    expect(parseApplicationId('<html>sign in</html>')).toBeUndefined();
  });
});

describe('probeApplicationId', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

  async function serve(status: number, body: string): Promise<{ base: string; urls: string[] }> {
    const urls: string[] = [];
    server = createServer((req, res) => { urls.push(req.url ?? ''); res.writeHead(status); res.end(body); });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/BC`, urls };
  }

  it('GETs the boot script for the tenant and parses it', async () => {
    const { base, urls } = await serve(200, BOOT);
    expect(await probeApplicationId(base, 'default')).toBe('NAV');
    expect(urls).toEqual(['/BC/boot/browser/desktop?tenant=default']);
  });
  it('returns undefined on a non-2xx answer', async () => {
    const { base } = await serve(302, BOOT);
    expect(await probeApplicationId(base, 'default')).toBeUndefined();
  });
  it('returns undefined when the server is unreachable', async () => {
    expect(await probeApplicationId('http://127.0.0.1:1/BC', 'default', 2000)).toBeUndefined();
  });
});

describe('applicationIdProbeFor', () => {
  it('probes only when BC_APPLICATION_ID is unset and the target is not SaasWeb', () => {
    expect(applicationIdProbeFor(makeTestBCConfig({ applicationId: undefined }))).toBeTypeOf('function');
    expect(applicationIdProbeFor(makeTestBCConfig({ applicationId: 'FIN' }))).toBeUndefined();
    expect(applicationIdProbeFor(makeTestBCConfig({ applicationId: undefined, authMode: 'SaasWeb' }))).toBeUndefined();
  });
});

describe('SessionFactory applicationId probe', () => {
  afterEach(() => vi.restoreAllMocks());

  const auth: IBCAuthProvider = {
    isAuthenticated: () => true,
    authenticate: async () => ok({ cookies: 'c=1', csrfToken: 'tok' }),
    prepare: async () => ok({ wsUrl: 'ws://h/BC/csh', origin: 'http://h', httpBaseUrl: 'http://h/BC', sessionTenantId: 'default' }),
    getWebSocketHeaders: () => ({}),
    getWebSocketQueryParams: () => ({}),
    invalidate: () => {},
    unboundCluster: () => {},
  };

  function factory(probe: () => Promise<string | undefined>, encoder: InteractionEncoder): SessionFactory {
    vi.spyOn(BCWebSocket.prototype, 'connect').mockResolvedValue(ok(undefined));
    vi.spyOn(BCSession.prototype, 'initialize').mockResolvedValue(ok([]));
    const cf = new ConnectionFactory(auth, makeTestBCConfig({ timeoutMs: 1000 }), createNullLogger());
    return new SessionFactory(cf, new EventDecoder(), encoder, createNullLogger(), 'default', 1000, '', undefined, probe);
  }

  const appIdOf = (e: InteractionEncoder) =>
    (e.encodeOpenSession('default', 's').params[0] as { navigationContext: { applicationId: string } })
      .navigationContext.applicationId;

  it('sets the detected id and stops probing once it answers', async () => {
    const probe = vi.fn().mockResolvedValue('NAV');
    const encoder = new InteractionEncoder('28.0.0.0');
    const sf = factory(probe, encoder);
    await sf.create();
    await sf.create();
    expect(appIdOf(encoder)).toBe('NAV');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps FIN and retries on the next session when the probe fails', async () => {
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('NAV');
    const encoder = new InteractionEncoder('28.0.0.0');
    const sf = factory(probe, encoder);
    await sf.create();
    expect(appIdOf(encoder)).toBe('FIN');
    await sf.create();
    expect(appIdOf(encoder)).toBe('NAV');
  });
});
