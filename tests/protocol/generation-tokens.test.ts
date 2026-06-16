// tests/protocol/generation-tokens.test.ts
//
// Verify that PageContextRepository's generation counter:
//   - starts at 0 on creation
//   - bumps by exactly 1 per mutating applyEvents/applyToPage batch
//   - does NOT bump for no-op batches (events that leave state unchanged)

import { describe, it, expect } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

// Minimal lf control tree with one editable sc field.
function makeTree(formId: string, caption = 'Test') {
  return {
    t: 'lf',
    ServerId: formId,
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
  };
}

describe('PageContext generation tokens', () => {
  it('generation starts at 0 on create()', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');
    expect(repo.get('pc1')!.generation).toBe(0);
  });

  it('generation bumps once on a mutating applyEvents batch', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    repo.applyEvents([
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') },
    ]);

    expect(repo.get('pc1')!.generation).toBe(1);
  });

  it('generation does NOT bump on a no-op applyEvents batch (unmatched formId)', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    // Apply once to populate
    repo.applyEvents([
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') },
    ]);
    expect(repo.get('pc1')!.generation).toBe(1);

    // FormCreated for a formId not indexed in the store -> Unmatched -> no-op
    const noop: BCEvent[] = [
      { type: 'FormCreated', formId: 'UNKNOWN', isReload: false, controlTree: makeTree('UNKNOWN') },
    ];
    repo.applyEvents(noop);

    // Still 1 -- no-op batch must not bump
    expect(repo.get('pc1')!.generation).toBe(1);
  });

  it('generation bumps only once per mutating batch, even with multiple mutating events', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    repo.applyEvents([
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') },
    ]);
    const genAfterFirst = repo.get('pc1')!.generation;

    // Two PropertyChanged events in one batch — wire field name is 'changes'
    repo.applyEvents([
      {
        type: 'PropertyChanged',
        formId: 'F1',
        controlPath: 'server:c[0]',
        changes: { StringValue: 'Contoso' },
      } as BCEvent,
      {
        type: 'PropertyChanged',
        formId: 'F1',
        controlPath: 'server:c[0]',
        changes: { StringValue: 'Contoso Ltd' },
      } as BCEvent,
    ]);

    // Must bump exactly once for the whole batch, not once per event
    expect(repo.get('pc1')!.generation).toBe(genAfterFirst + 1);
  });

  it('applyToPage bumps generation on mutation', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    repo.applyToPage('pc1', [
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') },
    ]);

    expect(repo.get('pc1')!.generation).toBe(1);
  });

  it('applyToPage does NOT bump for a FormClosed on an unreferenced formId', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    repo.applyToPage('pc1', [
      { type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') },
    ]);
    expect(repo.get('pc1')!.generation).toBe(1);

    // FormClosed on a formId that has no section referencing it is a structural no-op:
    // markFormClosed changes no sections and returns false -> no bump
    repo.applyToPage('pc1', [{ type: 'FormClosed', formId: 'GHOST_FORM' }]);

    expect(repo.get('pc1')!.generation).toBe(1);
  });

  it('multiple separate batches each bump independently', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');

    repo.applyEvents([{ type: 'FormCreated', formId: 'F1', isReload: false, controlTree: makeTree('F1') }]);
    expect(repo.get('pc1')!.generation).toBe(1);

    repo.applyEvents([
      {
        type: 'PropertyChanged',
        formId: 'F1',
        controlPath: 'server:c[0]',
        changes: { StringValue: 'A' },
      } as BCEvent,
    ]);
    expect(repo.get('pc1')!.generation).toBe(2);

    repo.applyEvents([
      {
        type: 'PropertyChanged',
        formId: 'F1',
        controlPath: 'server:c[0]',
        changes: { StringValue: 'B' },
      } as BCEvent,
    ]);
    expect(repo.get('pc1')!.generation).toBe(3);
  });
});
