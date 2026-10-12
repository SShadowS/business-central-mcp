/**
 * Live regression for the IsExecuting liveness watchdog
 * (docs/superpowers/specs/2026-07-24-long-running-ops-design.md, test plan #16).
 *
 * Pins the BC behaviour the watchdog depends on: /csh answers an out-of-band
 * IsExecuting while another Invoke is outstanding, with a parseable
 * DN.IsExecutingHandler answer, without corrupting the sequence. If a future BC
 * version breaks this, this file fails before the watchdog starts killing
 * healthy sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BCSession } from '../../src/session/bc-session.js';
import type { ProbeAnswer } from '../../src/session/isexecuting-poller.js';
import type { OpenFormInteraction } from '../../src/protocol/types.js';
import { isOk } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

// Reach the private probe directly: the point is to assert the live wire answer,
// which the public API only exposes indirectly through kill/no-kill outcomes.
type Probeable = { probeIsExecuting(): Promise<ProbeAnswer>; liveness: { pollIntervalMs: number; maxDurationMs: number } };

describe('IsExecuting liveness (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  const tenant = process.env.BC_TENANT_ID ?? 'default';
  const openPage = (id: number): OpenFormInteraction => ({ type: 'OpenForm', query: `page=${id}&tenant=${tenant}` });
  const settles = (e: { type: string }) => e.type === 'InvokeCompleted' || e.type === 'FormCreated';

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  });

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('an idle session answers IsExecuting=false', async () => {
    const answer = await (session as unknown as Probeable).probeIsExecuting();
    expect(answer).toBe('false');
  });

  it('answers out-of-band probes while an invoke is in flight, without sequence corruption', async () => {
    const probe = () => (session as unknown as Probeable).probeIsExecuting();
    const invoke = session.invoke(openPage(20), settles); // G/L Entries: the Gate A workload
    const answers = await Promise.all([probe(), probe(), probe()]);
    for (const a of answers) expect(['true', 'false']).toContain(a);

    expect(isOk(await invoke)).toBe(true);
    expect(isOk(await session.invoke(openPage(22), settles))).toBe(true); // queue + sequence intact
    expect(session.isAlive).toBe(true);
  });

  it('an aggressive poll interval never false-kills ordinary invokes', async () => {
    const p = session as unknown as Probeable;
    const saved = p.liveness;
    p.liveness = { pollIntervalMs: 20, maxDurationMs: 60_000 }; // probe nearly every invoke
    try {
      for (const id of [20, 22, 21, 27, 31]) {
        const r = await session.invoke(openPage(id), settles);
        expect(isOk(r), `page ${id}: ${isOk(r) ? '' : r.error.message}`).toBe(true);
      }
      expect(session.isAlive).toBe(true);
    } finally {
      p.liveness = saved;
    }
  });
});
