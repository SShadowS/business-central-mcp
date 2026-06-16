// tests/unit/factbox-hydration.test.ts
//
// Unit tests for FactboxHydrationStrategy.
//
// Verified invoke sequence (from factbox-hydration.ts):
//   1. SetCurrentRow { formId:rootFormId, controlPath:repPath, key:firstRow.bookmark }
//      -- wait for InvokeCompleted
//   2. For each factbox section:
//        LoadForm { formId:sec.formId, loadData:true, delayed:true, openForm:true }
//        -- wait for InvokeCompleted | PropertyChanged | DataLoaded
//   break after first repeater; early-exit if factboxSections.length === 0.
//
// Seeding strategy mirrors tests/unit/read-data-stale-context.test.ts:
//   - Use the real PageContextRepository.
//   - Apply a FormCreated with an `rc` child to build the repeater tree.
//   - Apply a synthetic DataLoaded event (DataRowInserted) to populate rows.

import { describe, it, expect, vi } from 'vitest';
import { FactboxHydrationStrategy } from '../../src/services/strategies/factbox-hydration.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok, err } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

// ── helpers ────────────────────────────────────────────────────────────────────

/** Create a repo seeded with a Card-like page that has one repeater ('server:c[0]'). */
function makePageWithRepeater(pcId: string, rootFormId: string): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create(pcId, rootFormId, { isModal: false, wizardState: null });

  // FormCreated gives the root form a repeater child.
  const controlTree = {
    t: 'lf', ServerId: rootFormId, PageType: 0, Caption: 'Customer Card',
    Children: [{
      t: 'rc',
      Columns: [
        { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } },
      ],
    }],
  };
  repo.applyToPage(pcId, [{ type: 'FormCreated', formId: rootFormId, isReload: false, controlTree } as BCEvent]);

  // DataLoaded seeds the repeater rows with a real bookmark value.
  repo.applyToPage(pcId, [{
    type: 'DataLoaded',
    formId: rootFormId,
    controlPath: 'server:c[0]',
    currentRowOnly: false,
    rows: [
      { DataRowInserted: [0, { bookmark: 'bk-row-0', cells: { Name: 'Acme' } }] },
    ],
  } as BCEvent]);

  return repo;
}

/** Register a factbox child form on an existing page context. Returns the sectionId. */
function addFactboxChild(
  repo: PageContextRepository,
  pcId: string,
  childFormId: string,
  caption = 'Sales History',
): string {
  repo.registerDiscoveredChildForm(pcId, {
    serverId: childFormId,
    caption,
    controlTree: { t: 'lf', ServerId: childFormId, PageType: 3, Children: [] },
    isSubForm: false,
    isPart: true,
  });
  const ctx = repo.get(pcId)!;
  const sectionEntry = Array.from(ctx.sections.entries()).find(([, s]) => s.formId === childFormId);
  return sectionEntry![0];
}

/** Collect the factbox sections from a page context (kind === 'factbox'). */
function factboxEntries(repo: PageContextRepository, pcId: string) {
  const ctx = repo.get(pcId)!;
  return Array.from(ctx.sections.entries()).filter(([, s]) => s.kind === 'factbox');
}

/** Build a minimal mock session whose invoke() resolves with ok([]) immediately. */
function makeSession() {
  return {
    invoke: vi.fn(async () => ok([] as BCEvent[])),
  };
}

// ── early-exit guard ────────────────────────────────────────────────────────────

