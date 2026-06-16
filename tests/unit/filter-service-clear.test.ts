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
          { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '18.1' } },
          { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2', Path: '18.2' } },
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
        { t: 'sc', Caption: 'Name', ColumnBinder: { Name: 'c1', Path: '18.2' }, Editable: true, Visible: true },
      ],
    },
  } as BCEvent]);
}

function makeSession(invokeResult: unknown = ok([] as BCEvent[])) {
  return {
    invoke: vi.fn(async () => invokeResult),
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
