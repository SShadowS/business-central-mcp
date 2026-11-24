// Paging and state visibility on bc_read_data (recorded flow 2026-11-24): totalRowCount was
// null in every payload (BC never sends it: LogicalControlObserver.GetChangedPropertyValue has
// no case for it), and a read after clearFilters was still sorted from an earlier call with
// nothing in the payload saying so.
import { describe, it, expect, vi } from 'vitest';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, RepeaterRow } from '../../src/protocol/types.js';

const rowsOf = (n: number): RepeaterRow[] => Array.from({ length: n }, (_, i) => ({ bookmark: `B${i}`, cells: { c1: { stringValue: String(10000 + i) } } }));

function listRepo(loaded: number): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create('pc:list', 'L');
  repo.applyToPage('pc:list', [{
    type: 'FormCreated', formId: 'L', isReload: false,
    controlTree: { t: 'lf', ServerId: 'L', PageType: 1, Caption: 'Customers', Children: [
      { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } }] },
    ] },
  } as BCEvent]);
  repo.seedRepeaterRows('pc:list', 'L', 'server:c[0]', rowsOf(loaded));
  return repo;
}

/** A data service whose scroll adds `perScroll` rows until `total` are loaded. */
function dataService(repo: PageContextRepository, total: number, perScroll = 2) {
  let loaded = repo.get('pc:list')!.forms.get('L')!.rows.get('server:c[0]')!.length;
  return {
    readRows: vi.fn(() => ok(rowsOf(loaded))),
    getTabs: vi.fn(() => ok(null)),
    scrollRepeater: vi.fn(async () => {
      loaded = Math.min(total, loaded + perScroll);
      repo.seedRepeaterRows('pc:list', 'L', 'server:c[0]', rowsOf(loaded));
      return ok(rowsOf(loaded));
    }),
  } as never;
}

const filters = (active: Array<{ column: string; value: string }> = []) => ({
  applyFilters: vi.fn(async () => ok(undefined)),
  clearFilters: vi.fn(async () => ok(undefined)),
  activeFilters: vi.fn(() => active),
}) as never;
const sorts = (current: { column: string; direction: 'asc' | 'desc' } | null = null) => ({
  applySort: vi.fn(async () => ok(undefined)),
  currentSort: vi.fn(() => current),
}) as never;

describe('bc_read_data paging', () => {
  it('a range with more rows behind it says hasMore: true', async () => {
    const repo = listRepo(3);
    const r = await new ReadDataOperation(dataService(repo, 10), filters(), sorts(), repo).execute({ pageContextId: 'pc:list', range: { offset: 0, limit: 3 } });
    expect(r.ok && r.value.section.rows!.map(x => x.bookmark)).toEqual(['B0', 'B1', 'B2']);
    expect(r.ok && r.value.section.hasMore).toBe(true);
  });

  it('a range past the end returns no rows, hasMore: false, and stops scrolling', async () => {
    const repo = listRepo(4);
    const ds = dataService(repo, 5);
    const r = await new ReadDataOperation(ds, filters(), sorts(), repo).execute({ pageContextId: 'pc:list', range: { offset: 20, limit: 5 } });
    expect(r.ok && r.value.section.rows).toEqual([]);
    expect(r.ok && r.value.section.hasMore).toBe(false);
    expect((ds as { scrollRepeater: { mock: { calls: unknown[] } } }).scrollRepeater.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('no section carries totalRowCount', async () => {
    const repo = listRepo(2);
    const r = await new ReadDataOperation(dataService(repo, 2), filters(), sorts(), repo).execute({ pageContextId: 'pc:list' });
    expect(r.ok && r.value.section).not.toHaveProperty('totalRowCount');
  });
});

// Recorded flow 2026-11-24: every header read resent the page's actions (87 on a row select,
// 157 on the Role Center), each with an always-true "enabled".
describe('bc_read_data actions', () => {
  function cardRepo() {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'C');
    repo.applyToPage('pc:card', [{
      type: 'FormCreated', formId: 'C', isReload: false,
      controlTree: { t: 'lf', ServerId: 'C', PageType: 0, Caption: 'Card', Children: [
        { t: 'sc', Caption: 'Name', Editable: true, Visible: true },
        { t: 'ac', Caption: 'Statistics', Enabled: true, Visible: true, SystemAction: 0 },
      ] },
    } as BCEvent]);
    return repo;
  }
  const op = (repo: PageContextRepository) => new ReadDataOperation({ readRows: vi.fn(), getTabs: vi.fn(() => ok(null)) } as never, filters(), sorts(), repo);

  it('are left out unless includeActions is true', async () => {
    const r = await op(cardRepo()).execute({ pageContextId: 'pc:card' });
    expect(r.ok && r.value.section).not.toHaveProperty('actions');
  });

  it('includeActions returns them, without an enabled flag (only enabled actions are listed)', async () => {
    const r = await op(cardRepo()).execute({ pageContextId: 'pc:card', includeActions: true });
    expect(r.ok && r.value.section.actions).toEqual([{ name: 'Statistics' }]);
  });
});

describe('bc_read_data state echo', () => {
  it('a list section echoes the active filters and sort', async () => {
    const repo = listRepo(2);
    const op = new ReadDataOperation(dataService(repo, 2), filters([{ column: 'No.', value: '10000..40000' }]), sorts({ column: 'Name', direction: 'desc' }), repo);
    const r = await op.execute({ pageContextId: 'pc:list', clearFilters: true });
    expect(r.ok && r.value.section).toMatchObject({ filters: [{ column: 'No.', value: '10000..40000' }], sort: { column: 'Name', direction: 'desc' } });
  });

  it('an unfiltered, unsorted list says so', async () => {
    const repo = listRepo(2);
    const r = await new ReadDataOperation(dataService(repo, 2), filters(), sorts(), repo).execute({ pageContextId: 'pc:list' });
    expect(r.ok && r.value.section).toMatchObject({ filters: [], sort: null });
  });
});