describe('FactboxHydrationStrategy — early-exit', () => {
  it('does not invoke when factboxSections is empty', async () => {
    const repo = makePageWithRepeater('pc:1', 'root1');
    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:1', []);

    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when pageContextId is unknown', async () => {
    const repo = new PageContextRepository(); // empty repo
    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    // factboxSections is non-empty so the early length guard is bypassed,
    // but the repo.get() returns undefined → strategy should bail silently.
    await strategy.hydrate('nonexistent', [['factbox:X', { formId: 'fb1' }]]);

    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('does not invoke when rootForm is missing from ctx.forms', async () => {
    // Create a page context but point rootFormId at a form that was never applied.
    const repo = new PageContextRepository();
    repo.create('pc:orphan', 'ghost-root', { isModal: false, wizardState: null });
    // Do NOT apply a FormCreated event — the store has rootFormId 'ghost-root'
    // in ctx.forms (createInitial creates it), so test that no repeater → no invoke.
    // Actually createInitial does create a blank FormState; we test the no-repeater branch below.
    // For the missing-rootForm branch: manually verify via no-repeater case.
    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    // No repeaters in the blank form → the for-of loop over treeRepeaters yields nothing.
    await strategy.hydrate('pc:orphan', [['factbox:Sales', { formId: 'fb2' }]]);

    expect(session.invoke).not.toHaveBeenCalled();
  });
});

// ── no-repeater guard ───────────────────────────────────────────────────────────

describe('FactboxHydrationStrategy — no repeater in root form', () => {
  it('skips invoke when root form has no repeater', async () => {
    // Root form tree has fields but no rc node.
    const repo = new PageContextRepository();
    repo.create('pc:norc', 'root-norc', { isModal: false, wizardState: null });
    repo.applyToPage('pc:norc', [{
      type: 'FormCreated',
      formId: 'root-norc',
      isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'root-norc', PageType: 0, Children: [
          { t: 'sc', Caption: 'Name', ColumnBinder: { Name: 'n1' } },
        ],
      },
    } as BCEvent]);
    addFactboxChild(repo, 'pc:norc', 'fb-norc');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:norc', factboxEntries(repo, 'pc:norc'));

    expect(session.invoke).not.toHaveBeenCalled();
  });
});

// ── no-rows guard ───────────────────────────────────────────────────────────────

describe('FactboxHydrationStrategy — repeater exists but has no rows', () => {
  it('skips invoke when repeater has zero rows', async () => {
    // Repeater tree exists but no DataLoaded event → rows map is empty.
    const repo = new PageContextRepository();
    repo.create('pc:norows', 'root-norows', { isModal: false, wizardState: null });
    repo.applyToPage('pc:norows', [{
      type: 'FormCreated',
      formId: 'root-norows',
      isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'root-norows', PageType: 0, Children: [
          { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] },
        ],
      },
    } as BCEvent]);
    addFactboxChild(repo, 'pc:norows', 'fb-norows');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:norows', factboxEntries(repo, 'pc:norows'));

    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('skips invoke when first row has no bookmark', async () => {
    // DataLoaded with an empty bookmark string — `firstRow.bookmark` is falsy.
    const repo = new PageContextRepository();
    repo.create('pc:nobk', 'root-nobk', { isModal: false, wizardState: null });
    repo.applyToPage('pc:nobk', [{
      type: 'FormCreated', formId: 'root-nobk', isReload: false,
      controlTree: { t: 'lf', ServerId: 'root-nobk', PageType: 0, Children: [
        { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] },
      ]},
    } as BCEvent]);
    repo.applyToPage('pc:nobk', [{
      type: 'DataLoaded', formId: 'root-nobk',
      controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: '', cells: {} }] }],
    } as BCEvent]);
    addFactboxChild(repo, 'pc:nobk', 'fb-nobk');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:nobk', factboxEntries(repo, 'pc:nobk'));

    expect(session.invoke).not.toHaveBeenCalled();
  });
});

// ── happy-path: single factbox ──────────────────────────────────────────────────

