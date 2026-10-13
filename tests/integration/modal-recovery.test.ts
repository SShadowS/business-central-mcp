// tests/integration/modal-recovery.test.ts
//
// Live verification of modal-stack tracking and reconcileModalStack (#35).
//
// Trigger: the request page of report 6 (Trial Balance), opened with
// OpenForm(report=6). It arrives as DialogOpened, so it lands on modalStack and
// blocks the next OpenForm with LogicalModalityViolation, exactly like a stale
// confirm -- but closing it runs nothing (no Delete confirm on a real record).
//
// Verified live (cronus29): InvokeAction(Abort=320) on this dialog answers
// InvokeCompleted only, no State=0, and the next OpenForm still violates
// modality -- the dialog has no Abort button, so InvokeActionInteraction finds
// no action to run. CloseForm reports State=0 (-> FormClosed) and clears it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { isOk, unwrap } from '../../src/core/result.js';
import type { BCEvent, DialogOpenedEvent } from '../../src/protocol/types.js';

async function openRequestPage(session: BCSession): Promise<DialogOpenedEvent> {
  const events = unwrap(await session.invoke(
    { type: 'OpenForm', query: 'report=6&tenant=default', controlPath: 'server:c[0]' },
    (e) => e.type === 'InvokeCompleted',
  ));
  const dialog = events.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened');
  expect(dialog, `Expected DialogOpened. Got: ${events.map(e => e.type).join(',')}`).toBeDefined();
  return dialog!;
}

describe('Modal stack reconciliation (integration)', () => {
  let session: BCSession;
  let lease: PooledLease;

  beforeEach(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  }, 60_000);

  afterEach(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('tracks the request page on modalStack', async () => {
    expect(session.modalStackSnapshot()).toEqual([]);
    const dialog = await openRequestPage(session);
    expect(session.modalStackSnapshot()).toEqual([dialog.formId]);
    expect(session.openFormIds.has(dialog.formId)).toBe(true);
    unwrap(await session.invoke({ type: 'CloseForm', formId: dialog.formId }, (e) => e.type === 'InvokeCompleted'));
    expect(session.modalStackSnapshot()).toEqual([]);
  }, 60_000);

  it('reconcileModalStack closes the dialog server-side (State=0 -> FormClosed)', async () => {
    const reconciled: BCEvent[] = [];
    session.onReconciledClose = (ev) => reconciled.push(...ev);
    const dialog = await openRequestPage(session);

    const reconcile = await session.reconcileModalStack();
    expect(isOk(reconcile)).toBe(true);
    expect(session.modalStackSnapshot()).toEqual([]);
    expect(session.openFormIds.has(dialog.formId)).toBe(false);
    expect(reconciled).toEqual([{ type: 'FormClosed', formId: dialog.formId }]);

    // BC really closed it: a non-modal OpenForm no longer violates modality.
    const list = await session.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default', controlPath: 'server:c[0]' },
      (e) => e.type === 'InvokeCompleted',
    );
    expect(isOk(list)).toBe(true);
    expect(session.isAlive).toBe(true);
  }, 60_000);

  it('a LogicalModalityViolation recovers through reconcile and retries the interaction', async () => {
    const dialog = await openRequestPage(session);
    // Stale dialog: BC still holds it, the caller opens a page anyway.
    const list = await session.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default', controlPath: 'server:c[0]' },
      (e) => e.type === 'InvokeCompleted',
    );
    expect(isOk(list)).toBe(true);
    expect(unwrap(list).some(e => e.type === 'FormCreated')).toBe(true);
    expect(session.openFormIds.has(dialog.formId)).toBe(false);
    expect(session.modalStackSnapshot()).toEqual([]);
    expect(session.isAlive).toBe(true);
  }, 60_000);
});
