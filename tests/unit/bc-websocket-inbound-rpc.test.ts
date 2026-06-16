import { describe, it, expect, vi, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Create a minimal fake WebSocket that looks OPEN and records .send() calls.
 * We cast to `WebSocket` because _setWsForTesting accepts that type; the real
 * WebSocket class is only used for its OPEN constant check.
 */
function createFakeWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
}

/**
 * Build a BCWebSocket with an injected fake ws so we can drive routeMessage
 * without a live network connection.
 */
function buildSubject(fakeWs: WebSocket) {
  const logger = createMockLogger();
  const bcws = new BCWebSocket(logger);
  bcws._setWsForTesting(fakeWs);
  return { bcws, logger };
}

/**
 * Drive routeMessage synchronously by sending a raw message string through the
 * internal JSON.parse path.  We access routeMessage via the private ws message
 * event, but because we set the fake ws we cannot use ws.on — instead we use
 * the public onMessage indirection that routeMessage calls.  The simplest
 * approach is to simulate the payload through an established onMessage handler
 * that calls the *real* routeMessage indirectly.
 *
 * Actually, routeMessage is private.  The cleanest approach is to dispatch
 * through a message-handler shim: register an onMessage, then call it with
 * parsed JSON.  But onMessage receives *after* routing, so we need to trigger
 * routeMessage directly.
 *
 * Since `_setWsForTesting` is the only test seam, we drive routeMessage by
 * calling the private method via a cast.  This is intentional: the method is
 * private to production callers but accessible in tests through the cast.
 */
function routeMessage(bcws: BCWebSocket, msg: unknown) {
  (bcws as unknown as { routeMessage(p: unknown): void }).routeMessage(msg);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('BCWebSocket inbound JSON-RPC request dispatch', () => {
  let fakeWs: WebSocket & { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fakeWs = createFakeWs() as WebSocket & { send: ReturnType<typeof vi.fn> };
  });

  it('calls registered handler with correct (method, params, id) and sends success response', async () => {
    const { bcws } = buildSubject(fakeWs);

    const handler = vi.fn().mockResolvedValue({ accepted: true });
    bcws.setRequestHandler(handler);

    const inboundRequest = {
      jsonrpc: '2.0',
      method: 'FileActionDialog',
      id: 'abc',
      params: [{ x: 1 }],
    };

    routeMessage(bcws, inboundRequest);

    // Handler is async — let the microtask queue drain
    await vi.waitUntil(() => (fakeWs.send as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('FileActionDialog', [{ x: 1 }], 'abc');

    const sent = JSON.parse((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent).toEqual({ jsonrpc: '2.0', id: 'abc', result: { accepted: true } });
  });

  it('sends error response when handler rejects', async () => {
    const { bcws } = buildSubject(fakeWs);

    const handler = vi.fn().mockRejectedValue(new Error('file locked'));
    bcws.setRequestHandler(handler);

    routeMessage(bcws, { jsonrpc: '2.0', method: 'FileActionDialog', id: 'err-id', params: [] });

    await vi.waitUntil(() => (fakeWs.send as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    const sent = JSON.parse((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.id).toBe('err-id');
    expect(sent.result).toBeUndefined();
    expect(sent.error).toBeDefined();
    expect(sent.error.code).toBe(-32000);
    expect(sent.error.message).toBe('file locked');
  });

  it('does not send anything when no handler is registered and inbound request arrives', async () => {
    const { bcws, logger } = buildSubject(fakeWs);

    // No setRequestHandler call
    routeMessage(bcws, { jsonrpc: '2.0', method: 'FileActionDialog', id: 'no-handler', params: [] });

    // Allow microtasks to settle
    await Promise.resolve();
    await Promise.resolve();

    expect((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Logger should have emitted a debug log about the drop
    expect(logger.debug).toHaveBeenCalledWith(
      'protocol',
      expect.stringContaining('No requestHandler'),
    );
  });

  it('resolves pending requests for normal JSON-RPC response (id + result, no method)', async () => {
    const { bcws } = buildSubject(fakeWs);

    let resolvedValue: unknown;

    // Manually insert a pending request as if sendRpc had registered it
    const pendingRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> =
      (bcws as unknown as { pendingRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> }).pendingRequests;
    pendingRequests.set('resp-id', {
      resolve: (v) => { resolvedValue = v; },
      reject: vi.fn(),
    });

    routeMessage(bcws, { jsonrpc: '2.0', id: 'resp-id', result: [{ data: 42 }] });

    // Synchronous resolution
    expect(resolvedValue).toEqual({ jsonrpc: '2.0', id: 'resp-id', result: [{ data: 42 }] });
    expect(pendingRequests.has('resp-id')).toBe(false);
    // ws.send must NOT have been called (not an inbound request)
    expect((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('treats method:Message notification (no id) as a notification, not a request', async () => {
    const { bcws } = buildSubject(fakeWs);

    const handler = vi.fn().mockResolvedValue(null);
    bcws.setRequestHandler(handler);

    routeMessage(bcws, {
      jsonrpc: '2.0',
      method: 'Message',
      params: [{ sequenceNumber: 7, handlers: [] }],
      // No id field
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect((fakeWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('does not send when ws readyState is not OPEN', async () => {
    const closedWs = createFakeWs(WebSocket.CLOSED) as WebSocket & { send: ReturnType<typeof vi.fn> };
    const { bcws } = buildSubject(closedWs);

    const handler = vi.fn().mockResolvedValue({ ok: true });
    bcws.setRequestHandler(handler);

    routeMessage(bcws, { jsonrpc: '2.0', method: 'FileActionDialog', id: 'ws-closed', params: [] });

    await vi.waitUntil(() => handler.mock.calls.length > 0);
    // Give the async IIFE a tick to attempt the send
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledOnce();
    expect((closedWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