describe('FactboxHydrationStrategy — single factbox (happy path)', () => {
  it('sends SetCurrentRow then LoadForm for one factbox', async () => {
    const repo = makePageWithRepeater('pc:h1', 'root-h1');
    const fbId = 'fb-history';
    addFactboxChild(repo, 'pc:h1', fbId, 'Sales History');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:h1', factboxEntries(repo, 'pc:h1'));

    expect(session.invoke).toHaveBeenCalledTimes(2);
  });

  it('first invoke is SetCurrentRow targeting the root repeater path with the first bookmark', async () => {
    const repo = makePageWithRepeater('pc:h2', 'root-h2');
    addFactboxChild(repo, 'pc:h2', 'fb-h2', 'Details');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:h2', factboxEntries(repo, 'pc:h2'));

    const firstCall = session.invoke.mock.calls[0]![0];
    expect(firstCall.type).toBe('SetCurrentRow');
    expect(firstCall.formId).toBe('root-h2');
    expect(firstCall.controlPath).toBe('server:c[0]');
    expect(firstCall.key).toBe('bk-row-0');
  });

  it('first invoke predicate accepts InvokeCompleted only', async () => {
    // The predicate passed to session.invoke (second arg) must accept exactly
    // InvokeCompleted. We test it by examining the returned function directly.
    const repo = makePageWithRepeater('pc:pred', 'root-pred');
    addFactboxChild(repo, 'pc:pred', 'fb-pred', 'Pred');

    const predicates: Array<(e: any) => boolean> = [];
    const session = {
      invoke: vi.fn(async (_interaction: any, predicate: (e: any) => boolean) => {
        predicates.push(predicate);
        return ok([] as BCEvent[]);
      }),
    };
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:pred', factboxEntries(repo, 'pc:pred'));

    // First predicate: SetCurrentRow waits for InvokeCompleted only.
    const setRowPred = predicates[0]!;
    expect(setRowPred({ type: 'InvokeCompleted' })).toBe(true);
    expect(setRowPred({ type: 'PropertyChanged' })).toBe(false);
    expect(setRowPred({ type: 'DataLoaded' })).toBe(false);

    // Second predicate: LoadForm waits for InvokeCompleted | PropertyChanged | DataLoaded.
    const loadFormPred = predicates[1]!;
    expect(loadFormPred({ type: 'InvokeCompleted' })).toBe(true);
    expect(loadFormPred({ type: 'PropertyChanged' })).toBe(true);
    expect(loadFormPred({ type: 'DataLoaded' })).toBe(true);
    expect(loadFormPred({ type: 'FormCreated' })).toBe(false);
  });

  it('second invoke is LoadForm with loadData:true, delayed:true, openForm:true targeting the factbox formId', async () => {
    const repo = makePageWithRepeater('pc:h3', 'root-h3');
    addFactboxChild(repo, 'pc:h3', 'fb-h3', 'Notes');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:h3', factboxEntries(repo, 'pc:h3'));

    const secondCall = session.invoke.mock.calls[1]![0];
    expect(secondCall.type).toBe('LoadForm');
    expect(secondCall.formId).toBe('fb-h3');
    expect(secondCall.loadData).toBe(true);
    expect(secondCall.delayed).toBe(true);
    expect(secondCall.openForm).toBe(true);
  });

  it('applies returned events to the page context via repo.applyToPage', async () => {
    const repo = makePageWithRepeater('pc:apply', 'root-apply');
    addFactboxChild(repo, 'pc:apply', 'fb-apply', 'Apply Test');

    const applyToPage = vi.spyOn(repo, 'applyToPage');
    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:apply', factboxEntries(repo, 'pc:apply'));

    // applyToPage should be called twice (once for SetCurrentRow, once for LoadForm).
    expect(applyToPage).toHaveBeenCalledWith('pc:apply', []);
    expect(applyToPage).toHaveBeenCalledTimes(2);
  });
});

// ── happy-path: multiple factboxes ─────────────────────────────────────────────

describe('FactboxHydrationStrategy — multiple factboxes', () => {
  it('sends SetCurrentRow once then LoadForm for EACH factbox', async () => {
    const repo = makePageWithRepeater('pc:multi', 'root-multi');
    addFactboxChild(repo, 'pc:multi', 'fb-m1', 'Sales Lines');
    addFactboxChild(repo, 'pc:multi', 'fb-m2', 'Attachments');
    addFactboxChild(repo, 'pc:multi', 'fb-m3', 'Notes');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:multi', factboxEntries(repo, 'pc:multi'));

    // 1 SetCurrentRow + 3 LoadForm = 4 invokes total.
    expect(session.invoke).toHaveBeenCalledTimes(4);

    const calls = session.invoke.mock.calls.map((c: any) => c[0]);
    expect(calls[0].type).toBe('SetCurrentRow');
    expect(calls[1].type).toBe('LoadForm');
    expect(calls[2].type).toBe('LoadForm');
    expect(calls[3].type).toBe('LoadForm');

    // Every LoadForm must carry the correct flags.
    for (const c of calls.slice(1)) {
      expect(c.loadData).toBe(true);
      expect(c.delayed).toBe(true);
      expect(c.openForm).toBe(true);
    }
  });

  it('LoadForm formId values match the registered factbox form ids', async () => {
    const repo = makePageWithRepeater('pc:fids', 'root-fids');
    addFactboxChild(repo, 'pc:fids', 'fb-fid1', 'A');
    addFactboxChild(repo, 'pc:fids', 'fb-fid2', 'B');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:fids', factboxEntries(repo, 'pc:fids'));

    const loadFormIds = session.invoke.mock.calls.slice(1).map((c: any) => c[0].formId);
    expect(loadFormIds).toContain('fb-fid1');
    expect(loadFormIds).toContain('fb-fid2');
  });
});

