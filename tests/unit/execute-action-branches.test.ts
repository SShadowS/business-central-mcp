// tests/unit/execute-action-branches.test.ts
//
// Tests for UNCOVERED branches in ExecuteActionOperation.
// Already tested elsewhere (stale-context-guard.test.ts, execute-action-cue.test.ts):
//   - expectedStateVersion mismatch -> STALE_CONTEXT
//   - executeOnCue success/error paths
//
// This file covers the REMAINING uncovered branches:
//   1. cue provided WITHOUT section -> PROTOCOL_ERROR, no service call
//   2. Neither action nor cue provided -> PROTOCOL_ERROR, no service call
//   3. executeAction error -> propagated (error path not covered by stale-context tests)
//   4. executeOnCue business error -> classifyBusinessError returns err
//   5. executeAction business error -> classifyBusinessError returns err
//   6. buildOutput: openedPages detection from FormCreated events
//   7. buildOutput: no updatedFields when ar.updatedState is absent
//   8. buildOutput: requiresDialogResponse=true when dialogsOpened has entries

import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { ActionService } from '../../src/services/action-service.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeActionService(overrides?: Record<string, unknown>) {
  return {
    executeAction: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    executeOnCue: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    ...overrides,
  } as any;
}

function makeRepo(withPage = true) {
  const repo = new PageContextRepository();
  if (withPage) {
    repo.create('pc:1', 'F1');
  }
  return repo;
}

// These branch tests never pass bookmark/rowIndex, so selectRow is never hit.
function makeNav() {
  return { selectRow: async () => ({ ok: true, value: {} }) } as any;
}

// Minimal stub for DownloadService — captures nothing.
function makeDownloadService() {
  return { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any;
}

describe('ExecuteActionOperation — input validation (uncovered branches)', () => {
  it('returns PROTOCOL_ERROR when cue is provided without section, before calling service', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      cue: 'Sales Quotes',
      // section is missing
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/section/i);
      expect(result.error.code).toBe('PROTOCOL_ERROR');
    }
    expect(actionService.executeOnCue).not.toHaveBeenCalled();
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });

  it('returns PROTOCOL_ERROR when neither action nor cue is provided', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      // neither action nor cue
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/action/i);
      expect(result.error.code).toBe('PROTOCOL_ERROR');
    }
    expect(actionService.executeAction).not.toHaveBeenCalled();
    expect(actionService.executeOnCue).not.toHaveBeenCalled();
  });
});

describe('ExecuteActionOperation — service error propagation (uncovered)', () => {
  it('propagates executeAction error unchanged', async () => {
    const actionService = makeActionService({
      executeAction: vi.fn(async () => err(new ProtocolError('Action not found: Post'))),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      action: 'Post',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Action not found: Post');
    }
  });

  it('propagates executeOnCue error unchanged', async () => {
    const actionService = makeActionService({
      executeOnCue: vi.fn(async () => err(new ProtocolError('Cue not found: Sales Quotes'))),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      section: 'subpage:Activities',
      cue: 'Sales Quotes',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Cue not found');
    }
  });
});

describe('ExecuteActionOperation — business error classification (uncovered)', () => {
  it('returns BUSINESS_ERROR when executeAction events contain a MessageToShow error', async () => {
    // BC sends MessageToShow with messageType='Error' for business-level failures.
    // classifyBusinessError uses event.text (not event.message) per the BCEvent type.
    const businessErrorEvent: BCEvent = {
      type: 'MessageToShow',
      text: 'You cannot post because the document is already posted.',
      messageType: 'Error',
    } as any;
    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: false, events: [businessErrorEvent] })),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      action: 'Post',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BUSINESS_ERROR');
      expect(result.error.message).toContain('already posted');
    }
  });

  it('returns BUSINESS_ERROR when executeOnCue events contain a MessageToShow error', async () => {
    const businessErrorEvent: BCEvent = {
      type: 'MessageToShow',
      text: 'Drill-down not available.',
      messageType: 'Error',
    } as any;
    const actionService = makeActionService({
      executeOnCue: vi.fn(async () => ok({ success: false, events: [businessErrorEvent] })),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:1',
      section: 'subpage:Activities',
      cue: 'Sales Quotes',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BUSINESS_ERROR');
    }
  });
});

