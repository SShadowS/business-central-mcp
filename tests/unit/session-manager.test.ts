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
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    const session = await mgr.getSession();
    expect(session).toBe(mockSession);
    expect(factory.create).toHaveBeenCalledOnce();
  });

  it('returns existing alive session without recreating', async () => {
    const mockSession = createMockSession();
    const factory = createMockSessionFactory(mockSession);
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    const session2 = await mgr.getSession();
    expect(session2).toBe(mockSession);
    expect(factory.create).toHaveBeenCalledOnce(); // Only one create call
  });

  it('throws SessionLostError when session is dead, after creating new session', async () => {
    const deadSession = createMockSession(false); // isAlive = false
    const newSession = createMockSession(true);

    const factory = createMockSessionFactory(deadSession);
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    // First call: get the session (alive at creation)
    // We need to manually set the internal session to the dead one
    // Do this by creating, then making it dead
    const aliveSession = createMockSession(true);
    const factory2 = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr2 = new SessionManager(factory2 as any, repo as any, logger as any);

    // First call succeeds
    const s1 = await mgr2.getSession();
    expect(s1).toBe(aliveSession);

    // Now mark the session as dead by mutating isAlive
    (aliveSession as any).isAlive = false;

    // Next call should detect death, recover, and throw SessionLostError
    await expect(mgr2.getSession()).rejects.toThrow(SessionLostError);

    // Verify recovery actions
    expect(aliveSession.close).toHaveBeenCalled();
    expect(repo.clearAll).toHaveBeenCalled();
    expect(factory2.create).toHaveBeenCalledTimes(2);
    expect(mgr2.needsServiceRebuild).toBe(true);
  });

  it('SessionLostError includes impacted page context IDs', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

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
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    // First call after death throws SessionLostError
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // Second call should return the new session
    const s = await mgr.getSession();
    expect(s).toBe(newSession);
  });

  it('throws regular error if recovery fails', async () => {
    const aliveSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(err(new ConnectionError('recovery failed'))),
    };
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    await expect(mgr.getSession()).rejects.toThrow('Session recovery failed: recovery failed');
  });

  it('throws regular error if initial creation fails', async () => {
    const factory = createMockSessionFactory('error');
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    await expect(mgr.getSession()).rejects.toThrow('Session creation failed: connection refused');
  });

  it('close() closes the session', async () => {
    const mockSession = createMockSession(true);
    const factory = createMockSessionFactory(mockSession);
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

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
    const mgr = new SessionManager(factory as any, repo as any, logger as any);

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);
    expect(mgr.needsServiceRebuild).toBe(true);

    mgr.markServicesRebuilt();
    expect(mgr.needsServiceRebuild).toBe(false);
  });
});
