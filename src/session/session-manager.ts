import { isErr } from '../core/result.js';
import { SessionLostError } from '../core/errors.js';
import type { BCSession } from './bc-session.js';
import type { SessionFactory } from './session-factory.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

/**
 * Manages the BC session lifecycle including lazy creation and automatic recovery
 * after session death (InvalidSessionException, WebSocket disconnect).
 *
 * When a dead session is detected, the manager:
 * 1. Closes the old session
 * 2. Clears all page contexts (they reference the dead session's form IDs)
 * 3. Creates a fresh session
 * 4. Throws SessionLostError so the caller can inform the LLM
 *
 * The next tool call after recovery will work against the new session.
 */
export class SessionManager {
  private session: BCSession | null = null;
  private servicesInvalidated = false;

  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly pageContextRepo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

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
   * - Creates a new session
   * - Throws SessionLostError with the list of invalidated page context IDs
   */
  async getSession(): Promise<BCSession> {
    // Happy path: session exists and is alive
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

      // Create new session
      const result = await this.sessionFactory.create();
      if (isErr(result)) {
        throw new Error(`Session recovery failed: ${result.error.message}`);
      }

      this.session = result.value;
      this.logger.info('Session recovered successfully');

      // Throw SessionLostError so the MCP handler returns a clear message to the LLM
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
    }

    // No session yet -- create one (first call)
    const result = await this.sessionFactory.create();
    if (isErr(result)) {
      throw new Error(`Session creation failed: ${result.error.message}`);
    }

    this.session = result.value;
    this.logger.info('BC session established');
    return this.session;
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
