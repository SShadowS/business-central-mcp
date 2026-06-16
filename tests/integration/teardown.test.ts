/**
 * Integration test: idempotent teardown / server-side session reap
 *
 * Verifies that after closing a page on a live BC session, the same session
 * (same NTLM slot / same user) can immediately open another page without
 * hitting leaked modal state or NTLM-slot blocking.
 *
 * Uses the shared pool so NTLM slots are respected across test files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { isOk, isErr } from '../../src/core/result.js';
import type { OpenFormInteraction } from '../../src/protocol/types.js';

describe('session teardown (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  }, 60_000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('opens a page, closes it, then immediately opens another page on the same session', async () => {
    // Step 1: Open Customer List (page 22)
    const open1: OpenFormInteraction = {
      type: 'OpenForm',
      query: 'page=22&tenant=default',
      controlPath: 'server:c[0]',
    };
    const result1 = await session.invoke(open1, (e) => e.type === 'InvokeCompleted');
    expect(isErr(result1)).toBe(false);
    if (isErr(result1)) return;

    const formCreated = result1.value.find(e => e.type === 'FormCreated');
    expect(formCreated).toBeTruthy();
    const formId = (formCreated as any).formId as string;
    expect(typeof formId).toBe('string');

    // Step 2: Close the form
    const closeResult = await session.invoke(
      { type: 'CloseForm', formId },
      (e) => e.type === 'InvokeCompleted',
    );
    expect(isErr(closeResult)).toBe(false);

    // Session must still be alive after close
    expect(session.isAlive).toBe(true);

    // Step 3: Immediately open a different page on the same session
    // (no sleep -- verifies no leaked modal/NTLM-slot block)
    const open2: OpenFormInteraction = {
      type: 'OpenForm',
      query: 'page=18&tenant=default', // G/L Account List
      controlPath: 'server:c[0]',
    };
    const result2 = await session.invoke(open2, (e) => e.type === 'InvokeCompleted');
    expect(isErr(result2)).toBe(false);
    if (isErr(result2)) return;

    const form2Created = result2.value.find(e => e.type === 'FormCreated');
    expect(form2Created).toBeTruthy();
  }, 60_000);

  it('closeGracefully() on a live session with open forms leaves session dead and usable NTLM slot', async () => {
    // Open a form first so there is state to tear down
    const open: OpenFormInteraction = {
      type: 'OpenForm',
      query: 'page=22&tenant=default',
      controlPath: 'server:c[0]',
    };
    const openResult = await session.invoke(open, (e) => e.type === 'InvokeCompleted');
    expect(isOk(openResult)).toBe(true);

    // Graceful close
    await session.closeGracefully();
    expect(session.isAlive).toBe(false);

    // Calling closeGracefully again must be a no-op (idempotency)
    await session.closeGracefully();
    expect(session.isAlive).toBe(false);
  }, 60_000);
});
