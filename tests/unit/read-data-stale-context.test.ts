// tests/unit/read-data-stale-context.test.ts
//
// Regression guard: ReadDataOperation must read post-mutation page context
// when applyFilters / scrollRepeater run between fast-fail validation and
// buildSection. PageContextRepository swaps the PageContext reference on
// every event-induced update (immutable updates with structural sharing),
// so capturing ctx early yields stale projection.

import { describe, it, expect } from 'vitest';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, RepeaterRow } from '../../src/protocol/types.js';

function rowsForFormId(formId: string, count: number): RepeaterRow[] {
  return Array.from({ length: count }, (_, i) => ({
    bookmark: `${formId}-bk${i}`,
    cells: { Name: `Item ${i}`, No: `${1000 + i}` },
  }));
}

function makeListPageContext(repo: PageContextRepository, pcId: string, formId: string) {
  repo.create(pcId, formId, { isModal: false, wizardState: null });
  // Apply a FormCreated event with a list-shape root (one repeater).
  const controlTree = {
    t: 'lf', ServerId: formId, PageType: 1, Caption: 'Customer List',
    Children: [{
      t: 'rc',
      Columns: [
        { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '18.1' } },
        { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2', Path: '18.2' } },
      ],
    }],
  };
  const events: BCEvent[] = [{
    type: 'FormCreated', formId, isReload: false, controlTree,
  }];
  repo.applyToPage(pcId, events);
}

function injectRows(repo: PageContextRepository, pcId: string, formId: string, count: number) {
  const rows = rowsForFormId(formId, count);
  // DataRowInserted events reach the form via applyToPage's DataLoaded path.
  // For a focused unit test, skip the wire-format encoding and replace the
  // form's rows map directly via a synthetic event.
  const events: BCEvent[] = [{
    type: 'DataLoaded',
    formId,
    controlPath: 'server:c[0]',
    currentRowOnly: false,
    rows: rows.map((r, i) => ({
      DataRowInserted: [i, { bookmark: r.bookmark, cells: r.cells }],
    })),
  }];
  repo.applyToPage(pcId, events);
}

describe('ReadDataOperation post-mutation context', () => {
  it('range with offset+limit beyond initial viewport reads scrolled rows, not stale', async () => {
    const repo = new PageContextRepository();
    const pcId = 'pc:list:1';
    const formId = 'f1';

    makeListPageContext(repo, pcId, formId);
    injectRows(repo, pcId, formId, 5); // initial viewport: 5 rows

    let scrollCalls = 0;
    const dataService = {
      readRows: () => ok(rowsForFormId(formId, 5)),
      getRepeaterTotalRowCount: () => 30,
      getTabs: () => ok([]),
      scrollRepeater: async () => {
        scrollCalls += 1;
        // Simulate BC scrolling by injecting more rows into the repo.
        // Each call adds 10 more rows on top of what's there.
        const newCount = 5 + scrollCalls * 10;
        injectRows(repo, pcId, formId, newCount);
        return ok(rowsForFormId(formId, newCount));
      },
    } as unknown as Parameters<typeof ReadDataOperation>[0];

    const filterService = {
      applyFilters: async () => ok([]),
    } as unknown as Parameters<typeof ReadDataOperation>[1];

    const op = new ReadDataOperation(
      dataService as never,
      filterService as never,
      { applySort: async () => ok([]) } as never,
      repo,
    );

    const result = await op.execute({
      pageContextId: pcId,
      range: { offset: 20, limit: 5 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value.section.rows ?? [];
    expect(rows.length).toBe(5);
    // Rows 20-24 must be present (scroll loaded them); had we read stale ctx,
    // the slice would be empty because the original viewport had only 5 rows.
    expect(rows[0]!.bookmark).toBe(`${formId}-bk20`);
    expect(rows[4]!.bookmark).toBe(`${formId}-bk24`);
    expect(scrollCalls).toBeGreaterThan(0);
  });

  it('returns "Page context not found" for unknown pageContextId without invoking services', async () => {
    const repo = new PageContextRepository();

    let serviceCalls = 0;
    const dataService = {
      readRows: () => { serviceCalls += 1; return ok([]); },
      getRepeaterTotalRowCount: () => { serviceCalls += 1; return null; },
      getTabs: () => { serviceCalls += 1; return ok([]); },
      scrollRepeater: async () => { serviceCalls += 1; return ok([]); },
    } as unknown as Parameters<typeof ReadDataOperation>[0];

    const filterService = {
      applyFilters: async () => { serviceCalls += 1; return ok([]); },
    } as unknown as Parameters<typeof ReadDataOperation>[1];

    const op = new ReadDataOperation(
      dataService as never,
      filterService as never,
      { applySort: async () => ok([]) } as never,
      repo,
    );

    const result = await op.execute({ pageContextId: 'pc:does-not-exist' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Page context not found');
    }
    expect(serviceCalls).toBe(0);
  });
});
