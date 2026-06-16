// tests/unit/list-companies-operation.test.ts
//
// Unit tests for ListCompaniesOperation.
// Tests input validation, service error propagation, and output shape.
// The operation:
//   1. Opens page 357 via pageService.openPage
//   2. Reads rows via dataService.readRows
//   3. Maps the first string cell value as the company name
//   4. Always closes the page (even on error paths)
//   Returns { currentCompany, companies[] }

import { describe, it, expect, vi } from 'vitest';
import { ListCompaniesOperation } from '../../src/operations/list-companies.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';

const noopLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makePageService(overrides?: Record<string, unknown>) {
  return {
    openPage: vi.fn(async () => ok({ pageContextId: 'pc:companies:1' })),
    closePage: vi.fn(async () => ok(undefined)),
    ...overrides,
  } as any;
}

function makeDataService(overrides?: Record<string, unknown>) {
  return {
    readRows: vi.fn(() => ok([
      { bookmark: 'bk1', cells: { Name: 'CRONUS International Ltd.' } },
      { bookmark: 'bk2', cells: { Name: 'My Company' } },
    ])),
    ...overrides,
  } as any;
}

describe('ListCompaniesOperation', () => {
  it('returns current company and company list on success', async () => {
    const pageService = makePageService();
    const dataService = makeDataService();
    const getCurrentCompany = vi.fn(() => 'CRONUS International Ltd.');
    const op = new ListCompaniesOperation(pageService, dataService, getCurrentCompany, noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentCompany).toBe('CRONUS International Ltd.');
    expect(result.value.companies).toHaveLength(2);
    expect(result.value.companies[0]!.name).toBe('CRONUS International Ltd.');
    expect(result.value.companies[0]!.displayName).toBe('CRONUS International Ltd.');
    expect(result.value.companies[1]!.name).toBe('My Company');
  });

  it('always calls closePage after openPage succeeds — even when readRows errors', async () => {
    const pageService = makePageService();
    const dataService = makeDataService({
      readRows: vi.fn(() => err(new ProtocolError('read failed'))),
    });
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(false);
    // closePage must have been called with the pageContextId returned by openPage
    expect(pageService.closePage).toHaveBeenCalledWith('pc:companies:1');
  });

  it('always calls closePage after a successful read — does not leak the page', async () => {
    const pageService = makePageService();
    const dataService = makeDataService();
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    await op.execute();

    expect(pageService.closePage).toHaveBeenCalledWith('pc:companies:1');
  });

  it('propagates openPage error before reading rows', async () => {
    const openErr = new ProtocolError('BC connection refused');
    const pageService = makePageService({
      openPage: vi.fn(async () => err(openErr)),
    });
    const dataService = makeDataService();
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('BC connection refused');
    }
    // readRows must NOT be called when openPage fails
    expect(dataService.readRows).not.toHaveBeenCalled();
    // closePage must NOT be called when openPage fails (there is no page to close)
    expect(pageService.closePage).not.toHaveBeenCalled();
  });

  it('propagates readRows error as-is', async () => {
    const readErr = new ProtocolError('repeater not found');
    const pageService = makePageService();
    const dataService = makeDataService({
      readRows: vi.fn(() => err(readErr)),
    });
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('repeater not found');
    }
  });

  it('returns empty companies array when readRows returns no rows', async () => {
    const pageService = makePageService();
    const dataService = makeDataService({
      readRows: vi.fn(() => ok([])),
    });
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.companies).toHaveLength(0);
    expect(result.value.currentCompany).toBe('CRONUS');
  });

  it('maps the first string cell value regardless of cell key name', async () => {
    // The operation uses Object.values(cells).find(v => typeof v === 'string')
    // so it should work with any cell key name (BC uses different column names per locale)
    const pageService = makePageService();
    const dataService = makeDataService({
      readRows: vi.fn(() => ok([
        { bookmark: 'bk1', cells: { CompanyName: 'Fabrikam Inc.' } },
      ])),
    });
    const op = new ListCompaniesOperation(pageService, dataService, () => 'Fabrikam Inc.', noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.companies[0]!.name).toBe('Fabrikam Inc.');
    expect(result.value.companies[0]!.displayName).toBe('Fabrikam Inc.');
  });

  it('tolerates closePage throwing — does not propagate closePage error', async () => {
    const pageService = makePageService({
      closePage: vi.fn(async () => { throw new Error('close failed'); }),
    });
    const dataService = makeDataService();
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    // Should not throw even if closePage rejects
    const result = await op.execute();
    expect(result.ok).toBe(true);
  });

  it('passes page 357 to openPage (companies system page)', async () => {
    const pageService = makePageService();
    const dataService = makeDataService();
    const op = new ListCompaniesOperation(pageService, dataService, () => 'CRONUS', noopLogger);

    await op.execute();

    expect(pageService.openPage).toHaveBeenCalledWith('357');
  });

  it('calls getCurrentCompany to obtain the current company at output-build time', async () => {
    const pageService = makePageService();
    const dataService = makeDataService();
    const getCurrentCompany = vi.fn(() => 'Live Company');
    const op = new ListCompaniesOperation(pageService, dataService, getCurrentCompany, noopLogger);

    const result = await op.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getCurrentCompany).toHaveBeenCalled();
    expect(result.value.currentCompany).toBe('Live Company');
  });
});
