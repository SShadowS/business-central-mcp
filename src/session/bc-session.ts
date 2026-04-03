import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCWebSocket } from '../connection/bc-websocket.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../protocol/types.js';
import { EventDecoder } from '../protocol/event-decoder.js';
import { InteractionEncoder, type EncodeContext } from '../protocol/interaction-encoder.js';
import { decompressPayload } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';

const DEFAULT_TIMEOUT_MS = 30000;
const QUIESCENCE_MS = 150; // Trailing window for async Message bursts

export class BCSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly _openFormIds = new Set<string>();
  private dead = false;

  private sessionId = '';
  private sessionKey = '';
  private company = '';
  private _initialized = false;

  constructor(
    private readonly ws: BCWebSocket,
    private readonly decoder: EventDecoder,
    private readonly encoder: InteractionEncoder,
    private readonly logger: Logger,
    private readonly tenantId: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  get openFormIds(): ReadonlySet<string> {
    return this._openFormIds;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get isAlive(): boolean {
    return !this.dead && this.ws.isConnected;
  }

  async initialize(tenantId: string): Promise<Result<BCEvent[], ProtocolError>> {
    const openSessionCall = this.encoder.encodeOpenSession(tenantId, this.ws.spaInstanceId);

    this.logger.debug('protocol', 'Sending OpenSession');
    const rpcResult = await this.ws.sendRpc(openSessionCall.method, openSessionCall.params, this.timeoutMs);
    if (isErr(rpcResult)) return rpcResult;

    const responseData = rpcResult.value;
    let events: BCEvent[] = [];
    if (Array.isArray(responseData)) {
      events = this.decoder.decode(responseData);
    }

    // Wait for async messages
    await new Promise(resolve => setTimeout(resolve, QUIESCENCE_MS));

    // Extract session credentials from response (recursively searches for fields)
    this.extractSessionCredentials(responseData);

    // Update form tracking
    this.updateFormTracking(events);

    this._initialized = true;
    this.logger.info(`Session initialized: ${this.sessionId}, company: ${this.company}`);

    return ok(events);
  }

  private extractSessionCredentials(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      for (const item of data) this.extractSessionCredentials(item);
      return;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.ServerSessionId === 'string' && obj.ServerSessionId) {
      this.sessionId = obj.ServerSessionId;
    }
    if (typeof obj.SessionKey === 'string' && obj.SessionKey) {
      this.sessionKey = obj.SessionKey;
    }
    if (typeof obj.CompanyName === 'string' && obj.CompanyName) {
      this.company = obj.CompanyName;
    }
    for (const value of Object.values(obj)) {
      this.extractSessionCredentials(value);
    }
  }

  async invoke(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    return this.enqueue(() => this.invokeInternal(interaction, expect, timeoutMs ?? this.timeoutMs));
  }

  private async invokeInternal(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    const callbackId = uuid();
    const allEvents: BCEvent[] = [];
    const asyncEvents: BCEvent[] = [];

    // Register message handler to capture async Message notifications during this invoke
    const unsubscribe = this.ws.onMessage((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as Record<string, unknown>;
      // Only process async Message notifications (method: "Message", no id)
      if (msg['method'] === 'Message' && !('id' in msg) && Array.isArray(msg['params'])) {
        const messageData = (msg['params'] as unknown[])[0] as Record<string, unknown> | undefined;
        if (messageData?.['compressedData'] && typeof messageData['compressedData'] === 'string') {
          const decompResult = decompressPayload(messageData['compressedData'] as string);
          if (isOk(decompResult) && Array.isArray(decompResult.value)) {
            const events = this.decoder.decode(decompResult.value as unknown[]);
            asyncEvents.push(...events);
          }
        }
      }
    });

    try {
      // Encode the interaction
      const context: EncodeContext = {
        callbackId,
        sequenceNo: this.ws.nextSequenceNo,
        lastClientAckSequenceNumber: this.ws.lastClientAckSequenceNumber,
        openFormIds: this._openFormIds,
        session: {
          sessionId: this.sessionId,
          sessionKey: this.sessionKey,
          company: this.company,
          tenantId: this.tenantId,
          spaInstanceId: this.ws.spaInstanceId,
        },
      };
      const encoded = this.encoder.encode(interaction, context);

      this.logger.debug('protocol', `Invoke: ${interaction.type}`, {
        callbackId,
        formId: interaction.formId,
      });

      // Send and wait for synchronous response
      const rpcResult = await this.ws.sendRpc(encoded.method, encoded.params, timeoutMs);
      if (isErr(rpcResult)) {
        // Check for fatal session errors:
        // - InvalidSessionException in the message text
        // - JSON-RPC error code 1 (InvalidSession) regardless of exception type
        const msg = rpcResult.error.message;
        if (msg.includes('InvalidSessionException') || msg.includes('"code":1')) {
          this.markDead();
        }
        return rpcResult;
      }

      // Decode synchronous response handlers
      const responseData = rpcResult.value;
      if (Array.isArray(responseData)) {
        allEvents.push(...this.decoder.decode(responseData));
      }

      // Quiescence window — wait for trailing async Messages
      await new Promise<void>(resolve => setTimeout(resolve, QUIESCENCE_MS));

      // Collect async events
      allEvents.push(...asyncEvents);

      // Update form tracking
      this.updateFormTracking(allEvents);

      // Check completion gates for logging
      let invokeCompletedSeen = false;
      let expectMatched = false;
      for (const event of allEvents) {
        if (event.type === 'InvokeCompleted') {
          if (event.completedInteractions.some(ci => ci.invocationId === callbackId)) {
            invokeCompletedSeen = true;
          }
        }
        if (!expectMatched && expect(event, { callbackId, interactionFormId: interaction.formId, invokeCompletedSeen })) {
          expectMatched = true;
        }
      }

      this.logger.debug('protocol', `Invoke complete: ${interaction.type}`, {
        callbackId,
        eventCount: allEvents.length,
        types: allEvents.map(e => e.type),
        invokeCompletedSeen,
        expectMatched,
      });

      return ok(allEvents);
    } finally {
      unsubscribe();
    }
  }

  private updateFormTracking(events: BCEvent[]): void {
    for (const event of events) {
      if ((event.type === 'FormCreated' || event.type === 'DialogOpened') && event.formId) {
        this._openFormIds.add(event.formId);
      }
    }
  }

  addOpenForm(formId: string): void {
    this._openFormIds.add(formId);
  }

  removeOpenForm(formId: string): void {
    this._openFormIds.delete(formId);
  }

  markDead(): void {
    this.dead = true;
  }

  close(): void {
    this.dead = true;
    this.ws.close();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
