import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetOperationOperation } from '../../src/operations/get-operation.js';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { PageService } from '../../src/services/page-service.js';
import type { BCEvent } from '../../src/protocol/types.js';

const PC = 'session:page:22:abcd1234';

function listRepo(rows: Array<[string, string, string]>): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create(PC, 'F1', { isModal: false, wizardState: null });
  repo.applyToPage(PC, [{
    type: 'FormCreated', formId: 'F1', isReload: false,
    controlTree: {
      t: 'lf', ServerId: 'F1', PageType: 1, Caption: 'Customers',
      Children: [{ t: 'rc', Columns: [
        { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '18.1' } },
        { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2', Path: '18.2' } },
      ] }],
    },
  } as BCEvent]);
  repo.applyToPage(PC, [{
    type: 'DataLoaded', formId: 'F1', controlPath: 'server:c[0]', currentRowOnly: false,
    rows: rows.map(([bm, no, name], i) => ({ DataRowInserted: [i, { bookmark: bm, cells: { c1: { stringValue: no }, c2: { stringValue: name } } }] })),
  } as BCEvent]);
  return repo;
}

describe('GetOperationOperation', () => {
  let dir: string;
  let ledger: OperationLedger;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-getop-')); ledger = new OperationLedger(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function record(id: string, status: 'completed' | 'unknown', replaySafe: boolean) {
    const target = createTargetDescriber(listRepo([['BM1', '10000', 'Adatum'], ['BM2', '20000', 'Trey']]), () => 'CRONUS')(
      { pageContextId: PC, fields: { Name: 'New' }, bookmark: 'BM2' });
    await ledger.claim(id, 'bc_write_data', 'digest', target);
    await ledger.settle(id, { status, replaySafe });
  }

  function opWith(current: PageContextRepository, company = 'CRONUS') {
    const pageService = {
      openPage: vi.fn(async () => ok(current.get(PC)!)),
      closePage: vi.fn(async () => ok({ events: [] })),
    };
    return { op: new GetOperationOperation(ledger, pageService as unknown as PageService, () => company), pageService };
  }

  it('rejects an unknown operationId', async () => {
    const r = await opWith(listRepo([])).op.execute({ operationId: 'nope' });
    expect(r.ok).toBe(false);
  });

  it('returns a completed replay-safe entry without touching BC', async () => {
    await record('safe', 'completed', true);
    const { op, pageService } = opWith(listRepo([]));
    const r = await op.execute({ operationId: 'safe' });
    expect(r.ok && r.value.readBack).toBeUndefined();
    expect(r.ok && r.value.entry.status).toBe('completed');
    expect(pageService.openPage).not.toHaveBeenCalled();
  });

  it('re-reads the targeted row by bookmark, hashes it, and closes the page', async () => {
    await record('doubt', 'unknown', false);
    const { op, pageService } = opWith(listRepo([['BM1', '10000', 'Adatum'], ['BM2', '20000', 'New']]));
    const r = await op.execute({ operationId: 'doubt' });
    if (!r.ok) throw r.error;
    expect(pageService.openPage).toHaveBeenCalledWith('22', { bookmark: 'BM2' });
    expect(r.value.readBack).toEqual({ company: 'CRONUS', pageId: '22', bookmark: 'BM2', sectionId: 'header', row: { bookmark: 'BM2', cells: { 'No.': '20000', Name: 'New' } } });
    expect(r.value.evidenceHash).toBe(digestInput(r.value.readBack));
    expect(pageService.closePage).toHaveBeenCalledWith(PC, { discardChanges: true });
  });

  it('reports a vanished row as null', async () => {
    await record('gone', 'completed', false);
    const r = await opWith(listRepo([['BM1', '10000', 'Adatum']])).op.execute({ operationId: 'gone' });
    expect(r.ok && r.value.readBack?.row).toBeNull();
  });

  it('refuses to read back in another company', async () => {
    await record('co', 'unknown', false);
    const { op, pageService } = opWith(listRepo([]), 'My Company');
    const r = await op.execute({ operationId: 'co' });
    expect(r.ok && r.value.readBackError?.code).toBe('COMPANY_MISMATCH');
    expect(pageService.openPage).not.toHaveBeenCalled();
  });
});
