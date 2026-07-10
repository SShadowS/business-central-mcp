import { isErr } from '../core/result.js';
import { SessionLostError } from '../core/errors.js';
import type { BCSession } from './bc-session.js';
import type { SessionFactory } from './session-factory.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

export interface ReconnectOptions {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_RECONNECT: ReconnectOptions = { maxRetries: 4, baseDelayMs: 1000 };

/**
 * Manages the BC session lifecycle including lazy creation and automatic recovery
 * after session death (InvalidSessionException, WebSocket disconnect).
 *
 * When a dead session is detected, the manager:
 * 1. Closes the old session
 * 2. Clears all page contexts (they reference the dead session's form IDs)
 * 3. Creates a fresh session with exponential backoff
 * 4. Throws SessionLostError so the caller can inform the LLM
 *
 * BC holds the NTLM auth slot for ~15 seconds after a session crash,
 * so immediate reconnect typically fails. The exponential backoff
 * (1s, 2s, 4s, 8s by default) covers this window.
 */
export class SessionManager {
  private session: BCSession | null = null;
  private servicesInvalidated = false;
  private inFlight: Promise<BCSession> | null = null;
  private readonly reconnectOptions: ReconnectOptions;

  /** Exposed for testing -- override to avoid real delays. */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly pageContextRepo: PageContextRepository,
    private readonly logger: Logger,
    reconnectOptions?: ReconnectOptions,
  ) {
    this.reconnectOptions = reconnectOptions ?? DEFAULT_RECONNECT;
  }

  get currentSession(): BCSession | null {
    return this.session;
  }

  get needsServiceRebuild(): boolean {
    return this.servicesInvalidated;
  }

  /** Mark services as rebuilt after the caller reconstructs them. */
  markServicesRebuilt(): void {
    this.servicesInvalidated = false;
  }

  /**
   * Returns an alive session, creating one if needed.
   * If the existing session is dead, performs recovery:
   * - Closes the dead session
   * - Clears all page contexts
   * - Creates a new session with exponential backoff
   * - Throws SessionLostError with the list of invalidated page context IDs
   */
  async getSession(): Promise<BCSession> {
    // Happy path: session exists and is alive
    if (this.session !== null && this.session.isAlive) {
      return this.session;
    }

    // Single-flight: concurrent callers that observe a missing/dead session all
    // await the SAME creation/recovery promise. Without this, two parallel first
    // requests each build a BCSession; the loser is overwritten and leaks its
    // WebSocket plus a scarce NTLM auth slot.
    if (this.inFlight === null) {
      this.inFlight = this.acquire().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async acquire(): Promise<BCSession> {
    // Re-check under the in-flight slot: another caller may have established a
    // live session between the alive-check in getSession and this point.
    if (this.session !== null && this.session.isAlive) {
      return this.session;
    }

    // Session is dead -- recover
    if (this.session !== null) {
      this.logger.info('Session is dead, initiating recovery...');

      // Collect impacted page context IDs before clearing
      const impactedIds = this.pageContextRepo.listPageContextIds();

      // Tear down dead session
      this.session.close();
      this.session = null;

      // Clear all page contexts -- they reference the dead session's form IDs
      this.pageContextRepo.clearAll();
      this.servicesInvalidated = true;

      // Attempt reconnect with exponential backoff
      const newSession = await this.createWithBackoff();

      if (newSession === null) {
        throw new SessionLostError(
          'Session was lost and all reconnect attempts failed. The server cannot reach Business Central.',
          impactedIds,
          { reconnectFailed: true },
        );
      }

      this.session = newSession;
      this.logger.info('Session recovered successfully');

      // Throw SessionLostError so the MCP handler returns a clear message to the LLM
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
    }

    // No session yet -- create one (first call), also with backoff for LogicalModalityViolation
    const newSession = await this.createWithBackoff();
    if (newSession === null) {
      throw new Error('Session creation failed after all retry attempts');
    }

    this.session = newSession;
    this.logger.info('BC session established');
    return this.session;
  }

  /**
   * Attempt to create a session with exponential backoff.
   * Returns the new BCSession on success, or null if all retries are exhausted.
   */
  private async createWithBackoff(): Promise<BCSession | null> {
    const { maxRetries, baseDelayMs } = this.reconnectOptions;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.info(`Reconnect attempt ${attempt}/${maxRetries} after ${delayMs}ms delay...`);
        await this.delay(delayMs);
      }

      const result = await this.sessionFactory.create();

      if (!isErr(result)) {
        return result.value;
      }

      const errorMsg = result.error.message;

      if (errorMsg.includes('LogicalModalityViolation')) {
        // Mid-session violations are reconciled in BCSession.invokeUnqueued.
        // Reaching this branch means the violation surfaced during *initial*
        // connect (NTLM slot still held by a previous crashed session) or a
        // full session recreate after death. Backoff retry is the right
        // response there; nothing to abort because the new session has no
        // modals yet.
        this.logger.warn(`LogicalModalityViolation during initial connect (NTLM slot held by previous session?), attempt ${attempt + 1}: ${errorMsg}`);
      } else {
        this.logger.warn(`Session create failed on attempt ${attempt + 1}: ${errorMsg}`);
      }
    }

    return null;
  }

  /** Gracefully close the session, sending CloseForm for all open forms. */
  async closeGracefully(): Promise<void> {
    if (this.session !== null) {
      await this.session.closeGracefully();
      this.session = null;
    }
  }

  /** Abrupt close (for signal handlers that can't be async). */
  close(): void {
    if (this.session !== null) {
      this.session.close();
      this.session = null;
    }
  }
}