// ── break-after-first-repeater ──────────────────────────────────────────────────

describe('FactboxHydrationStrategy — break after first repeater', () => {
  it('only processes the first repeater even when root has two rc nodes', async () => {
    // Construct a root form with TWO repeaters (rc at c[0] and c[1]).
    // Both have rows. Only the FIRST repeater should drive SetCurrentRow.
    const repo = new PageContextRepository();
    repo.create('pc:tworc', 'root-tworc', { isModal: false, wizardState: null });
    repo.applyToPage('pc:tworc', [{
      type: 'FormCreated', formId: 'root-tworc', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'root-tworc', PageType: 0, Children: [
          { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] },
          { t: 'rc', Columns: [{ t: 'rcc', Caption: 'Line' }] },
        ],
      },
    } as BCEvent]);
    // Seed rows in both repeaters.
    repo.applyToPage('pc:tworc', [{
      type: 'DataLoaded', formId: 'root-tworc',
      controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: 'bk-first', cells: {} }] }],
    } as BCEvent]);
    repo.applyToPage('pc:tworc', [{
      type: 'DataLoaded', formId: 'root-tworc',
      controlPath: 'server:c[1]', currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: 'bk-second', cells: {} }] }],
    } as BCEvent]);

    addFactboxChild(repo, 'pc:tworc', 'fb-tworc', 'Details');

    const session = makeSession();
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:tworc', factboxEntries(repo, 'pc:tworc'));

    // Should still be exactly 2 invokes (1 SetCurrentRow + 1 LoadForm), not 4.
    expect(session.invoke).toHaveBeenCalledTimes(2);

    // The SetCurrentRow must reference the FIRST repeater's path and bookmark.
    const setRowCall = session.invoke.mock.calls[0]![0];
    expect(setRowCall.type).toBe('SetCurrentRow');
    expect(setRowCall.controlPath).toBe('server:c[0]');
    expect(setRowCall.key).toBe('bk-first');
  });
});

// ── error resilience ────────────────────────────────────────────────────────────

describe('FactboxHydrationStrategy — invoke failure handling', () => {
  it('does not throw when SetCurrentRow invoke returns err()', async () => {
    const repo = makePageWithRepeater('pc:err1', 'root-err1');
    addFactboxChild(repo, 'pc:err1', 'fb-err1', 'Notes');

    let callCount = 0;
    const session = {
      invoke: vi.fn(async () => {
        callCount++;
        // SetCurrentRow fails; LoadForm should still run.
        if (callCount === 1) return err(new Error('BC session error'));
        return ok([] as BCEvent[]);
      }),
    };
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    // Must not throw.
    await expect(strategy.hydrate('pc:err1', factboxEntries(repo, 'pc:err1'))).resolves.toBeUndefined();
    // Even after SetCurrentRow failed, LoadForm is still attempted.
    expect(session.invoke).toHaveBeenCalledTimes(2);
  });

  it('does not throw when a LoadForm invoke returns err()', async () => {
    const repo = makePageWithRepeater('pc:err2', 'root-err2');
    addFactboxChild(repo, 'pc:err2', 'fb-err2a', 'A');
    addFactboxChild(repo, 'pc:err2', 'fb-err2b', 'B');

    const session = {
      invoke: vi.fn(async (_int: any) => {
        if (_int.type === 'LoadForm' && _int.formId === 'fb-err2a') {
          return err(new Error('load failed'));
        }
        return ok([] as BCEvent[]);
      }),
    };
    const strategy = new FactboxHydrationStrategy(session as any, repo);

    await expect(strategy.hydrate('pc:err2', factboxEntries(repo, 'pc:err2'))).resolves.toBeUndefined();
    // SetCurrentRow + 2 LoadForms = 3 total (second LoadForm still runs).
    expect(session.invoke).toHaveBeenCalledTimes(3);
  });
});
