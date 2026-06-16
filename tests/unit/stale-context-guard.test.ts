// tests/unit/stale-context-guard.test.ts
//
// Verify that WriteDataOperation and ExecuteActionOperation:
//   - return StaleContextError (code STALE_CONTEXT) when expectedStateVersion
//     mismatches the page context's current generation
//   - proceed normally when expectedStateVersion matches
//   - proceed normally when expectedStateVersion is omitted (opt-in only)

import { describe, it, expect, vi } from 'vitest';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

// Build a repo with a real page whose generation has been bumped `generation` times.
// Each FormCreated event is a structural mutation (applyRootControlTree always writes).
function makeRepo(targetGeneration: number) {
  const repo = new PageContextRepository();
  repo.create('pc1', 'F1');

  const makeTree = (caption: string) => ({
    t: 'lf',
    ServerId: 'F1',
    Caption: caption,
    PageType: 2, // Card
    Children: [
      {
        t: 'sc',
        Caption: 'Name',
        ColumnBinder: { Name: 'c1', Path: '18.2' },
        Editable: true,
        Visible: true,
      },
    ],
  });

  // Each applyEvents with a real FormCreated bumps generation by 1.
  for (let i = 0; i < targetGeneration; i++) {
    repo.applyEvents([
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree(`Caption${i}`) } as BCEvent,
    ]);
  }

  return repo;
}

// Minimal stub for DataService.writeFields that succeeds.
function makeDataServiceStub() {
  return {
    writeFields: vi.fn(async () => ok({ results: [], events: [] })),
  } as any;
}

// Minimal stub for ActionService that succeeds.
function makeActionServiceStub() {
  return {
    executeAction: vi.fn(async () => ok({ success: true, events: [] })),
    executeOnCue: vi.fn(async () => ok({ success: true, events: [] })),
  } as any;
}

// -----------------------------------------------------------------------
// WriteDataOperation
// -----------------------------------------------------------------------

describe('WriteDataOperation — expectedStateVersion guard', () => {
  it('returns STALE_CONTEXT when expectedStateVersion does not match current generation', async () => {
    const repo = makeRepo(3); // generation is 3
    expect(repo.get('pc1')!.generation).toBe(3);

    const op = new WriteDataOperation(makeDataServiceStub(), repo);
    const result = await op.execute({
      pageContextId: 'pc1',
      fields: { Name: 'Contoso' },
      expectedStateVersion: 1, // stale: actual is 3
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_CONTEXT');
      expect(result.error.message).toContain('expectedStateVersion=1');
      expect(result.error.message).toContain('actual=3');
    }
  });

  it('does not call writeFields when rejected for staleness', async () => {
    const repo = makeRepo(3);
    const dataService = makeDataServiceStub();
    const op = new WriteDataOperation(dataService, repo);

    await op.execute({
      pageContextId: 'pc1',
      fields: { Name: 'Contoso' },
      expectedStateVersion: 0, // stale
    });

    expect(dataService.writeFields).not.toHaveBeenCalled();
  });

  it('proceeds normally when expectedStateVersion matches current generation', async () => {
    const repo = makeRepo(3);
    const dataService = makeDataServiceStub();
    const op = new WriteDataOperation(dataService, repo);

    const result = await op.execute({
      pageContextId: 'pc1',
      fields: { Name: 'Contoso' },
      expectedStateVersion: 3, // correct
    });

    expect(result.ok).toBe(true);
    expect(dataService.writeFields).toHaveBeenCalledOnce();
  });

  it('proceeds normally when expectedStateVersion is omitted (opt-in only)', async () => {
    const repo = makeRepo(3);
    const dataService = makeDataServiceStub();
    const op = new WriteDataOperation(dataService, repo);

    const result = await op.execute({
      pageContextId: 'pc1',
      fields: { Name: 'Contoso' },
      // no expectedStateVersion
    });

    expect(result.ok).toBe(true);
    expect(dataService.writeFields).toHaveBeenCalledOnce();
  });
});

// -----------------------------------------------------------------------
// ExecuteActionOperation
// -----------------------------------------------------------------------

describe('ExecuteActionOperation — expectedStateVersion guard', () => {
  it('returns STALE_CONTEXT when expectedStateVersion does not match current generation', async () => {
    const repo = makeRepo(5); // generation is 5
    expect(repo.get('pc1')!.generation).toBe(5);

    const op = new ExecuteActionOperation(makeActionServiceStub(), repo);
    const result = await op.execute({
      pageContextId: 'pc1',
      action: 'Post',
      expectedStateVersion: 2, // stale: actual is 5
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_CONTEXT');
      expect(result.error.message).toContain('expectedStateVersion=2');
      expect(result.error.message).toContain('actual=5');
    }
  });

  it('does not call executeAction when rejected for staleness', async () => {
    const repo = makeRepo(5);
    const actionService = makeActionServiceStub();
    const op = new ExecuteActionOperation(actionService, repo);

    await op.execute({
      pageContextId: 'pc1',
      action: 'Post',
      expectedStateVersion: 1, // stale
    });

    expect(actionService.executeAction).not.toHaveBeenCalled();
  });

  it('proceeds normally when expectedStateVersion matches current generation', async () => {
    const repo = makeRepo(5);
    const actionService = makeActionServiceStub();
    const op = new ExecuteActionOperation(actionService, repo);

    const result = await op.execute({
      pageContextId: 'pc1',
      action: 'Refresh',
      expectedStateVersion: 5, // correct
    });

    expect(result.ok).toBe(true);
    expect(actionService.executeAction).toHaveBeenCalledOnce();
  });

  it('proceeds normally when expectedStateVersion is omitted (opt-in only)', async () => {
    const repo = makeRepo(5);
    const actionService = makeActionServiceStub();
    const op = new ExecuteActionOperation(actionService, repo);

    const result = await op.execute({
      pageContextId: 'pc1',
      action: 'Refresh',
      // no expectedStateVersion
    });

    expect(result.ok).toBe(true);
    expect(actionService.executeAction).toHaveBeenCalledOnce();
  });
});
