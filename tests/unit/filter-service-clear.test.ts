// tests/unit/filter-service-clear.test.ts
//
// Unit tests for FilterService.clearFilters.
// Verifies that clearFilters sends a Filter interaction with
// filterOperation === FilterOperation.Reset (3) against the resolved
// filter/repeater control path.
//
// The method already exists at src/services/filter-service.ts:91.
// These tests confirm the interaction shape without hitting BC.

import { describe, it, expect, vi } from 'vitest';
import { FilterService } from '../../src/services/filter-service.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { FilterOperation } from '../../src/protocol/types.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCEvent } from '../../src/protocol/types.js';

// Minimal list page context with a repeater but no filc node.
// clearFilters falls back to repeater.controlPath when filterControlPath returns null.
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
          { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' }, ColumnBinderPath: '18.1' },
          { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2' }, ColumnBinderPath: '18.2' },
        ],
      }],
    },
  } as BCEvent]);
}

// Card page context — has no repeater, so clearFilters must return an error.
function makeCardPageContext(repo: PageContextRepository, pcId: string, formId: string) {
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{
    type: 'FormCreated',
    formId,
    isReload: false,
    controlTree: {
      t: 'lf', ServerId: formId, PageType: 2, Caption: 'Customer Card',
      Children: [
        { t: 'sc', Caption: 'Name', ColumnBinder: { Name: 'c1' }, Editable: true, Visible: true },
      ],
    },
  } as BCEvent]);
}

function makeSession(invokeResult: unknown = ok([] as BCEvent[])) {
  return {
    invoke: vi.fn(async (..._args: unknown[]) => invokeResult),
  };
}

describe('FilterService.clearFilters — interaction shape', () => {
  it('sends a Filter interaction with filterOperation === FilterOperation.Reset (3)', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const session = makeSession();
    const service = new FilterService(session as any, repo, createNullLogger());

    const result = await service.clearFilters('pc:1');

    expect(result.ok).toBe(true);
    expect(session.invoke).toHaveBeenCalledOnce();

    const interaction = session.invoke.mock.calls[0]![0] as any;
    expect(interaction.type).toBe('Filter');
    expect(interaction.filterOperation).toBe(FilterOperation.Reset);
    expect(interaction.filterOperation).toBe(3);
  });

  it('sends the Filter with the correct formId', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'FormABC');
    const session = makeSession();
    const service = new FilterService(session as any, repo, createNullLogger());

    await service.clearFilters('pc:1');

    const interaction = session.invoke.mock.calls[0]![0] as any;
    expect(interaction.formId).toBe('FormABC');
  });

  it('does NOT set filterColumnId or filterValue on the Reset interaction', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const session = makeSession();
    const service = new FilterService(session as any, repo, createNullLogger());

    await service.clearFilters('pc:1');

    const interaction = session.invoke.mock.calls[0]![0] as any;
    // Reset does not need a column or value — only the operation flag
    expect(interaction.filterColumnId).toBeUndefined();
    expect(interaction.filterValue).toBeUndefined();
  });

  it('returns err when pageContextId is unknown', async () => {
    const repo = new PageContextRepository();
    const session = makeSession();
    const service = new FilterService(session as any, repo, createNullLogger());

    const result = await service.clearFilters('nonexistent');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('nonexistent');
    }
    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('returns err for a card page that has no repeater', async () => {
    const repo = new PageContextRepository();
    makeCardPageContext(repo, 'pc:card', 'Fcard');
    const session = makeSession();
    const service = new FilterService(session as any, repo, createNullLogger());

    const result = await service.clearFilters('pc:card');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/repeater/i);
    }
    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('propagates session.invoke error', async () => {
    const repo = new PageContextRepository();
    makeListPageContext(repo, 'pc:1', 'F1');
    const session = makeSession(err(new ProtocolError('network failure')));
    const service = new FilterService(session as any, repo, createNullLogger());

    const result = await service.clearFilters('pc:1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('network failure');
    }
  });
});

