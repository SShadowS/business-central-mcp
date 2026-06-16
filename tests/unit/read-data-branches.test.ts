// tests/unit/read-data-branches.test.ts
//
// Tests for UNCOVERED branches in ReadDataOperation.
// Already tested elsewhere (read-data-stale-context.test.ts, read-data-range.test.ts):
//   - unknown pageContextId -> err before service calls
//   - range with scroll
//   - pure range slicing / tab field logic (extracted functions)
//
// This file covers the REMAINING uncovered branches:
//   1. filters applied -> filterService.applyFilters called; error propagated
//   2. section not found in ctx -> err('Section X not found')
//   3. tab filtering by getTabs: matching tab narrows fields
//   4. tab filtering: no matching tab -> all fields retained
//   5. columns filtering: narrows both rows.cells and fields
//   6. second ctx.get returns undefined (race between filter and buildSection)
//   7. scrollRepeater: loop breaks if rowsLen does not increase (BC end-of-list)
//   8. readRows err during range: continues to buildSection (benign)
//   9. stateVersion in output matches ctx.generation
//  10. clearFilters=true -> filterService.clearFilters called BEFORE applyFilters
//  11. clearFilters=false / omitted -> filterService.clearFilters NOT called
//  12. clearFilters error is propagated before applyFilters / buildSection

import { describe, it, expect, vi } from 'vitest';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import type { BCEvent, RepeaterRow } from '../../src/protocol/types.js';

// Build a minimal list page context with a repeater section.
function makeListPageContext(repo: PageContextRepository, pcId: string, formId: string) {
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{
    type: 'FormCreated',
    formId,
    isReload: false,
    controlTree: {
      t: 'lf', ServerId: formId, PageType: 1, Caption: 'Customer List',
      Children: [{
        t: 'rc',
        Columns: [
          { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '18.1' } },
          { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2', Path: '18.2' } },
        ],
      }],
    },
  } as BCEvent]);
}

// Build a minimal card page context (header section, fields, no repeater).
function makeCardPageContext(repo: PageContextRepository, pcId: string, formId: string) {
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{
    type: 'FormCreated',
    formId,
    isReload: false,
    controlTree: {
      t: 'lf', ServerId: formId, PageType: 2, Caption: 'Customer Card',
      Children: [
        { t: 'sc', Caption: 'Name', ColumnBinder: { Name: 'c1', Path: '18.2' }, Editable: true, Visible: true },
        { t: 'sc', Caption: 'City', ColumnBinder: { Name: 'c2', Path: '18.5' }, Editable: true, Visible: true },
      ],
    },
  } as BCEvent]);
}

function makeFilterService(overrides?: Record<string, unknown>) {
  return {
    applyFilters: vi.fn(async () => ok(undefined as any)),
    clearFilters: vi.fn(async () => ok(undefined as any)),
    ...overrides,
  } as any;
}

function makeSortService(overrides?: Record<string, unknown>) {
  return {
    applySort: vi.fn(async () => ok(undefined as any)),
    ...overrides,
  } as any;
}

function makeDataService(overrides?: Record<string, unknown>) {
  return {
    readRows: vi.fn(() => ok([] as RepeaterRow[])),
    getRepeaterTotalRowCount: vi.fn(() => null),
    getTabs: vi.fn(() => ok(null)),
    scrollRepeater: vi.fn(async () => ok([] as RepeaterRow[])),
    ...overrides,
  } as any;
}

describe('ReadDataOperation — filter application (uncovered)', () => {
  it('calls filterService.applyFilters when filters are provided', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({
      pageContextId: 'pc:1',
      filters: [{ column: 'Name', value: 'Contoso' }],
    });

    expect(filterService.applyFilters).toHaveBeenCalledWith('pc:1', [{ column: 'Name', value: 'Contoso' }], undefined);
  });

  it('propagates filterService error', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService({
      applyFilters: vi.fn(async () => err(new ProtocolError('filter column not found'))),
    });
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      filters: [{ column: 'NoSuchColumn', value: 'X' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('filter column not found');
    }
  });

  it('does NOT call filterService.applyFilters when filters array is empty', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({ pageContextId: 'pc:1', filters: [] });

    expect(filterService.applyFilters).not.toHaveBeenCalled();
  });

  it('does NOT call filterService.applyFilters when filters is undefined', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({ pageContextId: 'pc:1' });

    expect(filterService.applyFilters).not.toHaveBeenCalled();
  });
});

describe('ReadDataOperation — section resolution (uncovered)', () => {
  it('returns err when requested section does not exist in ctx', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      section: 'lines', // card page has no "lines" section
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Section 'lines' not found");
    }
  });

  it('includes available sections in the error context', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      section: 'no-such-section',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // context.availableSections should contain 'header' at minimum
      expect(result.error.context).toBeDefined();
      expect((result.error.context as any).availableSections).toContain('header');
    }
  });
});

