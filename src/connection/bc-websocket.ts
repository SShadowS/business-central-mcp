import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { ok, err, isErr, type Result } from '../core/result.js';
import { ConnectionError, ProtocolError, TimeoutError } from '../core/errors.js';
import { composeWithTimeout } from '../core/abort.js';
import { decompressIfNeeded } from '../protocol/decompression.js';
import type { Logger } from '../core/logger.js';

let wireSends = 0;

/**
 * Process-wide count of RPC frames handed to a socket. The replay gate compares
 * it across a call: unchanged means the call failed before reaching BC, so it
 * cannot have committed (issue #41).
 */
export const wireSendCount = (): number => wireSends;

/**
 * How RPCs travel on `/csh`. BC28 speaks raw JSON-RPC. BC26 maps `/csh` to the
 * SignalR hub `ClientServiceHub` (JSON hub protocol, records end in 0x1E): one
 * client method, `InvokeRequest(JsonRpcRequest)`, answered by a completion that
 * carries the JSON-RPC response; pushes arrive as `Message(ClientMessage)` and
 * `Session("Close")` (decompiled BC26 `Prod.Client.WebCoreApp`
 * `ClientServiceHub`, `SignalRHubMiddleware`). Live (issue #42): BC26 never
 * answers a raw frame; BC28 closes the socket on a SignalR handshake.
 */
export type WireFraming = 'jsonrpc' | 'signalr';

const RS = '\x1e';
const SIGNALR_KEEPALIVE_MS = 15_000; // server drops a client silent for 30s (SignalR ClientTimeoutInterval default)

// Framing learned per server, keyed by host + first path segment (the BC
// instance; SaaS puts a fresh tab id deeper in the path), so only the first
// connect to a server pays the probe.
const framingByServer = new Map<string, WireFraming>();
function serverKey(url: string): string {
  const u = new URL(url);
  return `${u.host}/${u.pathname.split('/')[1] ?? ''}`;
}

export interface BCWebSocketConfig {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

type MessageHandler = (data: unknown) => void;
type InboundRequestHandler = (method: string, params: unknown[], id: string) => Promise<unknown>;

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
  private requestHandler: InboundRequestHandler | null = null;
  private framing: WireFraming = 'jsonrpc';
  private invocationSeq = 0;
  private readonly invocationRpcIds = new Map<string, string>();
  private keepAlive: NodeJS.Timeout | null = null;
  readonly spaInstanceId: string;

  constructor(private readonly logger: Logger) {
    this.spaInstanceId = uuid().replace(/-/g, '').substring(0, 10);
  }

  /**
   * Register a handler for inbound JSON-RPC requests sent by BC to the client
   * (e.g. FileActionDialog). The handler receives (method, params, id) and must
   * return a Promise that resolves with the result to echo back, or rejects with
   * an Error whose message is forwarded as a JSON-RPC error response.
   * Only one handler may be registered at a time; calling again replaces it.
   */
  setRequestHandler(handler: InboundRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Test seam: inject a pre-built WebSocket (e.g. a spy object), wired like connect() does. */
  _setWsForTesting(ws: WebSocket): void {
    this.ws = ws;
    this.setupHandlers(ws);
  }

  get nextSequenceNo(): string {
    return `${this.spaInstanceId}#${++this.sequenceCounter}`;
  }

  get lastClientAckSequenceNumber(): number {
    return this.lastServerSequence;
  }

  /** Wire framing of the open socket. BC answers IsExecuting out of band only on 'jsonrpc'. */
  get wireFraming(): WireFraming {
    return this.framing;
  }

  /**
   * Open the socket. A server not yet known to speak raw JSON-RPC gets a
   * SignalR handshake first: an ack means SignalR, a close means raw JSON-RPC,
   * and the connect is retried raw on a fresh socket.
   */
  async connect(config: BCWebSocketConfig): Promise<Result<void, ConnectionError>> {
    const key = serverKey(config.url);
    if (framingByServer.get(key) !== 'jsonrpc') {
      const probed = await this.open(config, 'signalr');
      if (isErr(probed)) return probed;
      if (probed.value) {
        framingByServer.set(key, 'signalr');
        return ok(undefined);
      }
      framingByServer.set(key, 'jsonrpc');
    }
    const opened = await this.open(config, 'jsonrpc');
    return isErr(opened) ? opened : ok(undefined);
  }

  /** Ok(true) = connected; Ok(false) = the server closed the socket on the SignalR handshake. */
  private open(config: BCWebSocketConfig, framing: WireFraming): Promise<Result<boolean, ConnectionError>> {
    return new Promise((resolve) => {
      let settled = false;
      const { signal, cleanup } = composeWithTimeout(config.timeoutMs);

      const ws = new WebSocket(config.url, { headers: config.headers });

      const settle = (result: Result<boolean, ConnectionError>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const install = (): void => {
        this.ws = ws;
        this.framing = framing;
        this.setupHandlers(ws);
        if (framing === 'signalr') {
          this.keepAlive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 6 }) + RS);
          }, SIGNALR_KEEPALIVE_MS);
          this.keepAlive.unref();
        }
        this.logger.info(`WebSocket connected to ${config.url.split('?')[0]} (${framing})`);
        settle(ok(true));
      };

