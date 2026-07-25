// tests/unit/execute-action-bookmarks.test.ts
//
// Tests for ExecuteActionOperation's `bookmarks[]` multi-row selection input:
//   1. bookmarks + bookmark -> ProtocolError, no BC traffic.
//   2. bookmarks + rowIndex -> error, no BC traffic.
//   3. bookmarks + cue -> error, no BC traffic.
//   4. bookmarks: [] -> error. bookmarks: ['A',''] -> error.
//   5. bookmarks longer than maxSelection -> error.
//   6. bookmarks: ['A','B','A'] -> executeAction receives deduped ['A','B'] (order preserved).
//   7. bookmarks + current-row-only action (Edit) -> error, no BC traffic.
//   8. bookmarks + Delete -> executeAction called with the selection descriptor.
//   9. executeAction erroring with an InvalidBookmarkException message -> InvalidBookmarkError (INVALID_BOOKMARK).

import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeActionService(overrides?: Record<string, unknown>) {
  return {
    executeAction: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    executeOnCue: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    isCurrentRowOnlyAction: vi.fn((name: string) => ['edit', 'view', 'drilldown', 'new'].includes(name.toLowerCase())),
    ...overrides,
  } as any;
}

// Bare page context, no repeater -- sufficient for the validation branches that
// return before ever touching the repo (exclusivity, action-presence, empty/max,
// current-row-only).
function makeBareRepo() {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'F1');
  return repo;
}

// Full ctx with a repeater on the root form -- needed for the branches that
// resolve the section's repeater and actually call executeAction. Mirrors the
// 'ActionService.executeAction — selection descriptor (atomic path)' fixture
// in execute-action-branches.test.ts.
function makeRepoWithRepeater() {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'F1', { isModal: false, wizardState: null });
  repo.applyEvents([{
    type: 'FormCreated',
    formId: 'F1',
    controlTree: {
      t: 'lf', ServerId: 'F1', PageType: 1,
      Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] }],
    },
  } as BCEvent]);
  return repo;
}

function makeNav() {
  return { selectRow: async () => ({ ok: true, value: {} }) } as any;
}

function makeDownloadService() {
  return { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any;
}

const DEFAULT_MAX_SELECTION = 100;

describe('ExecuteActionOperation — bookmarks[] exclusivity (no BC traffic)', () => {
  it('rejects bookmarks + bookmark', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A'], bookmark: 'A' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROTOCOL_ERROR');
      expect(result.error.message).toMatch(/bookmarks/i);
      expect(result.error.message).toMatch(/bookmark/i);
    }
    expect(actionService.executeAction).not.toHaveBeenCalled();
    expect(actionService.executeOnCue).not.toHaveBeenCalled();
  });

  it('rejects bookmarks + rowIndex', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A'], rowIndex: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROTOCOL_ERROR');
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });

  it('rejects bookmarks + cue', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', section: 'header', cue: 'Sales Quotes', bookmarks: ['A'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROTOCOL_ERROR');
    expect(actionService.executeAction).not.toHaveBeenCalled();
    expect(actionService.executeOnCue).not.toHaveBeenCalled();
  });
});

describe('ExecuteActionOperation — bookmarks[] shape validation (no BC traffic)', () => {
  it('rejects an empty bookmarks array', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROTOCOL_ERROR');
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });

  it('rejects a bookmarks array containing an empty string', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A', ''] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROTOCOL_ERROR');
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });

  it('rejects bookmarks longer than maxSelection', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    // Small cap, unique bookmarks -- unambiguous regardless of dedupe-vs-cap ordering.
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), 2);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A', 'B', 'C'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROTOCOL_ERROR');
      expect(result.error.message).toMatch(/maximum/i);
    }
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });
});

describe('ExecuteActionOperation — bookmarks[] current-row-only rejection (no BC traffic)', () => {
  it('rejects bookmarks with a current-row-only action (Edit)', async () => {
    const actionService = makeActionService();
    const repo = makeBareRepo();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Edit', bookmarks: ['A', 'B'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROTOCOL_ERROR');
    expect(actionService.isCurrentRowOnlyAction).toHaveBeenCalledWith('Edit');
    expect(actionService.executeAction).not.toHaveBeenCalled();
  });
});

describe('ExecuteActionOperation — bookmarks[] resolution + dispatch', () => {
  it('de-dupes bookmarks order-preserving before calling executeAction', async () => {
    const actionService = makeActionService();
    const repo = makeRepoWithRepeater();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A', 'B', 'A'] });

    expect(result.ok).toBe(true);
    expect(actionService.executeAction).toHaveBeenCalledTimes(1);
    const [, actionName, sectionId, selection] = actionService.executeAction.mock.calls[0]!;
    expect(actionName).toBe('Delete');
    expect(sectionId).toBeUndefined();
    expect(selection.bookmarks).toEqual(['A', 'B']);
  });

  it('calls executeAction with the selection descriptor for a consuming action (Delete)', async () => {
    const actionService = makeActionService();
    const repo = makeRepoWithRepeater();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A', 'B'] });

    expect(result.ok).toBe(true);
    expect(actionService.executeAction).toHaveBeenCalledTimes(1);
    const [pcId, actionName, , selection] = actionService.executeAction.mock.calls[0]!;
    expect(pcId).toBe('pc:1');
    expect(actionName).toBe('Delete');
    expect(selection.bookmarks).toEqual(['A', 'B']);
    expect(selection.controlPath).toBe('server:c[0]');
  });

  it('maps an InvalidBookmarkException error from executeAction to InvalidBookmarkError', async () => {
    const actionService = makeActionService({
      executeAction: vi.fn(async () => err(new ProtocolError(
        'RPC error: System.InvalidOperationException: InvalidBookmarkException: bookmark not found',
      ))),
    });
    const repo = makeRepoWithRepeater();
    const op = new ExecuteActionOperation(actionService, repo, makeNav(), makeDownloadService(), DEFAULT_MAX_SELECTION);

    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', bookmarks: ['A', 'B'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_BOOKMARK');
      expect((result.error as any).bookmark).toBe('A');
    }
  });
});
