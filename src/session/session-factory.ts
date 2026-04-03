import { isErr, type Result, ok } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import type { ConnectionFactory } from '../connection/connection-factory.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder } from '../protocol/interaction-encoder.js';
import { BCSession } from './bc-session.js';
import type { Logger } from '../core/logger.js';

export class SessionFactory {
  constructor(
    private readonly connectionFactory: ConnectionFactory,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly timeoutMs: number = 30000,
  ) {}

  async create(): Promise<Result<BCSession, ConnectionError>> {
    const wsResult = await this.connectionFactory.create();
    if (isErr(wsResult)) return wsResult;

    const session = new BCSession(
      wsResult.value,
      this.decoder,
      this.encoder,
      this.logger,
      this.timeoutMs,
    );

    return ok(session);
  }
}