      ws.on('open', () => {
        if (framing === 'jsonrpc') { install(); return; }
        const onClose = (): void => settle(ok(false));
        const onHandshake = (data: WebSocket.RawData): void => {
          ws.off('message', onHandshake);
          ws.off('close', onClose);
          const [ack, ...rest] = data.toString().split(RS).filter(Boolean);
          const parsed = JSON.parse(ack ?? '{}') as { error?: string };
          if (parsed.error) {
            ws.close();
            settle(err(new ConnectionError(`SignalR handshake rejected: ${parsed.error}`)));
            return;
          }
          install();
          for (const record of rest) this.routeSignalR(JSON.parse(record));
        };
        ws.on('message', onHandshake);
        ws.once('close', onClose);
        ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      });

      ws.on('error', (e) => {
        const status = httpStatusFromWsMessage(e.message);
        settle(err(new ConnectionError(
          `WebSocket connection failed: ${e.message}`,
          status !== undefined ? { status } : undefined,
        )));
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
        if (this.framing === 'signalr') {
          for (const record of data.toString().split(RS)) {
            if (record) this.routeSignalR(JSON.parse(record));
          }
          return;
        }
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
      this.stopKeepAlive();
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new ConnectionError(`WebSocket closed while waiting for response ${id}`));
      }
      this.pendingRequests.clear();
    });

    ws.on('error', (e) => {
      this.logger.error(`WebSocket error: ${e.message}`);
    });
  }

  /** Translate one SignalR record into the raw JSON-RPC shape `routeMessage` handles. */
  private routeSignalR(record: { type?: number; target?: string; arguments?: unknown[]; invocationId?: string; result?: unknown; error?: string }): void {
    switch (record.type) {
      case 1: // invocation from the server
        if (record.target === 'Message') {
          // BC26 ClientMessage: { compressed: true, data: '<base64>' } or an
          // uncompressed `data` array; BC28 raw names the base64 `compressedData`.
          const params = (record.arguments ?? []).map((m) => {
            const { compressed, data, ...rest } = m as Record<string, unknown>;
            return compressed === true && typeof data === 'string' ? { ...rest, compressedData: data } : m;
          });
          this.routeMessage({ jsonrpc: '2.0', method: 'Message', params });
        } else if (record.target === 'Session') {
          this.logger.warn(`BC closed the session: ${JSON.stringify(record.arguments)}`);
          this.ws?.close();
        } else {
          this.logger.debug('protocol', `Ignoring SignalR invocation of ${record.target}`);
        }
        return;
      case 3: { // completion of our InvokeRequest
        const id = this.invocationRpcIds.get(record.invocationId ?? '');
        if (id === undefined) return;
        this.invocationRpcIds.delete(record.invocationId!);
        if (record.error !== undefined) {
          this.routeMessage({ jsonrpc: '2.0', id, error: { message: record.error } });
          return;
        }
        // BC26 JsonRpcConverter: { compressed: true, result: '<base64>' };
        // BC28 raw: { result: { compressedResult: '<base64>' } }.
        const { compressed, result, ...rest } = record.result as Record<string, unknown>;
        this.routeMessage(compressed === true && typeof result === 'string'
          ? { ...rest, id, result: { compressedResult: result } }
          : { ...rest, id, result });
        return;
      }
      case 7: // close
        this.logger.warn(`SignalR close from BC: ${record.error ?? '(no error)'}`);
        this.ws?.close();
        return;
      default: // 6 = ping
        return;
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
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

    // Inbound JSON-RPC request from BC (has method + id, is NOT a response).
    // A response has id + result/error but NO method. A request has both.
    if (
      typeof msg['method'] === 'string' &&
      msg['method'] !== 'Message' &&
      'id' in msg &&
      msg['id'] !== null &&
      msg['id'] !== undefined
    ) {
      const id = String(msg['id']);
      const params = Array.isArray(msg['params']) ? (msg['params'] as unknown[]) : [];
      if (this.requestHandler) {
        const handler = this.requestHandler;
        // Dispatch asynchronously so routeMessage stays synchronous.
        void (async () => {
          let responsePayload: string;
          try {
            const result = await handler(msg['method'] as string, params, id);
            responsePayload = JSON.stringify({ jsonrpc: '2.0', id, result });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            responsePayload = JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message },
            });
          }
          try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(responsePayload);
            }
          } catch (sendErr) {
            this.logger.debug(
              'protocol',
              `Failed to send inbound-request response: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
            );
          }
        })();
      } else {
        this.logger.debug('protocol', `No requestHandler registered; dropping inbound request: ${msg['method'] as string} id=${id}`);
      }
      return;
    }

    // JSON-RPC response (has id field, no method)
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
    return this.enqueueSend(() => this.sendNow(method, params, timeoutMs));
  }

  /**
   * Send an RPC WITHOUT waiting behind the serialised send queue. A deliberate,
   * narrow exception used ONLY for the `IsExecuting` liveness probe, which BC
   * answers while another Invoke is outstanding (decompiled `CallbackHandler.cs`
   * handles it before EnterProcessing; verified live by Gate A, 2026-07-24).
   * Every other RPC must use `sendRpc` -- concurrent sends of ordinary
   * interactions corrupt BC's stateful protocol.
   */
  sendOutOfBand(
    method: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<Result<unknown, ProtocolError>> {
    return this.sendNow(method, params, timeoutMs);
  }

  private async sendNow(
    method: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<Result<unknown, ProtocolError>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return err(new ProtocolError('WebSocket is not connected'));
    }

    const id = uuid();
    const rpc = { jsonrpc: '2.0', id, method, params };
    let payload = JSON.stringify(rpc);
    if (this.framing === 'signalr') {
      const invocationId = String(this.invocationSeq++);
      this.invocationRpcIds.set(invocationId, id);
      payload = JSON.stringify({ type: 1, invocationId, target: 'InvokeRequest', arguments: [rpc] }) + RS;
    }

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

      wireSends++;
      this.ws!.send(payload, (sendError?: Error) => {
        if (sendError) {
          const pending = this.pendingRequests.get(id);
          if (pending) {
            this.pendingRequests.delete(id);
            pending.reject(new ConnectionError(`WebSocket send failed for ${id}: ${sendError.message}`));
          }
        }
      });
      this.logger.debug('protocol', `Sent RPC: ${method} (id: ${id})`);
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
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export function httpStatusFromWsMessage(message: string): number | undefined {
  const match = /Unexpected server response:\s*(\d{3})\b/i.exec(message);
  if (!match) return undefined;
  return Number(match[1]);
}