describe('ExecuteActionOperation — buildOutput (uncovered branches)', () => {
  it('omits updatedFields when ar.updatedState is absent', async () => {
    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: true, events: [] as BCEvent[], updatedState: undefined })),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Refresh' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedFields).toBeUndefined();
  });

  it('returns requiresDialogResponse=true when events contain DialogOpened', async () => {
    const dialogEvent: BCEvent = {
      type: 'DialogOpened',
      formId: 'confirm-1',
      controlTree: { t: 'lf', ServerId: 'confirm-1', Caption: 'Confirm?', Children: [] },
    } as any;
    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: true, events: [dialogEvent] })),
    });
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Post' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiresDialogResponse).toBe(true);
    expect(result.value.dialogsOpened).toHaveLength(1);
    expect(result.value.dialogsOpened[0]!.formId).toBe('confirm-1');
    expect(result.value.dialogsOpened[0]!.message).toBe('Confirm?');
  });

  it('returns requiresDialogResponse=false when no DialogOpened events', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Refresh' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiresDialogResponse).toBe(false);
    expect(result.value.dialogsOpened).toEqual([]);
  });

  it('detects opened pages from FormCreated events for forms not matching source rootFormId', async () => {
    // Set up repo with two pages so getByFormId returns something for the new form
    const repo = makeRepo();
    repo.create('pc:new-page', 'F2');

    // FormCreated for F2 (a different form than pc:1's rootFormId F1)
    const formCreatedEvent: BCEvent = {
      type: 'FormCreated',
      formId: 'F2',
      isReload: false,
      controlTree: { t: 'lf', ServerId: 'F2', Caption: 'Posted Invoice', PageType: 2, Children: [] },
    } as any;

    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: true, events: [formCreatedEvent] })),
    });
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Post' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.openedPages).toHaveLength(1);
    expect(result.value.openedPages[0]!.pageContextId).toBe('pc:new-page');
  });

  it('does not include own form in openedPages when FormCreated matches rootFormId', async () => {
    const repo = makeRepo();
    // FormCreated for the SAME form (a reload), not a new page
    const selfReloadEvent: BCEvent = {
      type: 'FormCreated',
      formId: 'F1', // same as pc:1's rootFormId
      isReload: true,
      controlTree: { t: 'lf', ServerId: 'F1', Caption: 'Customer Card', PageType: 2, Children: [] },
    } as any;

    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: true, events: [selfReloadEvent] })),
    });
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Refresh' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should NOT include pc:1 as an opened page (it's the source)
    expect(result.value.openedPages).toHaveLength(0);
  });

  it('returns empty openedPages when FormCreated form is not registered in repo', async () => {
    const repo = makeRepo();
    // FormCreated for a form that has no corresponding pageContextId in the repo
    const unknownFormEvent: BCEvent = {
      type: 'FormCreated',
      formId: 'F-unknown-not-in-repo',
      isReload: false,
      controlTree: { t: 'lf', ServerId: 'F-unknown-not-in-repo', Caption: 'Something', PageType: 2, Children: [] },
    } as any;

    const actionService = makeActionService({
      executeAction: vi.fn(async () => ok({ success: true, events: [unknownFormEvent] })),
    });
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Post' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.openedPages).toHaveLength(0);
  });
});

