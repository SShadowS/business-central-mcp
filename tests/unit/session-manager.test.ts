import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionLostError } from '../../src/core/errors.js';
import { ok, err } from '../../src/core/result.js';
import { ConnectionError } from '../../src/core/errors.js';

// Minimal mock types
function createMockSession(alive = true) {
  return {
    isAlive: alive,
    isInitialized: true,
    close: vi.fn(),
    invoke: vi.fn(),
    openFormIds: new Set<string>(),
  };
}

function createMockSessionFactory(sessionOrError: 'error' | ReturnType<typeof createMockSession> = createMockSession()) {
  return {
    create: vi.fn(async () => {
      if (sessionOrError === 'error') {
        return err(new ConnectionError('connection refused'));
      }
      return ok(sessionOrError);
    }),
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

/** SessionManager subclass that skips real delays */
class TestSessionManager extends SessionManager {
  protected override delay(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

describe('SessionManager', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let repo: ReturnType<typeof createMockPageContextRepo>;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockPageContextRepo();
  });

  it('creates a session on first call', async () => {
    const mockSession = createMockSession();
    const factory = createMockSessionFactory(mockSession);
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    const session = await mgr.getSession();
    expect(session).toBe(mockSession);
    expect(factory.create).toHaveBeenCalledOnce();
  });

  it('returns existing alive session without recreating', async () => {
    const mockSession = createMockSession();
    const factory = createMockSessionFactory(mockSession);
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    const session2 = await mgr.getSession();
    expect(session2).toBe(mockSession);
    expect(factory.create).toHaveBeenCalledOnce(); // Only one create call
  });

  it('throws SessionLostError when session is dead, after creating new session', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    // First call succeeds
    const s1 = await mgr.getSession();
    expect(s1).toBe(aliveSession);

    // Now mark the session as dead by mutating isAlive
    (aliveSession as any).isAlive = false;

    // Next call should detect death, recover, and throw SessionLostError
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // Verify recovery actions
    expect(aliveSession.close).toHaveBeenCalled();
    expect(repo.clearAll).toHaveBeenCalled();
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(mgr.needsServiceRebuild).toBe(true);
  });

  it('SessionLostError includes impacted page context IDs', async () => {
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
      expect((e as SessionLostError).impactedPageContextIds).toEqual(['ctx:1', 'ctx:2']);
    }
  });

  it('subsequent call after recovery returns the new session', async () => {
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

    // First call after death throws SessionLostError
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // Second call should return the new session
    const s = await mgr.getSession();
    expect(s).toBe(newSession);
  });

  it('throws SessionLostError with reconnectFailed when all retries exhausted', async () => {
    const aliveSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValue(err(new ConnectionError('recovery failed'))),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any, { maxRetries: 2, baseDelayMs: 100 });

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    try {
      await mgr.getSession();
      expect.fail('Should have thrown SessionLostError');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionLostError);
      expect((e as SessionLostError).reconnectFailed).toBe(true);
    }
  });

  it('throws regular error if initial creation fails after retries', async () => {
    const factory = {
      create: vi.fn().mockResolvedValue(err(new ConnectionError('connection refused'))),
    };
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any, { maxRetries: 1, baseDelayMs: 100 });

    await expect(mgr.getSession()).rejects.toThrow('Session creation failed after all retry attempts');
  });

  it('close() closes the session', async () => {
    const mockSession = createMockSession(true);
    const factory = createMockSessionFactory(mockSession);
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    mgr.close();
    expect(mockSession.close).toHaveBeenCalled();
    expect(mgr.currentSession).toBeNull();
  });

  it('needsServiceRebuild is reset by markServicesRebuilt', async () => {
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
    expect(mgr.needsServiceRebuild).toBe(true);

    mgr.markServicesRebuilt();
    expect(mgr.needsServiceRebuild).toBe(false);
  });
});
