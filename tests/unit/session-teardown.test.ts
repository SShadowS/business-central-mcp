import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok, err } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

function createMockWs(opts: { hangOnSend?: boolean; rejectOnSend?: boolean } = {}) {
  return {
    isConnected: true,
    spaInstanceId: 'spa-teardown-test',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn((): Promise<any> => {
      if (opts.hangOnSend) return new Promise(() => {});
      if (opts.rejectOnSend) return Promise.reject(new Error('Network failure'));
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

function createMockDecoder(events: BCEvent[] = []) {
  return {
    decode: vi.fn(() => events),
  } as unknown as EventDecoder;
}

function makeSession(ws: ReturnType<typeof createMockWs>, decoder?: EventDecoder) {
  return new BCSession(
    ws as any,
    decoder ?? createMockDecoder(),
    createMockEncoder(),
    createMockLogger() as any,
    'default',
    500, // short timeout for tests
  );
}

describe('BCSession teardown idempotency', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closeGracefully() called twice: second call is a no-op, ws.close called exactly once', async () => {
    const ws = createMockWs();
    const session = makeSession(ws);

    const first = session.closeGracefully();
    // Advance timers so the quiescence window (150ms) inside invoke resolves
    await vi.advanceTimersByTimeAsync(200);
    await first;

    expect(ws.close).toHaveBeenCalledTimes(1);

    // Second call -- should be a no-op
    await session.closeGracefully();
    expect(ws.close).toHaveBeenCalledTimes(1); // still once
  });

  it('close() called twice: ws.close called exactly once', () => {
    const ws = createMockWs();
    const session = makeSession(ws);

    session.close();
    session.close();

    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('closeGracefully() after close() is a no-op: ws.close still called only once', async () => {
    const ws = createMockWs();
    const session = makeSession(ws);

    session.close();
    expect(ws.close).toHaveBeenCalledTimes(1);

    await session.closeGracefully();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('closeGracefully() on already-dead session resolves immediately without sending invokes', async () => {
    const ws = createMockWs();
    const session = makeSession(ws);

    // Kill the session first via close()
    session.close();
    expect(session.isAlive).toBe(false);

    // closeGracefully should not call sendRpc at all
    await session.closeGracefully();
    expect(ws.sendRpc).not.toHaveBeenCalled();
  });

  it('closeGracefully() ends with isAlive===false even when form-close invoke rejects', async () => {
    const ws = createMockWs({ rejectOnSend: true });
    const session = makeSession(ws);

    // Manually register a fake open form so the loop runs
    session.addOpenForm('form-abc');

    const closePromise = session.closeGracefully();
    // Advance enough for the invoke timeout to fire (500ms + 5000ms guard = 5500ms)
    await vi.advanceTimersByTimeAsync(6000);
    await closePromise;

    expect(session.isAlive).toBe(false);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('closeGracefully() ends with isAlive===false when form-close invoke returns err result', async () => {
    const ws = createMockWs();
    ws.sendRpc.mockResolvedValue(err({ message: 'InvalidSessionException' } as any));

    const session = makeSession(ws);
    session.addOpenForm('form-xyz');

    const closePromise = session.closeGracefully();
    await vi.advanceTimersByTimeAsync(200);
    await closePromise;

    expect(session.isAlive).toBe(false);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});

describe('ClosePageOperation: page context always removed on close error', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('removes page context from repo when session.invoke throws during close', async () => {
    // Import the pieces we need -- done dynamically to avoid circular import issues at module load
    const { PageContextRepository } = await import('../../src/protocol/page-context-repo.js');
    const { PageService } = await import('../../src/services/page-service.js');
    const { ClosePageOperation } = await import('../../src/operations/close-page.js');

    const repo = new PageContextRepository();
    const ws = createMockWs({ rejectOnSend: true });
    const session = makeSession(ws);

    // We need a minimal session stub that throws on invoke
    const throwingSession = {
      invoke: vi.fn().mockRejectedValue(new Error('WS broken')),
      removeOpenForm: vi.fn(),
      isAlive: true,
    } as any;

    const logger = createMockLogger() as any;
    const pageService = new PageService(throwingSession, repo, logger);

    // Manually create a page context in the repo so closePage finds something
    const pcId = 'session:page:22:test0001';
    repo.create(pcId, 'form-1', { isModal: false });

    expect(repo.get(pcId)).toBeTruthy();

    // closePage will call session.invoke which throws
    const op = new ClosePageOperation(pageService);
    // The operation will propagate the error (thrown, not Result.err) -- that's OK;
    // what matters is the repo is cleaned up in the finally block.
    await expect(op.execute({ pageContextId: pcId })).rejects.toThrow('WS broken');

    // Page context must be gone regardless of the error
    expect(repo.get(pcId)).toBeUndefined();
  });
});
