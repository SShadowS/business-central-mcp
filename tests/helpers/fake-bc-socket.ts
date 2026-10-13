// Reusable fake BC server behind a REAL BCWebSocket (issue #26).
//
// Only the raw `ws` socket is faked, so frames run through BCWebSocket's own
// parse / route / close-rejects-pending logic, exactly as against a live BC.
// A script decides what the "server" does with each request: reply, push async
// Message notifications (e.g. InvokeCompleted), or drop the socket.
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { vi } from 'vitest';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';

export interface FakeRequest {
  id: string;
  method: string;
  params: unknown[];
  /** `interactionsToInvoke` of an Invoke/OpenSession call (empty otherwise). */
  interactions: Array<{ interactionName: string; callbackId?: string } & Record<string, unknown>>;
}

export interface FakeBCServer {
  /** Every request the client sent, in order. */
  readonly sent: FakeRequest[];
  /** JSON-RPC response carrying a handler array (what BC returns for Invoke). */
  reply(id: string, handlers: unknown[]): void;
  /** Async `Message` notification with gzip-compressed handlers, as BC pushes them. */
  message(handlers: unknown[]): void;
  /** Close the socket from the server side; pending requests reject like a real drop. */
  drop(code?: number): void;
}

export type FakeScript = (req: FakeRequest, server: FakeBCServer) => void;

/** CallbackResponseProperties handler that decodes to InvokeCompleted for `callbackId`. */
export function invokeCompleted(callbackId: string): unknown {
  return { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [{ InvocationId: callbackId, Duration: 1 }] }] };
}

export function createFakeBCSocket(script: FakeScript): { bcws: BCWebSocket; server: FakeBCServer } {
  const raw = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send(data: string, cb?: (e?: Error) => void) {
      const msg = JSON.parse(data) as { id: string; method: string; params: unknown[] };
      const first = msg.params[0] as { interactionsToInvoke?: FakeRequest['interactions'] } | undefined;
      const req: FakeRequest = { ...msg, interactions: first?.interactionsToInvoke ?? [] };
      server.sent.push(req);
      cb?.();
      // After the caller has registered its pending request, like a network hop.
      queueMicrotask(() => script(req, server));
    },
    close() { server.drop(1000); },
  });

  const emit = (msg: unknown) => raw.emit('message', Buffer.from(JSON.stringify(msg)));
  const server: FakeBCServer = {
    sent: [],
    reply: (id, handlers) => emit({ jsonrpc: '2.0', id, result: handlers }),
    message: (handlers) => emit({
      jsonrpc: '2.0',
      method: 'Message',
      params: [{ sequenceNumber: 1, compressedData: gzipSync(Buffer.from(JSON.stringify(handlers))).toString('base64') }],
    }),
    drop: (code = 1006) => {
      if (raw.readyState === WebSocket.CLOSED) return;
      raw.readyState = WebSocket.CLOSED;
      raw.emit('close', code, Buffer.from(''));
    },
  };

  const bcws = new BCWebSocket({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
  bcws._setWsForTesting(raw as unknown as WebSocket);
  return { bcws, server };
}
