import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../../src/protocol/types.js';

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}
function createMockDecoder() {
  return { decode: vi.fn(() => [] as BCEvent[]) } as unknown as EventDecoder;
}

const dummyInteraction: BCInteraction = { type: 'InvokeAction', formId: '1', controlPath: 'server:', systemAction: 30 };
const dummyExpect: EventPredicate = () => true;

describe('BCSession drain-on-death', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fast-fails queued invokes after the session is marked dead, without calling sendRpc', async () => {
    const sendRpc = vi.fn((): Promise<any> => Promise.resolve(ok([])));
    const ws = {
      isConnected: true, spaInstanceId: 'spa-test', nextSequenceNo: 1, lastClientAckSequenceNumber: 0,
      sendRpc, onMessage: vi.fn(() => () => {}), close: vi.fn(),
    };
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    session.markDead();
    const result = await session.invoke(dummyInteraction, dummyExpect);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Session is dead');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('drains invokes enqueued before death is detected mid-flight', async () => {
    let call = 0;
    const sendRpc = vi.fn((): Promise<any> => {
      call += 1;
      if (call === 1) return Promise.resolve({ ok: false, error: new Error('InvalidSessionException') });
      return Promise.resolve(ok([]));
    });
    const ws = {
      isConnected: true, spaInstanceId: 'spa-test', nextSequenceNo: 1, lastClientAckSequenceNumber: 0,
      sendRpc, onMessage: vi.fn(() => () => {}), close: vi.fn(),
    };
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const p1 = session.invoke(dummyInteraction, dummyExpect);
    const p2 = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(200);

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.message).toContain('Session is dead');
    expect(sendRpc).toHaveBeenCalledTimes(1);
  });
});
