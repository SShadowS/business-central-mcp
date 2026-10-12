import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { gzipSync } from 'node:zlib';
import { BCWebSocket } from '../../src/connection/bc-websocket.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function subject() {
  const sent: string[] = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => { sent.push(data); }),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
  const bcws = new BCWebSocket(logger as never);
  bcws._setWsForTesting(fakeWs);
  const route = (msg: unknown) =>
    (bcws as unknown as { routeMessage(p: unknown): void }).routeMessage(msg);
  const idOf = (i: number) => (JSON.parse(sent[i]!) as { id: string }).id;
  return { bcws, sent, route, idOf };
}

describe('BCWebSocket.sendOutOfBand', () => {
  it('sends while a queued sendRpc is still awaiting its response', async () => {
    const { bcws, sent, route, idOf } = subject();
    const main = bcws.sendRpc('Invoke', [{ main: true }], 60_000);
    await Promise.resolve();
    expect(sent).toHaveLength(1);

    const probe = bcws.sendOutOfBand('Invoke', [{ probe: true }], 5_000);
    await Promise.resolve();
    expect(sent).toHaveLength(2); // not stuck behind the unresolved main RPC

    const compressed = gzipSync(Buffer.from(JSON.stringify([
      { handlerType: 'DN.IsExecutingHandler', parameters: ['true'] },
    ]))).toString('base64');
    route({ jsonrpc: '2.0', id: idOf(1), compressedResult: compressed });
    const probeResult = await probe;
    expect(probeResult.ok).toBe(true);
    if (probeResult.ok) {
      expect(probeResult.value).toEqual([{ handlerType: 'DN.IsExecutingHandler', parameters: ['true'] }]);
    }

    route({ jsonrpc: '2.0', id: idOf(0), result: [] });
    expect((await main).ok).toBe(true);
  });

  it('times out on its own deadline without touching the main RPC', async () => {
    vi.useFakeTimers();
    try {
      const { bcws, route, idOf } = subject();
      const main = bcws.sendRpc('Invoke', [{}], 60_000);
      await Promise.resolve();
      const probe = bcws.sendOutOfBand('Invoke', [{}], 1_000);
      await vi.advanceTimersByTimeAsync(1_001);
      const probeResult = await probe;
      expect(probeResult.ok).toBe(false);

      route({ jsonrpc: '2.0', id: idOf(0), result: [] });
      expect((await main).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