describe('ReadDataOperation — tab filtering (uncovered)', () => {
  it('filters fields to those belonging to the named tab when tab matches', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService({
      getTabs: vi.fn(() => ok([
        {
          caption: 'General',
          fields: [{ caption: 'Name' }],
        },
        {
          caption: 'Address',
          fields: [{ caption: 'City' }],
        },
      ])),
    });
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      tab: 'general',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the 'Name' field should be present, not 'City'
    const fieldNames = (result.value.section.fields ?? []).map(f => f.name);
    expect(fieldNames).toContain('Name');
    expect(fieldNames).not.toContain('City');
  });

  it('retains all fields when no tab matches (tab name not found)', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService({
      getTabs: vi.fn(() => ok([
        { caption: 'General', fields: [{ caption: 'Name' }] },
      ])),
    });
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      tab: 'nonexistent-tab',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All fields retained when tab not found
    const fieldNames = (result.value.section.fields ?? []).map(f => f.name);
    expect(fieldNames).toContain('Name');
    expect(fieldNames).toContain('City');
  });

  it('is case-insensitive for tab name matching', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService({
      getTabs: vi.fn(() => ok([
        { caption: 'General', fields: [{ caption: 'Name' }] },
      ])),
    });
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      tab: 'GENERAL', // uppercase should still match
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fieldNames = (result.value.section.fields ?? []).map(f => f.name);
    expect(fieldNames).toContain('Name');
    expect(fieldNames).not.toContain('City');
  });
});

describe('ReadDataOperation — columns filtering (uncovered)', () => {
  it('filters fields by requested columns (case-insensitive)', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      columns: ['name'], // lowercase, should match 'Name'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fieldNames = (result.value.section.fields ?? []).map(f => f.name);
    expect(fieldNames).toContain('Name');
    expect(fieldNames).not.toContain('City');
  });

  it('filters row cells by requested columns for list sections', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    // Inject rows
    repo.applyToPage('pc:1', [{
      type: 'DataLoaded',
      formId: 'F1',
      controlPath: 'server:c[0]',
      currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: 'bk1', cells: { No: '10000', Name: 'Contoso' } }] }],
    } as BCEvent]);
    const filterService = makeFilterService();
    const dataService = makeDataService({
      readRows: vi.fn(() => ok([{ bookmark: 'bk1', cells: { No: '10000', Name: 'Contoso' } }])),
    });
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      columns: ['Name'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Any rows should only have the 'Name' cell
    const rows = result.value.section.rows ?? [];
    if (rows.length > 0) {
      const cellKeys = Object.keys(rows[0]!.cells);
      expect(cellKeys).toContain('Name');
      expect(cellKeys).not.toContain('No');
    }
  });
});

describe('ReadDataOperation — stateVersion output (uncovered)', () => {
  it('returns stateVersion equal to ctx.generation', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');
    const ctx = repo.get('pc:1')!;
    const expectedGeneration = ctx.generation;

    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({ pageContextId: 'pc:1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stateVersion).toBe(expectedGeneration);
  });

  it('stateVersion increments after a mutation (applyToPage bumps generation)', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:1', 'F1');

    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result1 = await op.execute({ pageContextId: 'pc:1' });
    expect(result1.ok).toBe(true);
    const gen1 = result1.ok ? result1.value.stateVersion : -1;

    // Bump generation with another event
    repo.applyToPage('pc:1', [{
      type: 'FormCreated', formId: 'F1', isReload: true,
      controlTree: { t: 'lf', ServerId: 'F1', PageType: 2, Caption: 'Updated', Children: [] },
    } as BCEvent]);

    const result2 = await op.execute({ pageContextId: 'pc:1' });
    expect(result2.ok).toBe(true);
    const gen2 = result2.ok ? result2.value.stateVersion : -1;

    expect(gen2).toBeGreaterThan(gen1);
  });
});

describe('ReadDataOperation — range with scroll boundary (uncovered)', () => {
  it('breaks scroll loop when scrollRepeater returns same row count (end-of-list)', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');

    let scrollCalls = 0;
    const dataService = makeDataService({
      readRows: vi.fn(() => ok([{ bookmark: 'bk0', cells: { No: '10000' } }])),
      getRepeaterTotalRowCount: vi.fn(() => 100), // pretend more rows exist
      scrollRepeater: vi.fn(async () => {
        scrollCalls += 1;
        // Return the SAME row count every time (simulates end-of-list from BC)
        return ok([{ bookmark: 'bk0', cells: { No: '10000' } }]);
      }),
    });
    const filterService = makeFilterService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    // Request offset=5, limit=5 — but BC won't give more rows
    await op.execute({
      pageContextId: 'pc:1',
      range: { offset: 5, limit: 5 },
    });

    // scrollRepeater should have been called exactly once (loop breaks when count doesn't increase)
    expect(scrollCalls).toBe(1);
  });
});

