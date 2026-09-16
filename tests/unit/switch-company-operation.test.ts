// tests/unit/switch-company-operation.test.ts
//
// Unit tests for SwitchCompanyOperation.
// Behaviors:
//   - Delegates to session.changeCompany(targetName), which re-opens the
//     session bound to the target company (the ONLY thing that rebinds a
//     company in BC -- systemAction 500 / envelope company are no-ops).
//   - Invalidates ALL page context IDs in the repo on success
//   - Returns { previousCompany, newCompany, invalidatedPageContextIds }
//   - newCompany reflects session.companyName AFTER the switch (BC-echoed name)
//   - previousCompany comes from session.companyName (read BEFORE the switch)
//   - On failure: does NOT clear the repo (no partial state mutation)
//   - A "does not exist" re-open error maps to CompanyNotFoundError

import { describe, it, expect, vi } from 'vitest';
import { SwitchCompanyOperation } from '../../src/operations/switch-company.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

const noopLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSession(overrides?: Record<string, unknown>) {
  const session: Record<string, unknown> = {
    companyName: 'CRONUS International Ltd.',
    // Default: a successful switch echoes the requested company name back.
    changeCompany: vi.fn(async (name: string) => {
      session.companyName = name;
      return ok([] as BCEvent[]);
    }),
    ...overrides,
  };
  return session as any;
}

function makeRepo(...pageContextIds: string[]) {
  const repo = new PageContextRepository();
  pageContextIds.forEach((id, i) => repo.create(id, `form-${i}`));
  return repo;
}

describe('SwitchCompanyOperation — session interaction', () => {
  it('delegates to session.changeCompany with the target company name', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    await op.execute({ companyName: 'Fabrikam Inc.' });

    expect(session.changeCompany).toHaveBeenCalledOnce();
    expect(session.changeCompany.mock.calls[0]![0]).toBe('Fabrikam Inc.');
  });

  it('uses session.companyName (read before switch) as previousCompany and the echoed name as newCompany', async () => {
    const session = makeSession({
      companyName: 'Old Corp',
      changeCompany: vi.fn(async () => {
        session.companyName = 'New Corp'; // BC echoes the confirmed name
        return ok([] as BCEvent[]);
      }),
    });
    const repo = makeRepo();
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'New Corp' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousCompany).toBe('Old Corp');
    expect(result.value.newCompany).toBe('New Corp');
  });
});

describe('SwitchCompanyOperation — output shape', () => {
  it('returns all existing page context IDs as invalidatedPageContextIds', async () => {
    const session = makeSession();
    const repo = makeRepo('pc:1', 'pc:2', 'pc:3');
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Fabrikam Inc.' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalidatedPageContextIds.sort()).toEqual(['pc:1', 'pc:2', 'pc:3']);
  });

  it('returns empty invalidatedPageContextIds when repo has no pages', async () => {
    const session = makeSession();
    const repo = makeRepo(); // empty
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Fabrikam Inc.' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalidatedPageContextIds).toEqual([]);
  });
});

describe('SwitchCompanyOperation — repo clearAll', () => {
  it('clears all page contexts from the repo after successful company switch', async () => {
    const session = makeSession();
    const repo = makeRepo('pc:1', 'pc:2');
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    expect(repo.get('pc:1')).toBeDefined();
    await op.execute({ companyName: 'Fabrikam Inc.' });
    expect(repo.get('pc:1')).toBeUndefined();
    expect(repo.get('pc:2')).toBeUndefined();
  });

  it('does NOT clear the repo when the switch fails', async () => {
    const session = makeSession({
      changeCompany: vi.fn(async () => err(new ProtocolError('BC rejected company switch'))),
    });
    const repo = makeRepo('pc:1', 'pc:2');
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Fabrikam Inc.' });

    expect(result.ok).toBe(false);
    // Repo must still have the contexts (no partial mutation)
    expect(repo.get('pc:1')).toBeDefined();
    expect(repo.get('pc:2')).toBeDefined();
  });
});

describe('SwitchCompanyOperation — error propagation', () => {
  it('propagates a non-company protocol error unchanged', async () => {
    const session = makeSession({
      changeCompany: vi.fn(async () => err(new ProtocolError('websocket closed unexpectedly'))),
    });
    const repo = makeRepo();
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Nonexistent Corp' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROTOCOL_ERROR');
      expect(result.error.message).toContain('websocket closed');
    }
  });

  it('maps a NavWebFailedOpenCompanyException ("does not exist") to CompanyNotFoundError', async () => {
    const session = makeSession({
      changeCompany: vi.fn(async () =>
        err(new ProtocolError('JSON-RPC error: The company "Nonexistent Corp" does not exist.'))),
    });
    const repo = makeRepo('pc:1');
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Nonexistent Corp' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('COMPANY_NOT_FOUND');
      expect(result.error.message).toContain('Nonexistent Corp');
    }
    // Failed switch must not clear page contexts.
    expect(repo.get('pc:1')).toBeDefined();
  });
});
