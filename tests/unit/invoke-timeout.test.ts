import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../../src/protocol/types.js';

function createMockWs(hangOnSend = false) {
  return {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn((): Promise<any> => {
      if (hangOnSend) {
        // Never resolves -- simulates BC hanging
        return new Promise(() => {});
      }
      return Promise.resolve(ok([]));
    }),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}

function createMockDecoder() {
  return {
    decode: vi.fn(() => [] as BCEvent[]),
  } as unknown as EventDecoder;
}

const dummyInteraction: BCInteraction = { type: 'InvokeAction', formId: '1', controlPath: 'server:', systemAction: 30 };
const dummyExpect: EventPredicate = () => true;

describe('BCSession invoke timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ProtocolError when invoke exceeds timeout', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);

    // Advance past the session-level timeout (1000 + 5000 = 6000ms)
    await vi.advanceTimersByTimeAsync(6001);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Session has been killed');
    }
  });

  it('marks session dead after timeout', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    expect(session.isAlive).toBe(true);

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(6001);
    await resultPromise;

    expect(session.isAlive).toBe(false);
  });

  it('calls ws.close() on timeout', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(6001);
    await resultPromise;

    expect(ws.close).toHaveBeenCalled();
  });

  it('succeeds normally when response arrives before timeout', async () => {
    const ws = createMockWs(false); // responds immediately
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);

    // Advance past the quiescence window (150ms) so invokeInternal completes
    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
  });
});
