import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntegrationSessionPool } from '../../tests/integration/helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';

// Minimal fake session: only isAlive + closeGracefully are touched by the pool.
function fakeSession(): BCSession {
  return {
    isAlive: true,
    closeGracefully: vi.fn(async () => {}),
  } as unknown as BCSession;
}

describe('IntegrationSessionPool', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('round-robins users across clean check-out / check-in cycles', async () => {
    const handed: string[] = [];
    const pool = new IntegrationSessionPool({
      users: ['u1', 'u2', 'u3'],
      cooldownMs: 15000,
      buildSession: async (user) => { handed.push(user); return fakeSession(); },
    });

    for (let i = 0; i < 3; i++) {
      const lease = await pool.checkOut();
      await pool.checkIn(lease, { poisoned: false });
    }

    expect(handed).toEqual(['u1', 'u2', 'u3']);
  });

  it('does not reissue a poisoned user within the cooldown window', async () => {
    const handed: string[] = [];
    const pool = new IntegrationSessionPool({
      users: ['u1', 'u2'],
      cooldownMs: 15000,
      buildSession: async (user) => { handed.push(user); return fakeSession(); },
    });

    const lease1 = await pool.checkOut();          // u1
    await pool.checkIn(lease1, { poisoned: true }); // u1 now cooling for 15s

    const lease2 = await pool.checkOut();           // must be u2, not u1
    expect(lease2.user).toBe('u2');
    await pool.checkIn(lease2, { poisoned: false });

    const lease3 = await pool.checkOut();           // u1 still cooling -> u2 again
    expect(lease3.user).toBe('u2');
  });

  it('awaits the soonest cooldown when all users are cooling', async () => {
    const pool = new IntegrationSessionPool({
      users: ['u1'],
      cooldownMs: 15000,
      buildSession: async () => fakeSession(),
    });

    const lease1 = await pool.checkOut();
    await pool.checkIn(lease1, { poisoned: true }); // u1 cooling until +15s

    const pending = pool.checkOut();                 // should block until cooldown elapses
    let resolved = false;
    void pending.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(14000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);         // past 15s total
    const lease2 = await pending;
    expect(lease2.user).toBe('u1');
  });
});
