import { isErr, type Result, ok, err } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import type { ConnectionFactory } from '../connection/connection-factory.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder } from '../protocol/interaction-encoder.js';
import { BCSession } from './bc-session.js';
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
    private readonly resolveTenantId?: () => string,
  ) {}

  async create(): Promise<Result<BCSession, SessionCreateError>> {
    const wsResult = await this.connectionFactory.create();
    if (isErr(wsResult)) return wsResult;

    const tenantId = this.resolveTenantId?.()
      ?? this.connectionFactory.sessionTenantId
      ?? this.tenantId;
    const session = new BCSession(
      wsResult.value,
      this.decoder,
      this.encoder,
      this.logger,
      tenantId,
      this.timeoutMs,
      this.profile,
    );

    try {
      const initResult = await session.initialize(tenantId);
      if (isErr(initResult)) {
        session.close();
        return err(new ConnectionError(`Session initialization failed: ${initResult.error.message}`));
      }
      return ok(session);
    } catch (e) {
      // initialize() threw instead of returning err -- close the session so the
      // WebSocket + NTLM slot are not leaked, then surface a consistent err Result.
      session.close();
      return err(new ConnectionError(`Session initialization failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
