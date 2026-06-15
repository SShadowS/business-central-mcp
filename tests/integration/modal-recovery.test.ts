// tests/integration/modal-recovery.test.ts
//
// Plan B Task 8 -- live verification of modal-stack tracking and
// reconcileModalStack against real BC.
//
// Trigger choice (verified empirically against BC28):
//   - Tell Me (SystemAction.PageSearch=220) was the spec's first choice but
//     BC emits FormToShow (-> FormCreated), not DialogToShow, so the search
//     page does not push onto the modal stack.
//   - Delete (SystemAction.Delete=20) on a Customer List row reliably emits
//     a true DialogToShow ("Delete the selected record?"), which lands on
//     modalStack as DialogOpened. We never confirm the deletion.
//
// Each test gets a fresh BC session because BC28 does not emit FormClosed
// when a confirm dialog is closed via CloseForm/InvokeAction(Abort) -- the
// server-side dialog stays open even though our local reconcile force-pops
// the modalStack. To avoid leaking state across tests, each test owns its
// own session and tears it down (closeGracefully) afterwards.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { isOk, unwrap } from '../../src/core/result.js';
import type {
  BCEvent,
  OpenFormInteraction,
  InvokeActionInteraction,
  FormCreatedEvent,
  DialogOpenedEvent,
} from '../../src/protocol/types.js';
import { repeaters as treeRepeaters } from '../../src/protocol/form-views.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

/**
 * Open Customer List (page 22) and discover the repeater's controlPath from
 * the FormCreated event's controlTree.
 */
async function openCustomerList(session: BCSession): Promise<{ formId: string; repeaterPath: string }> {
  const open: OpenFormInteraction = {
    type: 'OpenForm',
    query: `page=22&tenant=default`,
    controlPath: 'server:c[0]',
  };
  const result = await session.invoke(open, (e) => e.type === 'InvokeCompleted');
  expect(isOk(result)).toBe(true);
  const events = unwrap(result);
  const created = events.find((e): e is FormCreatedEvent => e.type === 'FormCreated' && !e.parentFormId);
  expect(created, 'Customer List should emit a FormCreated event').toBeDefined();
  if (!created) throw new Error('no FormCreated');

  const root = buildFormTree(created.controlTree);
  const repeater = treeRepeaters(root).values().next().value;
  expect(repeater, 'Customer List should have a repeater').toBeDefined();
  if (!repeater) throw new Error('no repeater');

  return { formId: created.formId, repeaterPath: repeater.controlPath };
}

/**
 * Trigger a Delete confirm dialog on the first row of the Customer List.
 * The dialog must be closed by the test before tearing down the session.
 */
async function triggerDeleteConfirm(
  session: BCSession,
  formId: string,
  repeaterPath: string,
): Promise<DialogOpenedEvent> {
  const del: InvokeActionInteraction = {
    type: 'InvokeAction',
    formId,
    controlPath: `${repeaterPath}/cr/c[0]`,
    systemAction: 20, // Delete
  };
  const result = await session.invoke(
    del,
    (e) => e.type === 'DialogOpened' || e.type === 'InvokeCompleted',
  );
  expect(isOk(result)).toBe(true);
  const events: BCEvent[] = unwrap(result);
  const dialog = events.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened');
  expect(
    dialog,
    `Expected DialogOpened event for Delete confirm. Got: ${events.map(e => e.type).join(',')}`,
  ).toBeDefined();
  if (!dialog) throw new Error('no dialog');
  return dialog;
}

describe('Modal stack reconciliation (integration, BC28)', () => {
  let session: BCSession;
  let lease: PooledLease;

  // Fresh session per test -- BC's confirm-dialog state is sticky server-side
  // (no FormClosed on Abort), so reusing a session across tests would leak
  // dialog state and trip LogicalModalityViolation on the next OpenForm.
  beforeEach(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  }, 60_000);

  afterEach(async () => {
    // Always poison: delete-confirm dialog leaves dirty modal state server-side.
    if (lease) await integrationPool.checkIn(lease, { poisoned: true });
  });

  it('tracks the Delete-confirm DialogOpened on modalStack', async () => {
    expect(session.modalStackSnapshot()).toEqual([]);

    const { formId: listFormId, repeaterPath } = await openCustomerList(session);
    // page 22 itself is not modal -- DataTable is a regular form
    expect(session.modalStackSnapshot()).toEqual([]);

    const dialog = await triggerDeleteConfirm(session, listFormId, repeaterPath);

    // The DialogOpened event for the confirm should have pushed onto modalStack
    // and added the formId to openFormIds (verified via updateFormTracking).
    expect(session.modalStackSnapshot()).toContain(dialog.formId);
    expect(session.modalStackSnapshot()[session.modalStackSnapshot().length - 1]).toBe(dialog.formId);
    expect(session.openFormIds.has(dialog.formId)).toBe(true);
  }, 60_000);

  it('reconcileModalStack walks an open modal stack and clears it', async () => {
    expect(session.modalStackSnapshot()).toEqual([]);

    const { formId: listFormId, repeaterPath } = await openCustomerList(session);
    const dialog = await triggerDeleteConfirm(session, listFormId, repeaterPath);

    expect(session.modalStackSnapshot()).toContain(dialog.formId);
    const stackSizeBefore = session.modalStackSnapshot().length;
    expect(stackSizeBefore).toBeGreaterThan(0);

    // Reconcile -- sends Abort to each modal in turn, force-popping the local
    // stack even if BC doesn't emit FormClosed for the Abort. The local
    // modalStack must end empty regardless of BC's actual server-side state.
    const reconcile = await session.reconcileModalStack();
    expect(isOk(reconcile)).toBe(true);
    expect(session.modalStackSnapshot()).toEqual([]);
    // openFormIds should also have the modal removed (force-pop drops it).
    expect(session.openFormIds.has(dialog.formId)).toBe(false);
  }, 60_000);
});