// #57: BC keeps a filter that is active when the page closes for the rest of the session and
// applies it to the page's UserFilter on reopen, where Reset does not remove it (live
// cronus291, page 143). clearFilters therefore clears UserFilter and re-executes the filter
// control, so the session stores empty filters too.
describe('FilterService.clearFilters with a filter control (#57)', () => {
  function makeFilteredList(repo: PageContextRepository) {
    repo.create('pc:list', 'L1');
    repo.applyToPage('pc:list', [{
      type: 'FormCreated', formId: 'L1', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'L1', PageType: 1, Caption: 'Posted Sales Invoices',
        Children: [
          { t: 'gc', Children: [] },
          { t: 'gc', Children: [] },
          { t: 'filc', Children: [] },
          { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' }, ColumnBinderPath: '112_Sales Invoice Header.3' }] },
        ],
      },
    } as BCEvent]);
  }

  it('sends Reset, Execute(UserFilter "") on the form, then Execute on the filter control', async () => {
    const repo = new PageContextRepository();
    makeFilteredList(repo);
    const session = makeSession();
    await new FilterService(session as any, repo, createNullLogger()).clearFilters('pc:list');
    expect(session.invoke.mock.calls.map(c => c[0])).toMatchObject([
      { type: 'Filter', formId: 'L1', controlPath: 'server:c[2]', filterOperation: FilterOperation.Reset },
      { type: 'Filter', formId: 'L1', controlPath: 'server:', filterOperation: FilterOperation.Execute, userFilter: '' },
      { type: 'Filter', formId: 'L1', controlPath: 'server:c[2]', filterOperation: FilterOperation.Execute, filterColumnId: '', filterValue: '' },
    ]);
  });

  it('refuses an empty filter value and sends nothing (BC ignores it)', async () => {
    const repo = new PageContextRepository();
    makeFilteredList(repo);
    const session = makeSession();
    const result = await new FilterService(session as any, repo, createNullLogger()).applyFilters('pc:list', [{ column: 'No.', value: '' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('clearFilters');
    expect(session.invoke).not.toHaveBeenCalled();
  });

  // BC 23.3 (live, Customer list 22): AddLine inserts the line but leaves
  // its value control empty and the rows unfiltered; SaveValue on that control filters them.
  const insertedLine = (value: string): BCEvent => ({
    type: 'ControlInserted', formId: 'L1', refFormId: 'L1', controlPath: 'server:c[2]', index: 2,
    control: { t: 'flc', Children: [{ t: 'sec', StringValue: 'No.' }, { t: 'fvc', Caption: 'No.', StringValue: value }] },
  });
  const valueEcho = (value: string): BCEvent => ({
    type: 'PropertyChanged', formId: 'L1', refFormId: 'L1', controlPath: 'server:c[2]/c[2]/c[1]',
    changes: { ResolvedFilterValue: value, UserTypedFilterValue: value, StringValue: value, ObjectValue: value },
  });

  it('writes the value into the new filter line when AddLine leaves it empty (BC 23.3)', async () => {
    const repo = new PageContextRepository();
    makeFilteredList(repo);
    const session = makeSession();
    session.invoke
      .mockResolvedValueOnce(ok([insertedLine('')]))
      .mockResolvedValueOnce(ok([valueEcho('103293')]));
    const result = await new FilterService(session as any, repo, createNullLogger()).applyFilters('pc:list', [{ column: 'No.', value: '103293' }]);
    expect(result.ok).toBe(true);
    expect(session.invoke.mock.calls.map(c => c[0])).toMatchObject([
      { type: 'Filter', formId: 'L1', controlPath: 'server:c[2]', filterOperation: FilterOperation.AddLine, filterValue: '103293' },
      { type: 'SaveValue', formId: 'L1', controlPath: 'server:c[2]/c[2]/c[1]', newValue: '103293' },
    ]);
  });

  it('sends only AddLine when BC set the value (in the insert or a PropertyChanged)', async () => {
    for (const events of [[insertedLine('103293')], [insertedLine(''), valueEcho('103293')]]) {
      const repo = new PageContextRepository();
      makeFilteredList(repo);
      const session = makeSession(ok(events));
      const result = await new FilterService(session as any, repo, createNullLogger()).applyFilters('pc:list', [{ column: 'No.', value: '103293' }]);
      expect(result.ok).toBe(true);
      expect(session.invoke).toHaveBeenCalledOnce();
    }
  });

  it('fails when BC does not take the value on SaveValue either', async () => {
    const repo = new PageContextRepository();
    makeFilteredList(repo);
    const session = makeSession();
    session.invoke
      .mockResolvedValueOnce(ok([insertedLine('')]))
      .mockResolvedValueOnce(ok([]));
    const result = await new FilterService(session as any, repo, createNullLogger()).applyFilters('pc:list', [{ column: 'No.', value: '103293' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unfiltered');
  });

  it('bc_close_page clears the filters this session added before closing', async () => {
    const repo = new PageContextRepository();
    makeFilteredList(repo);
    const session = makeSession();
    const filters = new FilterService(session as any, repo, createNullLogger());
    const closePage = vi.fn(async () => ok({ events: [] as BCEvent[] }));
    const close = new ClosePageOperation({ closePage } as never, repo, filters);

    await close.execute({ pageContextId: 'pc:list' });
    expect(session.invoke).not.toHaveBeenCalled(); // never filtered: nothing to clear

    expect((await filters.applyFilters('pc:list', [{ column: 'No.', value: '103293' }])).ok).toBe(true);
    session.invoke.mockClear();
    await close.execute({ pageContextId: 'pc:list' });
    expect(session.invoke.mock.calls.map(c => (c[0] as any).filterOperation)).toEqual([
      FilterOperation.Reset, FilterOperation.Execute, FilterOperation.Execute,
    ]);
    expect(closePage).toHaveBeenCalledTimes(2);
    expect(filters.hasFilters('pc:list')).toBe(false);
  });
});
