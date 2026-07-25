import { createNullLogger } from '../../../src/core/logger.js';
import { NTLMAuthProvider } from '../../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../../src/connection/connection-factory.js';
import { EventDecoder } from '../../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../../../src/session/session-factory.js';
import { unwrap } from '../../../src/core/result.js';
import type { BCConfig } from '../../../src/core/config.js';
import type { BCSession } from '../../../src/session/bc-session.js';

export interface PooledLease {
  session: BCSession;
  user: string;
  /**
   * The SAME NTLMAuthProvider instance (already authenticated) used to establish
   * this session's /csh WebSocket connection. DynamicFileHandler.axd (the
   * download-URL endpoint reports/exports emit via FileDownloadReady/UriToShow)
   * checks the identity behind the request against the session that generated
   * the file -- a FRESH NTLM login for the same username is a DIFFERENT
   * server-side session and 404s. Confirmed live (scripts/diag-download-404.ts):
   * reusing this same auth's cookies for the follow-up GET succeeds; a second
   * independent login does not. Callers that need to fetch a captured download's
   * bytes over HTTP (report-capture.test.ts, download-capture.test.ts) MUST reuse
   * `lease.auth.getWebSocketHeaders()` rather than authenticating again.
   */
  auth: NTLMAuthProvider;
}

interface PoolOptions {
  users: string[];
  cooldownMs: number;
  buildSession: (user: string, profile?: string) => Promise<{ session: BCSession; auth: NTLMAuthProvider }>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class IntegrationSessionPool {
  private readonly users: string[];
  private readonly cooldownMs: number;
  private readonly buildSession: (user: string, profile?: string) => Promise<{ session: BCSession; auth: NTLMAuthProvider }>;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly inUse = new Set<string>();
  private rrIndex = 0;

  constructor(opts: PoolOptions) {
    this.users = [...opts.users];
    this.cooldownMs = opts.cooldownMs;
    this.buildSession = opts.buildSession;
  }

  async checkOut(opts?: { profile?: string }): Promise<PooledLease> {
    const user = await this.acquireUser();
    this.inUse.add(user);
    try {
      const { session, auth } = await this.buildSession(user, opts?.profile);
      return { session, user, auth };
    } catch (e) {
      // Release the slot so a build failure does not strand the user forever.
      this.inUse.delete(user);
      throw e;
    }
  }

  async checkIn(lease: PooledLease, opts: { poisoned: boolean }): Promise<void> {
    try {
      await lease.session.closeGracefully();
    } catch {
      // best effort -- a dead session may already be torn down
    }
    if (opts.poisoned) {
      this.cooldownUntil.set(lease.user, Date.now() + this.cooldownMs);
    }
    this.inUse.delete(lease.user);
  }

  private async acquireUser(): Promise<string> {
    // Loop until a user is free and cool.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      // Prefer a free, cool user via round-robin.
      for (let i = 0; i < this.users.length; i++) {
        const idx = (this.rrIndex + i) % this.users.length;
        const candidate = this.users[idx]!;
        const coolAt = this.cooldownUntil.get(candidate) ?? 0;
        if (!this.inUse.has(candidate) && coolAt <= now) {
          this.rrIndex = (idx + 1) % this.users.length;
          return candidate;
        }
      }
      // None ready: wait until the soonest cooldown of a not-in-use user elapses.
      const waits = this.users
        .filter(u => !this.inUse.has(u))
        .map(u => (this.cooldownUntil.get(u) ?? 0) - now)
        .filter(w => w > 0);
      // The `: 10` branch is unreachable in practice -- any not-in-use user with no
      // pending cooldown would already have been returned by the scan above. The 10ms
      // is a defensive minimal sleep to avoid a tight busy-wait, not a polling interval.
      const wait = waits.length > 0 ? Math.min(...waits) : 10;
      await sleep(wait);
    }
  }
}

// ---- Configured singleton for integration tests (real Cronus28 sessions) ----

const CRONUS28: BCConfig = {
  baseUrl: 'http://cronus28/BC',
  username: 'sshadows',          // overridden per-slot below
  password: process.env.BC_TEST_PASSWORD ?? '1234',
  tenantId: 'default',
  profile: '',
  applicationId: process.env.BC_APPLICATION_ID ?? 'FIN',
  clientVersionString: '28.0.0.0',
  serverMajor: 28,
  timeoutMs: 120000,
  invokeTimeoutMs: 30000,
  reconnectMaxRetries: 4,
  reconnectBaseDelayMs: 1000,
};

const POOL_USERS = (process.env.BC_TEST_USERS ?? 'sshadows,bcmcp_test1,bcmcp_test2')
  .split(',').map(s => s.trim()).filter(Boolean);

async function buildCronus28Session(user: string, profile = ''): Promise<{ session: BCSession; auth: NTLMAuthProvider }> {
  const logger = createNullLogger();
  const cfg: BCConfig = { ...CRONUS28, username: user };
  const auth = new NTLMAuthProvider({
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    password: cfg.password,
    tenantId: cfg.tenantId,
  }, logger);
  const connFactory = new ConnectionFactory(auth, cfg, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(cfg.clientVersionString, cfg.applicationId);
  // SessionFactory: (connectionFactory, decoder, encoder, logger, tenantId, timeoutMs?, profile?)
  const sessionFactory = new SessionFactory(
    connFactory,
    decoder,
    encoder,
    logger,
    cfg.tenantId,
    cfg.invokeTimeoutMs,
    profile,
  );
  // ConnectionFactory.connect() authenticates `auth` before opening the /csh
  // WebSocket, so by the time create() resolves `auth` already holds the
  // exact cookies tied to this session -- the only ones DynamicFileHandler.axd
  // will accept for files this session generates (see PooledLease.auth doc).
  const session = unwrap(await sessionFactory.create());
  return { session, auth };
}

export const integrationPool = new IntegrationSessionPool({
  users: POOL_USERS,
  cooldownMs: 16000, // > BC's ~15s NTLM hold
  buildSession: buildCronus28Session,
});
