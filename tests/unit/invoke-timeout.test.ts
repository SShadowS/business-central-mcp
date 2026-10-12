import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../../src/protocol/types.js';

// The fixed wall-clock kill is gone: an in-flight invoke is kept alive while
// BC's out-of-band IsExecuting probe answers "true", and killed only on a
// correlated verdict (wedged / transport-dead / ceiling).

const POLL = 1_000;
const CEILING = 20_000;
const LIVENESS = { pollIntervalMs: POLL, maxDurationMs: CEILING };

type Answer = 'true' | 'false' | 'error';

function createMockWs(opts: { hang: boolean; answers?: Answer[] }) {
  const answers = [...(opts.answers ?? [])];
  return {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn((): Promise<any> => opts.hang ? new Promise(() => {}) : Promise.resolve(ok([]))),
    sendOutOfBand: vi.fn(async (): Promise<any> => {
      const a = answers.length > 1 ? answers.shift()! : (answers[0] ?? 'true');
      if (a === 'error') return err(new ProtocolError('RPC timed out'));
      return ok([{ handlerType: 'DN.IsExecutingHandler', parameters: [a] }]);
    }),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const encoder = () => ({
  encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
  encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
} as unknown as InteractionEncoder);
const decoder = () => ({ decode: vi.fn(() => [] as BCEvent[]) } as unknown as EventDecoder);

const dummyInteraction: BCInteraction = { type: 'InvokeAction', formId: '1', controlPath: 'server:', systemAction: 30 };
const dummyExpect: EventPredicate = () => true;

function makeSession(ws: ReturnType<typeof createMockWs>, enc = encoder()) {
  return new BCSession(ws as any, decoder(), enc, logger() as any, 'default', 1000, '', LIVENESS);
}

describe('BCSession invoke liveness', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps a long invoke alive while BC reports IsExecuting=true', async () => {
    const ws = createMockWs({ hang: true, answers: ['true'] });
    const session = makeSession(ws);
    let settled = false;
    void session.invoke(dummyInteraction, dummyExpect).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(CEILING - 1_000); // far past the old 30s-style kill window
    expect(settled).toBe(false);
    expect(session.isAlive).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.sendOutOfBand.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it('probes with an IsExecuting interaction through sendOutOfBand', async () => {
    const ws = createMockWs({ hang: true, answers: ['true'] });
    const enc = encoder();
    const session = makeSession(ws, enc);
    void session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(POLL + 10);
    expect(ws.sendOutOfBand).toHaveBeenCalledTimes(1);
    expect((enc.encode as any).mock.calls.some((c: any[]) => c[0].type === 'IsExecuting')).toBe(true);
    expect(ws.sendRpc).toHaveBeenCalledTimes(1); // the probe never goes through the queued path
  });

  it('kills the session at the ceiling even while BC still reports true', async () => {
    const ws = createMockWs({ hang: true, answers: ['true'] });
    const session = makeSession(ws);
    const p = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(CEILING + 10);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('BC_INVOKE_MAX_DURATION');
    expect(session.isAlive).toBe(false);
    expect(ws.close).toHaveBeenCalled();
  });

  it('kills a wedged invoke (IsExecuting=false twice) long before the ceiling', async () => {
    const ws = createMockWs({ hang: true, answers: ['false'] });
    const session = makeSession(ws);
    const p = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(POLL + 5_000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/IsExecuting=false.*may have committed/s);
    expect(session.isAlive).toBe(false);
  });

  it('kills the session when the probe gets no answer', async () => {
    const ws = createMockWs({ hang: true, answers: ['error'] });
    const session = makeSession(ws);
    const p = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(POLL + 10);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('stopped answering IsExecuting');
    expect(session.isAlive).toBe(false);
  });

  it('an explicit per-call timeout above the ceiling extends it', async () => {
    const ws = createMockWs({ hang: true, answers: ['true'] });
    const session = makeSession(ws);
    let settled = false;
    void session.invoke(dummyInteraction, dummyExpect, CEILING * 2).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(CEILING + 1_000);
    expect(settled).toBe(false);
    expect(session.isAlive).toBe(true);
  });

  it('succeeds normally and never probes when the response is quick', async () => {
    const ws = createMockWs({ hang: false });
    const session = makeSession(ws);
    const p = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(200);
    const r = await p;
    expect(r.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(CEILING * 2);
    expect(ws.sendOutOfBand).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('invokeSequence runs under one watchdog for the whole sequence', async () => {
    const ws = createMockWs({ hang: true, answers: ['true'] });
    const session = makeSession(ws);
    let settled = false;
    void session.invokeSequence([dummyInteraction, dummyInteraction], dummyExpect).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(POLL * 3 + 10);
    expect(settled).toBe(false);
    expect(ws.sendOutOfBand).toHaveBeenCalledTimes(3);
  });
});
