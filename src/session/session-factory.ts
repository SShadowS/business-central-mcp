import { isErr, type Result, ok, err } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import type { ConnectionFactory } from '../connection/connection-factory.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder } from '../protocol/interaction-encoder.js';
import { BCSession, DEFAULT_LIVENESS, type InvokeLiveness } from './bc-session.js';
import type { Logger } from '../core/logger.js';
import type { SessionCreateError } from './session-create-error.js';

export class SessionFactory {
  constructor(
    private readonly connectionFactory: ConnectionFactory,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly tenantId: string,
    private readonly timeoutMs: number = 30000,
    private readonly profile: string = '',
    private readonly liveness: InvokeLiveness = DEFAULT_LIVENESS,
    /** Detects the server's applicationId (BC_APPLICATION_ID unset). Retried until it answers once. */
    private applicationIdProbe?: () => Promise<string | undefined>,
  ) {}

  async create(): Promise<Result<BCSession, SessionCreateError>> {
    if (this.applicationIdProbe) {
      const detected = await this.applicationIdProbe();
      if (detected) {
        this.encoder.setApplicationId(detected);
        this.applicationIdProbe = undefined;
        this.logger.info('Detected BC applicationId', { applicationId: detected });
      } else {
        this.logger.warn('Could not detect BC applicationId; sending FIN (set BC_APPLICATION_ID to override)');
      }
    }

    const wsResult = await this.connectionFactory.create();
    if (isErr(wsResult)) return wsResult;

    const tenantId = this.connectionFactory.sessionTenantId ?? this.tenantId;
    const session = new BCSession(
      wsResult.value,
      this.decoder,
      this.encoder,
      this.logger,
      tenantId,
      this.timeoutMs,
      this.profile,
      this.liveness,
    );

    try {
      const initResult = await session.initialize(tenantId);
      if (isErr(initResult)) {
        session.close();
        // A connect that did not end in an open session drops the sign-in, the
        // same rule ConnectionFactory applies to a failed upgrade (#48).
        this.connectionFactory.invalidateAuth();
        return err(new ConnectionError(`Session initialization failed: ${initResult.error.message}`));
      }
      return ok(session);
    } catch (e) {
      // initialize() threw instead of returning err -- close the session so the
      // WebSocket + NTLM slot are not leaked, then surface a consistent err Result.
      session.close();
      this.connectionFactory.invalidateAuth();
      return err(new ConnectionError(`Session initialization failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
