import { describe, it, expect, vi } from 'vitest';
import { LookupService } from '../../src/services/lookup-service.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { createNullLogger } from '../../src/core/logger.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

// Lookup popup form tree: a list page with a repeater carrying inline rows in
// rc.Data.Rows.LoadedRows (BC delivers rows inline, not via DataLoaded).
const LOOKUP_FORM_LF = {
  t: 'lf', ServerId: 'lookup-form-99', PageType: 1, Children: [{
    t: 'rc',
    Columns: [
      { t: 'rcc', Caption: 'Code', ColumnBinder: { Name: '1' } },
      { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: '2' } },
    ],
    Data: {
      Rows: {
        LoadedRows: [
          { bookmark: 'bm-aj', cells: { '1': { stringValue: 'AJ' }, '2': { stringValue: 'Anika Jensen' } } },
          { bookmark: 'bm-jr', cells: { '1': { stringValue: 'JR' }, '2': { stringValue: 'John Roberts' } } },
        ],
      },
    },
    Children: [],
  }],
};

// Minimal lf tree with one sc field that has a lookup (LookupAction.CanShowSimpleLookup=true)
const CARD_LF_LOOKUP = {
  t: 'lf', ServerId: 'card-form-1', PageType: 0, Children: [{
    t: 'gc', Caption: 'General', Children: [{
      t: 'sc', Caption: 'Salesperson Code', ColumnBinder: { Name: '123_c1' }, Editable: true,
      LookupAction: { t: 'lookac', SystemAction: 110, CanShowSimpleLookup: true },
    }],
  }],
};

// lf tree with a plain text field (no lookup)
const CARD_LF_NO_LOOKUP = {
  t: 'lf', ServerId: 'card-form-2', PageType: 0, Children: [{
    t: 'sc', Caption: 'Name', ColumnBinder: { Name: '1_c0' }, Editable: true,
  }],
};

// lf tree with CanShowSimpleLookup=false (AL OnLookup trigger)
const CARD_LF_CSSL_FALSE = {
  t: 'lf', ServerId: 'card-form-3', PageType: 0, Children: [{
    t: 'sc', Caption: 'Item No.', Editable: true,
    LookupAction: { t: 'lookac', SystemAction: 110, CanShowSimpleLookup: false },
  }],
};

function makeRepo(pcId: string, formId: string, lf: unknown): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{ type: 'FormCreated', formId, isReload: false, controlTree: lf }]);
  return repo;
}

describe('LookupService', () => {
  it('returns error when page context not found', async () => {
    const repo = new PageContextRepository();
    const mockSession = { invoke: vi.fn(), removeOpenForm: vi.fn() } as unknown as BCSession;
    const svc = new LookupService(mockSession, repo, createNullLogger());
    const result = await svc.lookup('nonexistent', 'Code');
    expect(result.ok).toBe(false);
  });

  it('returns error when field has no lookup (hasLookup=false)', async () => {
    const repo = makeRepo('pc-2', 'card-form-2', CARD_LF_NO_LOOKUP);
    const mockSession = { invoke: vi.fn(), removeOpenForm: vi.fn() } as unknown as BCSession;
    const svc = new LookupService(mockSession, repo, createNullLogger());
    const result = await svc.lookup('pc-2', 'Name');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no lookup/i);
    }
  });

  it('returns error when CanShowSimpleLookup=false (AL OnLookup trigger)', async () => {
    const repo = makeRepo('pc-3', 'card-form-3', CARD_LF_CSSL_FALSE);
    const mockSession = { invoke: vi.fn(), removeOpenForm: vi.fn() } as unknown as BCSession;
    const svc = new LookupService(mockSession, repo, createNullLogger());
    const result = await svc.lookup('pc-3', 'Item No.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('AL OnLookup trigger');
    }
  });

  it('removes the temporary lookup page context from the repo after a successful lookup', async () => {
    const repo = makeRepo('pc-ok', 'card-form-1', CARD_LF_LOOKUP);

    // Mock session: Lookup=110 yields a FormCreated for the lookup form; every
    // other invoke (LookupCancel) yields a bare InvokeCompleted.
    const invoke = vi.fn(async (interaction: { systemAction?: number }) => {
      if (interaction.systemAction === 110) {
        const formCreated: BCEvent = {
          type: 'FormCreated', formId: 'lookup-form-99', isReload: false, controlTree: LOOKUP_FORM_LF,
        };
        return ok([formCreated, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[]);
      }
      return ok([{ type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[]);
    });
    const removeOpenForm = vi.fn();
    const mockSession = { invoke, removeOpenForm } as unknown as BCSession;

    const svc = new LookupService(mockSession, repo, createNullLogger());
    const result = await svc.lookup('pc-ok', 'Salesperson Code');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows.length).toBe(2);
      expect(result.value.rows[0]!.values).toMatchObject({ Code: 'AJ', Name: 'Anika Jensen' });
    }

    // The lookup form's openForm tracking AND its temporary page context must be released.
    expect(removeOpenForm).toHaveBeenCalledWith('lookup-form-99');
    const lookupPcId = 'session:lookup:lookup-f';
    expect(repo.get(lookupPcId)).toBeUndefined();
    expect(repo.getByFormId('lookup-form-99')).toBeUndefined();
  });

  it('removes the temporary lookup page context even when the work step throws (error path)', async () => {
    const repo = makeRepo('pc-err', 'card-form-1', CARD_LF_LOOKUP);

    let call = 0;
    const invoke = vi.fn(async (interaction: { systemAction?: number }) => {
      call++;
      if (interaction.systemAction === 110) {
        const formCreated: BCEvent = {
          type: 'FormCreated', formId: 'lookup-form-99', isReload: false, controlTree: LOOKUP_FORM_LF,
        };
        return ok([formCreated, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[]);
      }
      // The LookupCancel invoke (in finally) throws — must still clean up the repo.
      if (interaction.systemAction === 340) {
        throw new Error('simulated cancel failure');
      }
      return ok([{ type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[]);
    });
    const removeOpenForm = vi.fn();
    const mockSession = { invoke, removeOpenForm } as unknown as BCSession;

    const svc = new LookupService(mockSession, repo, createNullLogger());
    // Even though LookupCancel throws, the finally swallows it and cleans up.
    const result = await svc.lookup('pc-err', 'Salesperson Code');
    expect(result.ok).toBe(true); // doLookupWork succeeded before the cancel threw

    const lookupPcId = 'session:lookup:lookup-f';
    expect(repo.get(lookupPcId)).toBeUndefined();
    expect(repo.getByFormId('lookup-form-99')).toBeUndefined();
    expect(removeOpenForm).toHaveBeenCalledWith('lookup-form-99');
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
