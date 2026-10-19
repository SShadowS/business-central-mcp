// Issue #42: BC26 serves /csh as a SignalR hub, BC28 as raw JSON-RPC.
// BCWebSocket probes with a SignalR handshake and falls back to raw when the
// server closes the socket, remembering the answer per server.
import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { isOk } from '../../src/core/result.js';

const RS = '\x1e';
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const b64 = (v: unknown): string => gzipSync(JSON.stringify(v)).toString('base64');
const HANDLERS = [{ handlerType: 'DN.CallbackResponseProperties', parameters: [] }];

const servers: WebSocketServer[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function listen(onConnection: (ws: ServerSocket) => void): Promise<{ url: string; connections: () => number }> {
  let count = 0;
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on('connection', (ws) => { count++; onConnection(ws); });
  return new Promise((resolve) => wss.on('listening', () => resolve({
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/BC/csh`,
    connections: () => count,
  })));
}

describe('BCWebSocket wire framing', () => {
  it('speaks SignalR to a hub that acks the handshake (BC26)', async () => {
    const server = await listen((ws) => {
      ws.on('message', (data) => {
        for (const rec of data.toString().split(RS).filter(Boolean)) {
          const m = JSON.parse(rec);
          if (m.protocol === 'json') { ws.send('{}' + RS); continue; }
          if (m.type !== 1) continue;
          expect(m.target).toBe('InvokeRequest');
          expect(m.arguments[0].method).toBe('OpenSession');
          // A push and the completion in one frame, as SignalR may batch them.
          ws.send(
            JSON.stringify({ type: 1, target: 'Message', arguments: [{ sequenceNumber: 1, handler: 'LogicalClientChange', compressed: true, data: b64(HANDLERS) }] }) + RS
            + JSON.stringify({ type: 3, invocationId: m.invocationId, result: { jsonrpc: '2.0', compressed: true, result: b64(HANDLERS) } }) + RS,
          );
        }
      });
    });

    const ws = new BCWebSocket(logger);
    const pushed: unknown[] = [];
    ws.onMessage((m) => pushed.push(m));
    expect(isOk(await ws.connect({ url: server.url, headers: {}, timeoutMs: 5000 }))).toBe(true);
    expect(ws.wireFraming).toBe('signalr');

    const r = await ws.sendRpc('OpenSession', [{}], 5000);
    expect(isOk(r) && r.value).toEqual(HANDLERS);
    expect(pushed).toContainEqual({ jsonrpc: '2.0', method: 'Message', params: [{ sequenceNumber: 1, handler: 'LogicalClientChange', compressedData: b64(HANDLERS) }] });
    expect(ws.lastClientAckSequenceNumber).toBe(1);
    ws.close();
  });

  it('falls back to raw JSON-RPC when the server closes on the handshake (BC28), once per server', async () => {
    const server = await listen((ws) => {
      ws.on('message', (data) => {
        const text = data.toString();
        if (text.endsWith(RS)) { ws.close(1000, 'Client closed'); return; }
        const m = JSON.parse(text);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { compressedResult: b64(HANDLERS) } }));
      });
    });

    const first = new BCWebSocket(logger);
    expect(isOk(await first.connect({ url: server.url, headers: {}, timeoutMs: 5000 }))).toBe(true);
    expect(first.wireFraming).toBe('jsonrpc');
    const r = await first.sendRpc('OpenSession', [{}], 5000);
    expect(isOk(r) && r.value).toEqual(HANDLERS);
    expect(server.connections()).toBe(2); // probe + raw
    first.close();

    const second = new BCWebSocket(logger);
    expect(isOk(await second.connect({ url: server.url, headers: {}, timeoutMs: 5000 }))).toBe(true);
    expect(server.connections()).toBe(3); // no second probe
    second.close();
  });
});
