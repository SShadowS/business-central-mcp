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
import { SystemAction, type BCEvent, type DialogOpenedEvent } from '../../src/protocol/types.js';
import { formClosed } from '../../src/protocol/replay-safety.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { fields } from '../../src/protocol/form-views.js';

async function openRequestPage(session: BCSession): Promise<DialogOpenedEvent> {
  const events = unwrap(await session.invoke(
    { type: 'OpenForm', query: 'report=6&tenant=default', controlPath: 'server:c[0]' },
    (e) => e.type === 'InvokeCompleted',
  ));
  const dialog = events.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened');
  expect(dialog, `Expected DialogOpened. Got: ${events.map(e => e.type).join(',')}`).toBeDefined();
  return dialog!;
}

// A real Yes/No ConfirmDialog with nothing persistent behind either answer:
// an out-of-range "Maximum rows" (an in-memory request page option) gives the
// request page a validation error, and Refresh(30) on a form with errors asks
// Message_DiscardChanges (decompiled NavRefreshAction.TryRefreshData ->
// DoConfirm; NavActionHelper.SuppressDiscardErrorsDialog is false on the web
// target). Yes clears the errors and refills (reads only); No returns before
// clearing. Request page values are saved only by PerformReportAction
// (Print/Preview/Send), never on close, and closing the page cancels it.
async function openDiscardConfirm(session: BCSession, requestPage: DialogOpenedEvent): Promise<DialogOpenedEvent | undefined> {
  const events = unwrap(await session.invoke(
    { type: 'InvokeAction', formId: requestPage.formId, controlPath: 'server:c[0]', systemAction: SystemAction.Refresh },
    (e) => e.type === 'InvokeCompleted',
  ));
  return events.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened');
}

async function requestPageWithError(session: BCSession): Promise<DialogOpenedEvent> {
  const requestPage = await openRequestPage(session);
  const maxRows = fields(buildFormTree(requestPage.controlTree)).find(f => f.properties.caption === 'Maximum rows');
  expect(maxRows, 'Expected a "Maximum rows" field on the request page').toBeDefined();
  const saved = unwrap(await session.invoke(
    { type: 'SaveValue', formId: requestPage.formId, controlPath: maxRows!.controlPath, newValue: 'abc' },
    (e) => e.type === 'InvokeCompleted',
  ));
  const hasError = saved.some(e => e.type === 'PropertyChanged'
    && Array.isArray(e.changes['ValidationResults']) && (e.changes['ValidationResults'] as unknown[]).length > 0);
  expect(hasError, 'Expected a validation error on the request page').toBe(true);
  return requestPage;
}