describe('ActionService.executeAction — selection descriptor (atomic path)', () => {
  // Same ctx-shaping as execute-action-cue.test.ts: create() auto-registers a
  // 'header' section against rootFormId; applyEvents seeds a real (empty) lf
  // control tree so treeActions/treeRepeaters have a proper root to walk.
  function makeRepo() {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'root', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated',
      formId: 'root',
      controlTree: { t: 'lf', ServerId: 'root', PageType: 1, Children: [] },
    } as BCEvent]);
    return repo;
  }

  function invokeCompletedEvents(): BCEvent[] {
    return [{
      type: 'InvokeCompleted',
      sequenceNumber: 1,
      completedInteractions: [{ invocationId: 'cb1', durationMs: 0 }],
    } as BCEvent];
  }

  function makeSession() {
    return {
      invoke: vi.fn(async () => ok(invokeCompletedEvents())),
      invokeSequence: vi.fn(async () => ok(invokeCompletedEvents())),
    };
  }

  const logger: any = { info() {}, debug() {}, warn() {}, error() {} };

  it('routes select+action through invokeSequence when a selection is given', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const svc = new ActionService(session as any, repo, logger);

    const result = await svc.executeAction('pc:1', 'Delete', 'header', {
      formId: 'f',
      controlPath: 'server:c[0]',
      bookmarks: ['A', 'B'],
    });

    expect(result.ok).toBe(true);
    expect(session.invoke).not.toHaveBeenCalled();
    expect(session.invokeSequence).toHaveBeenCalledTimes(1);

    const [interactions] = session.invokeSequence.mock.calls[0]!;
    expect(interactions).toHaveLength(2);
    expect(interactions[0]).toMatchObject({
      type: 'SetCurrentRow',
      formId: 'f',
      controlPath: 'server:c[0]',
      key: 'A',
      rowsToSelect: ['A', 'B'],
    });
    expect(interactions[1]).toMatchObject({ type: 'InvokeAction' });
  });

  it('uses a single invoke when no selection is given (unchanged path)', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const svc = new ActionService(session as any, repo, logger);

    const result = await svc.executeAction('pc:1', 'Refresh');

    expect(result.ok).toBe(true);
    expect(session.invoke).toHaveBeenCalledTimes(1);
    expect(session.invokeSequence).not.toHaveBeenCalled();
  });

  // Load-bearing property: for a row-targeting action (Delete) on a page that
  // HAS a repeater, the action interaction must target the row-scoped
  // `{repeater}/cr/c[0]` path, not the bare repeater path or a default
  // 'server:c[0]' fallback. This is what makes "delete these selected rows"
  // actually operate on the current row BC just selected via SetCurrentRow.
  // Mirrors the repeater fixture in tests/unit/select-rows.test.ts /
  // tests/protocol/section-resolver.test.ts (`{ t: 'rc', Columns: [...] }` as
  // the root's only child -> repeater.controlPath === 'server:c[0]').
  it('targets the repeater cr/c[0] controlPath for Delete+selection (row-scoped, not the raw repeater or default path)', async () => {
    const session = makeSession();
    const repo = new PageContextRepository();
    repo.create('pc:2', 'F1', { isModal: false, wizardState: null });
    repo.applyEvents([{
      type: 'FormCreated',
      formId: 'F1',
      controlTree: {
        t: 'lf', ServerId: 'F1', PageType: 1,
        Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] }],
      },
    } as BCEvent]);
    const svc = new ActionService(session as any, repo, logger);

    const result = await svc.executeAction('pc:2', 'Delete', 'header', {
      formId: 'f',
      controlPath: 'server:c[0]',
      bookmarks: ['A', 'B'],
    });

    expect(result.ok).toBe(true);
    const [interactions] = session.invokeSequence.mock.calls[0]!;
    expect(interactions[1]).toMatchObject({
      type: 'InvokeAction',
      controlPath: 'server:c[0]/cr/c[0]',
      systemAction: 20, // SystemAction.Delete
    });
  });
});

describe('ActionService.isCurrentRowOnlyAction', () => {
  const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
  const svc = new ActionService({} as any, new PageContextRepository(), logger);

  it('returns true for Edit (current-row-only)', () => {
    expect(svc.isCurrentRowOnlyAction('Edit')).toBe(true);
  });

  it('returns true for View (current-row-only)', () => {
    expect(svc.isCurrentRowOnlyAction('View')).toBe(true);
  });

  it('returns true for DrillDown (current-row-only, not in SYSTEM_ACTION_NAMES)', () => {
    expect(svc.isCurrentRowOnlyAction('DrillDown')).toBe(true);
  });

  it('returns true for New (current-row-only)', () => {
    expect(svc.isCurrentRowOnlyAction('New')).toBe(true);
  });

  it('returns false for Delete (consumes the selection)', () => {
    expect(svc.isCurrentRowOnlyAction('Delete')).toBe(false);
  });
});