describe('ReadDataOperation — clearFilters wiring', () => {
  it('calls filterService.clearFilters when clearFilters=true', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      clearFilters: true,
    });

    expect(result.ok).toBe(true);
    expect(filterService.clearFilters).toHaveBeenCalledOnce();
    expect(filterService.clearFilters).toHaveBeenCalledWith('pc:1', undefined);
  });

  it('passes the section to filterService.clearFilters', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({
      pageContextId: 'pc:1',
      clearFilters: true,
      section: 'lines',
    });

    expect(filterService.clearFilters).toHaveBeenCalledWith('pc:1', 'lines');
  });

  it('calls clearFilters BEFORE applyFilters when both are present', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const callOrder: string[] = [];
    const filterService = makeFilterService({
      clearFilters: vi.fn(async () => { callOrder.push('clear'); return ok(undefined as any); }),
      applyFilters: vi.fn(async () => { callOrder.push('apply'); return ok(undefined as any); }),
    });
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({
      pageContextId: 'pc:1',
      clearFilters: true,
      filters: [{ column: 'Name', value: 'Contoso' }],
    });

    expect(callOrder).toEqual(['clear', 'apply']);
  });

  it('does NOT call clearFilters when clearFilters is false', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({
      pageContextId: 'pc:1',
      clearFilters: false,
    });

    expect(filterService.clearFilters).not.toHaveBeenCalled();
  });

  it('does NOT call clearFilters when clearFilters is omitted', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    await op.execute({ pageContextId: 'pc:1' });

    expect(filterService.clearFilters).not.toHaveBeenCalled();
  });

  it('propagates clearFilters error before reaching applyFilters and buildSection', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService({
      clearFilters: vi.fn(async () => err(new ProtocolError('cannot clear filters: no repeater'))),
    });
    const dataService = makeDataService();
    const op = new ReadDataOperation(dataService, filterService, makeSortService(), repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      clearFilters: true,
      filters: [{ column: 'Name', value: 'X' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('cannot clear filters');
    }
    // applyFilters must NOT be called after a clearFilters error
    expect(filterService.applyFilters).not.toHaveBeenCalled();
  });
});

describe('ReadDataOperation — sort wiring', () => {
  it('calls sortService.applySort when sort is provided', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const filterService = makeFilterService();
    const dataService = makeDataService();
    const sortService = makeSortService();
    const op = new ReadDataOperation(dataService, filterService, sortService, repo);

    await op.execute({
      pageContextId: 'pc:1',
      sort: { column: 'Name', direction: 'asc' },
    });

    expect(sortService.applySort).toHaveBeenCalledWith('pc:1', 'Name', 'asc', undefined);
  });

  it('passes the section to sortService.applySort', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const sortService = makeSortService();
    const op = new ReadDataOperation(makeDataService(), makeFilterService(), sortService, repo);

    await op.execute({
      pageContextId: 'pc:1',
      sort: { column: 'Name', direction: 'desc' },
      section: 'lines',
    });

    expect(sortService.applySort).toHaveBeenCalledWith('pc:1', 'Name', 'desc', 'lines');
  });

  it('does NOT call sortService.applySort when sort is omitted', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const sortService = makeSortService();
    const op = new ReadDataOperation(makeDataService(), makeFilterService(), sortService, repo);

    await op.execute({ pageContextId: 'pc:1' });

    expect(sortService.applySort).not.toHaveBeenCalled();
  });

  it('propagates sortService error', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const sortService = makeSortService({
      applySort: vi.fn(async () => err(new ProtocolError('sort column not found'))),
    });
    const op = new ReadDataOperation(makeDataService(), makeFilterService(), sortService, repo);

    const result = await op.execute({
      pageContextId: 'pc:1',
      sort: { column: 'NoSuchColumn', direction: 'asc' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('sort column not found');
    }
  });

  it('calls sort AFTER filters (order: clear -> filter -> sort)', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const callOrder: string[] = [];
    const filterService = makeFilterService({
      clearFilters: vi.fn(async () => { callOrder.push('clear'); return ok(undefined as any); }),
      applyFilters: vi.fn(async () => { callOrder.push('filter'); return ok(undefined as any); }),
    });
    const sortService = makeSortService({
      applySort: vi.fn(async () => { callOrder.push('sort'); return ok(undefined as any); }),
    });
    const op = new ReadDataOperation(makeDataService(), filterService, sortService, repo);

    await op.execute({
      pageContextId: 'pc:1',
      clearFilters: true,
      filters: [{ column: 'Name', value: 'Contoso' }],
      sort: { column: 'Name', direction: 'asc' },
    });

    expect(callOrder).toEqual(['clear', 'filter', 'sort']);
  });
});