function mappingHint(dialog: DialogOpenedEvent | undefined): unknown {
  return (dialog?.controlTree as Record<string, unknown> | undefined)?.['MappingHint'];
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
    // reconcileModalStack only closes dialogs on its safe-hint list.
    expect((dialog.controlTree as Record<string, unknown>)['MappingHint']).toBe('RequestPage');
    unwrap(await session.invoke({ type: 'CloseForm', formId: dialog.formId }, (e) => e.type === 'InvokeCompleted'));
    expect(session.modalStackSnapshot()).toEqual([]);
  }, 60_000);

  it('Abort on a dialog without an Abort action is ignored: no close, nothing opened (#38)', async () => {
    const dialog = await openRequestPage(session);
    const events = unwrap(await session.invoke(
      { type: 'InvokeAction', formId: dialog.formId, controlPath: 'server:c[0]', systemAction: SystemAction.Abort },
      (e) => e.type === 'InvokeCompleted',
    ));
    // The exact signal bc_respond_dialog turns into an error.
    expect(formClosed(events, dialog.formId)).toBe(false);
    expect(events.some(e => e.type === 'DialogOpened' || e.type === 'FormCreated')).toBe(false);
    expect(session.modalStackSnapshot()).toEqual([dialog.formId]);
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

  it('CloseForm on a real ConfirmDialog reads as No: the refresh it guarded asks again', async () => {
    const requestPage = await requestPageWithError(session);
    // Close the confirm with the exact interaction reconcileModalStack sends.
    const first = await openDiscardConfirm(session, requestPage);
    expect(mappingHint(first)).toBe('ConfirmDialog');
    const closed = unwrap(await session.invoke({ type: 'CloseForm', formId: first!.formId }, (e) => e.type === 'InvokeCompleted'));
    expect(formClosed(closed, first!.formId)).toBe(true);
    expect(session.modalStackSnapshot()).toEqual([requestPage.formId]);
    // No: Refresh returned before clearing the error, so the next one asks again
    // (with Yes it asks nothing, see the next test).
    const second = await openDiscardConfirm(session, requestPage);
    expect(mappingHint(second)).toBe('ConfirmDialog');
    // Yes (read-only here) clears the error so the request page can close.
    unwrap(await session.invoke(
      { type: 'InvokeAction', formId: second!.formId, controlPath: 'server:', systemAction: SystemAction.Yes },
      (e) => e.type === 'InvokeCompleted',
    ));
    unwrap(await session.invoke({ type: 'CloseForm', formId: requestPage.formId }, (e) => e.type === 'InvokeCompleted'));
    expect(session.modalStackSnapshot()).toEqual([]);
  }, 90_000);

  it('reconcileModalStack closes every confirm as No, so a request page with errors never closes (fails safe)', async () => {
    const reconciled: BCEvent[] = [];
    session.onReconciledClose = (ev) => reconciled.push(...ev);
    const requestPage = await requestPageWithError(session);
    const confirm = await openDiscardConfirm(session, requestPage);
    expect(mappingHint(confirm)).toBe('ConfirmDialog');

    // Closing a top-level form with errors asks Message_DiscardChanges
    // (decompiled LogicalFormClosingHandler.HandleFormClosingWhenErrors, skipped
    // only for FormClose.ForceClose); a closed confirm is not Yes, so the close
    // is cancelled. Reconcile alternates CloseForm(confirm) / CloseForm(request
    // page -> new confirm) until it gives up, and the caller resets the session.
    const reconcile = await session.reconcileModalStack();
    expect(isOk(reconcile)).toBe(false);
    if (!isOk(reconcile)) expect(reconcile.error.message).toContain('still has 2 entries');
    expect(reconciled.length).toBe(5);
    expect(reconciled[0]).toEqual({ type: 'FormClosed', formId: confirm!.formId });
    expect(reconciled.every(e => e.type === 'FormClosed' && e.formId !== requestPage.formId)).toBe(true);
    const stack = session.modalStackSnapshot();
    expect(stack[0]).toBe(requestPage.formId);
    expect(session.isAlive).toBe(true);

    // Cleanup: Yes on the closing confirm cancels the request page in memory and
    // force-closes it (NavRequestPage.OnFormClosing -> DialogResult Cancel).
    unwrap(await session.invoke(
      { type: 'InvokeAction', formId: stack[1]!, controlPath: 'server:', systemAction: SystemAction.Yes },
      (e) => e.type === 'InvokeCompleted',
    ));
    expect(session.modalStackSnapshot()).toEqual([]);
    const list = await session.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default', controlPath: 'server:c[0]' },
      (e) => e.type === 'InvokeCompleted',
    );
    expect(isOk(list)).toBe(true);
  }, 90_000);

  it('the re-ask is the No signal: Yes on the same confirm clears the error and Refresh asks nothing', async () => {
    const requestPage = await requestPageWithError(session);
    const confirm = await openDiscardConfirm(session, requestPage);
    expect(mappingHint(confirm)).toBe('ConfirmDialog');
    // Yes here only discards an in-memory request page error and refills (reads).
    unwrap(await session.invoke(
      { type: 'InvokeAction', formId: confirm!.formId, controlPath: 'server:', systemAction: SystemAction.Yes },
      (e) => e.type === 'InvokeCompleted',
    ));
    expect(session.modalStackSnapshot()).toEqual([requestPage.formId]);
    expect(await openDiscardConfirm(session, requestPage)).toBeUndefined();
    unwrap(await session.invoke({ type: 'CloseForm', formId: requestPage.formId }, (e) => e.type === 'InvokeCompleted'));
    expect(session.modalStackSnapshot()).toEqual([]);
  }, 90_000);

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
