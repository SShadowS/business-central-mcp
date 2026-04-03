import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { ok, err, type Result } from '../core/result.js';
import { ConnectionError, ProtocolError, TimeoutError } from '../core/errors.js';
import { composeWithTimeout } from '../core/abort.js';
import { decompressIfNeeded } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';

export interface BCWebSocketConfig {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

type MessageHandler = (data: unknown) => void;

export class BCWebSocket {
  private ws: WebSocket | null = null;
  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly messageHandlers: MessageHandler[] = [];
  private sendQueue: Promise<void> = Promise.resolve();
  private sequenceCounter = 0;
  private lastServerSequence = 0;
  readonly spaInstanceId: string;

  constructor(private readonly logger: Logger) {
    this.spaInstanceId = uuid().replace(/-/g, '').substring(0, 10);
  }

  get nextSequenceNo(): string {
    return `${this.spaInstanceId}#${++this.sequenceCounter}`;
  }

  get lastClientAckSequenceNumber(): number {
    return this.lastServerSequence;
  }

  async connect(config: BCWebSocketConfig): Promise<Result<void, ConnectionError>> {
    return new Promise((resolve) => {
      let settled = false;
      const { signal, cleanup } = composeWithTimeout(config.timeoutMs);

      const ws = new WebSocket(config.url, { headers: config.headers });

      const settle = (result: Result<void, ConnectionError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      ws.on('open', () => {
        this.ws = ws;
        this.setupHandlers(ws);
        this.logger.info(`WebSocket connected to ${config.url.split('?')[0]}`);
        settle(ok(undefined));
      });

      ws.on('error', (e) => {
        settle(err(new ConnectionError(`WebSocket connection failed: ${e.message}`)));
      });

      signal.addEventListener(
        'abort',
        () => {
          ws.close();
          settle(
            err(
              new ConnectionError(
                signal.reason instanceof TimeoutError
                  ? `Connection timed out after ${config.timeoutMs}ms`
                  : 'Connection aborted',
              ),
            ),
          );
        },
        { once: true },
      );
    });
  }

  private setupHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        this.routeMessage(parsed);
      } catch (e) {
        this.logger.error(
          `Failed to parse WebSocket message: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    ws.on('close', (code, reason) => {
      this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`);
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new ConnectionError(`WebSocket closed while waiting for response ${id}`));
      }
      this.pendingRequests.clear();
    });

    ws.on('error', (e) => {
      this.logger.error(`WebSocket error: ${e.message}`);
    });
  }

  private routeMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as Record<string, unknown>;

    // Forward to all message handlers (copy array to prevent mutation during iteration)
    const handlers = [...this.messageHandlers];
    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch {
        // handler errors don't break routing
      }
    }

    // JSON-RPC response (has id field)
    if ('id' in msg && msg['id'] !== null && msg['id'] !== undefined) {
      const id = String(msg['id']);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if ('error' in msg) {
          pending.reject(new ProtocolError(`JSON-RPC error: ${JSON.stringify(msg['error'])}`));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    // Async Message notification (method: "Message", no id)
    if (
      msg['method'] === 'Message' &&
      Array.isArray(msg['params']) &&
      (msg['params'] as unknown[]).length > 0
    ) {
      const messageData = (msg['params'] as unknown[])[0] as Record<string, unknown>;
      const seqNum = messageData['sequenceNumber'];
      if (typeof seqNum === 'number' && seqNum > this.lastServerSequence) {
        this.lastServerSequence = seqNum;
      }
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const idx = this.messageHandlers.indexOf(handler);
      if (idx >= 0) this.messageHandlers.splice(idx, 1);
    };
  }

  async sendRpc(
    method: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<Result<unknown, ProtocolError>> {
    return this.enqueueSend(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return err(new ProtocolError('WebSocket is not connected'));
      }

      const id = uuid();
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      return new Promise<Result<unknown, ProtocolError>>((resolve) => {
        const { signal, cleanup } = composeWithTimeout(timeoutMs);

        this.pendingRequests.set(id, {
          resolve: (value) => {
            cleanup();
            const decompressed = decompressIfNeeded(value);
            resolve(decompressed);
          },
          reject: (reason) => {
            cleanup();
            resolve(err(new ProtocolError(reason.message)));
          },
        });

        signal.addEventListener(
          'abort',
          () => {
            this.pendingRequests.delete(id);
            resolve(
              err(
                new ProtocolError(
                  signal.reason instanceof TimeoutError
                    ? `RPC timed out after ${timeoutMs}ms`
                    : 'RPC aborted',
                ),
              ),
            );
          },
          { once: true },
        );

        this.ws!.send(payload);
        this.logger.debug('protocol', `Sent RPC: ${method} (id: ${id})`);
      });
    });
  }

  private enqueueSend<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sendQueue.then(fn, fn);
    this.sendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
