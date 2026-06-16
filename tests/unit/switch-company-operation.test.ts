// tests/unit/switch-company-operation.test.ts
//
// Unit tests for SwitchCompanyOperation.
// Behaviors:
//   - Sends InvokeSessionAction with systemAction=500 (ChangeCompany) and company name
//   - Invalidates ALL page context IDs in the repo on success
//   - Returns { previousCompany, newCompany, invalidatedPageContextIds }
//   - On session error: does NOT clear the repo (no partial state mutation)
//   - previousCompany comes from session.companyName (read BEFORE the invoke)

import { describe, it, expect, vi } from 'vitest';
import { SwitchCompanyOperation } from '../../src/operations/switch-company.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

const noopLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeSession(overrides?: Record<string, unknown>) {
  return {
    companyName: 'CRONUS International Ltd.',
    invoke: vi.fn(async () => ok([] as BCEvent[])),
    ...overrides,
  } as any;
}

function makeRepo(...pageContextIds: string[]) {
  const repo = new PageContextRepository();
  pageContextIds.forEach((id, i) => repo.create(id, `form-${i}`));
  return repo;
}

describe('SwitchCompanyOperation — session interaction', () => {
  it('sends InvokeSessionAction with systemAction=500 and the target company name', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    await op.execute({ companyName: 'Fabrikam Inc.' });

    expect(session.invoke).toHaveBeenCalledOnce();
    const [interaction] = session.invoke.mock.calls[0]!;
    expect(interaction.type).toBe('SessionAction');
    expect(interaction.actionName).toBe('InvokeSessionAction');
    expect(interaction.namedParameters.systemAction).toBe(500);
    expect(interaction.namedParameters.company).toBe('Fabrikam Inc.');
  });

  it('uses session.companyName (read before invoke) as previousCompany', async () => {
    const session = makeSession({ companyName: 'Old Corp' });
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

  it('does NOT clear the repo when session.invoke fails', async () => {
    const session = makeSession({
      invoke: vi.fn(async () => err(new ProtocolError('BC rejected company switch'))),
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
  it('propagates session invoke error unchanged', async () => {
    const session = makeSession({
      invoke: vi.fn(async () => err(new ProtocolError('company not found: Nonexistent Corp'))),
    });
    const repo = makeRepo();
    const op = new SwitchCompanyOperation(session, repo, noopLogger);

    const result = await op.execute({ companyName: 'Nonexistent Corp' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('company not found');
    }
  });
});
