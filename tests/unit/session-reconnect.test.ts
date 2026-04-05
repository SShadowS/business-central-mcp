import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionLostError, ConnectionError } from '../../src/core/errors.js';
import { ok, err } from '../../src/core/result.js';

function createMockSession(alive = true) {
  return {
    isAlive: alive,
    isInitialized: true,
    close: vi.fn(),
    closeGracefully: vi.fn(),
    invoke: vi.fn(),
    openFormIds: new Set<string>(),
  };
}

function createMockPageContextRepo() {
  return {
    listPageContextIds: vi.fn(() => ['ctx:1', 'ctx:2']),
    clearAll: vi.fn(),
    size: 2,
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

/** Subclass that records delay calls instead of sleeping */
class TestSessionManager extends SessionManager {
  public delayCalls: number[] = [];
  protected override delay(ms: number): Promise<void> {
    this.delayCalls.push(ms);
    return Promise.resolve();
  }
}

describe('Session reconnect with exponential backoff', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let repo: ReturnType<typeof createMockPageContextRepo>;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockPageContextRepo();
  });

  it('returns alive session without reconnect', async () => {
    const session = createMockSession(true);
    const factory = { create: vi.fn().mockResolvedValueOnce(ok(session)) };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    const s1 = await mgr.getSession();
    expect(s1).toBe(session);

    // Second call: no reconnect, same session
    const s2 = await mgr.getSession();
    expect(s2).toBe(session);
    expect(factory.create).toHaveBeenCalledOnce();
    expect(mgr.delayCalls).toHaveLength(0);
  });

  it('retries with exponential backoff when session is dead', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    // Factory: first call succeeds, then fails twice, then succeeds
    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(err(new ConnectionError('NTLM slot busy')))
        .mockResolvedValueOnce(err(new ConnectionError('still busy')))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any, {
      maxRetries: 4,
      baseDelayMs: 1000,
    });

    // Establish initial session
    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    // Recovery should retry and eventually succeed, then throw SessionLostError
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // Verify exponential delays: attempt 1 = 1000ms, attempt 2 = 2000ms
    expect(mgr.delayCalls).toEqual([1000, 2000]);

    // Factory was called 4 times: initial + attempt 0 (no delay) + attempt 1 + attempt 2
    expect(factory.create).toHaveBeenCalledTimes(4);

    // New session is stored -- next call returns it
    const s = await mgr.getSession();
    expect(s).toBe(newSession);
  });

  it('sets reconnectFailed=true when all retries exhausted', async () => {
    const aliveSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValue(err(new ConnectionError('permanently down'))),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any, {
      maxRetries: 3,
      baseDelayMs: 500,
    });

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    try {
      await mgr.getSession();
      expect.fail('Should have thrown SessionLostError');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionLostError);
      const sle = e as SessionLostError;
      expect(sle.reconnectFailed).toBe(true);
      expect(sle.impactedPageContextIds).toEqual(['ctx:1', 'ctx:2']);
    }

    // 4 create calls: initial + attempts 0,1,2,3
    expect(factory.create).toHaveBeenCalledTimes(5);
    // Delays for attempts 1,2,3: 500, 1000, 2000
    expect(mgr.delayCalls).toEqual([500, 1000, 2000]);
  });

  it('handles LogicalModalityViolationException during first connect', async () => {
    const session = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(err(new ConnectionError('LogicalModalityViolation: session conflict')))
        .mockResolvedValueOnce(err(new ConnectionError('LogicalModalityViolation: still conflicting')))
        .mockResolvedValueOnce(ok(session)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any, {
      maxRetries: 4,
      baseDelayMs: 1000,
    });

    // First connect retries through LogicalModalityViolation errors
    const s = await mgr.getSession();
    expect(s).toBe(session);

    // Two retries with backoff
    expect(mgr.delayCalls).toEqual([1000, 2000]);
    expect(factory.create).toHaveBeenCalledTimes(3);

    // Logger warned about LogicalModalityViolation
    const warnCalls = logger.warn.mock.calls.map((c: any) => c[0]);
    expect(warnCalls.some((msg: string) => msg.includes('LogicalModalityViolation'))).toBe(true);
  });

  it('clears all page contexts on recovery', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    expect(repo.clearAll).toHaveBeenCalledOnce();
    expect(repo.listPageContextIds).toHaveBeenCalledOnce();
  });

  it('closes dead session before recovery', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    expect(aliveSession.close).toHaveBeenCalledOnce();
  });

  it('uses default reconnect options when none provided', async () => {
    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(err(new ConnectionError('fail1')))
        .mockResolvedValueOnce(err(new ConnectionError('fail2')))
        .mockResolvedValueOnce(err(new ConnectionError('fail3')))
        .mockResolvedValueOnce(err(new ConnectionError('fail4')))
        .mockResolvedValueOnce(err(new ConnectionError('fail5'))),
    };
    // No reconnect options -- uses defaults (maxRetries=4, baseDelayMs=1000)
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await expect(mgr.getSession()).rejects.toThrow('Session creation failed after all retry attempts');

    // 5 attempts: initial + 4 retries
    expect(factory.create).toHaveBeenCalledTimes(5);
    // Delays: 1000, 2000, 4000, 8000
    expect(mgr.delayCalls).toEqual([1000, 2000, 4000, 8000]);
  });

  it('successful recovery throws SessionLostError with reconnectFailed=false', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    try {
      await mgr.getSession();
      expect.fail('Should have thrown SessionLostError');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionLostError);
      expect((e as SessionLostError).reconnectFailed).toBe(false);
    }
  });
});
