import { describe, it, expect, vi } from 'vitest';
import { LookupService } from '../../src/services/lookup-service.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { createNullLogger } from '../../src/core/logger.js';

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
});
