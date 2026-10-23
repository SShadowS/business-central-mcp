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
        { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' }, ColumnBinderPath: '18.1' },
        { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'c2' }, ColumnBinderPath: '18.2' },
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

  function opWith(current: PageContextRepository, company = 'CRONUS', modalOpen = false, pc = PC) {
    const pageService = {
      openPage: vi.fn(async () => ok(current.get(pc)!)),
      closePage: vi.fn(async () => ok({ events: [] })),
    };
    return { op: new GetOperationOperation(ledger, pageService as unknown as PageService, () => company, () => modalOpen), pageService };
  }

  const CARD = 'session:page:21:card0001';
  function cardRepo(bookmark: string | undefined, name: string): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create(CARD, 'C1', { isModal: false, wizardState: null });
    repo.applyToPage(CARD, [{
      type: 'FormCreated', formId: 'C1', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'C1', PageType: 0, Caption: 'Customer Card', ...(bookmark ? { Bookmark: bookmark } : {}),
        Children: [{ t: 'sc', Caption: 'Address 2', StringValue: name }],
      },
    } as BCEvent]);
    return repo;
  }

  async function recordCard(id: string, bookmark: string | undefined, fields: Record<string, string>) {
    const target = createTargetDescriber(cardRepo(bookmark, 'old'), () => 'CRONUS')({ pageContextId: CARD, fields });
    await ledger.claim(id, 'bc_write_data', 'digest', target);
    await ledger.settle(id, { status: 'unknown', replaySafe: false });
  }

  // Live cronus29: Sales Order 42 Metadata.primaryKeyIds = [1, 3]; "No." (field 3) is a hidden control,
  // "Document Type" (field 1) has none, so it comes from the record bookmark (live: Order 101009).
  const SO_101009 = '1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA5';
  function keyedRepo(no: string, noCaption = 'No.', bookmark = SO_101009): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create(CARD, 'C1', { isModal: false, wizardState: null });
    repo.applyToPage(CARD, [{
      type: 'FormCreated', formId: 'C1', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'C1', PageType: 0, Caption: 'Sales Order', Bookmark: bookmark,
        Metadata: { id: 21, sourceTableId: 36, primaryKeyIds: [1, 3] },
        Children: [
          { t: 'sc', Caption: 'Address 2', StringValue: 'X', TableFieldNo: 6 },
          { t: 'sc', Caption: noCaption, StringValue: no, TableFieldNo: 3, Visible: false },
        ],
      },
    } as BCEvent]);
    return repo;
  }

  it('reads the primary key back by table field number, whatever its caption is now', async () => {
    const target = createTargetDescriber(keyedRepo('101009'), () => 'CRONUS')({ pageContextId: CARD, fields: { 'Address 2': 'X' } });
    expect(target.keyFields).toEqual([{ fieldNo: 1, caption: '', value: '1', source: 'bookmark' }, { fieldNo: 3, caption: 'No.', value: '101009' }]);
    expect(target.fields).toBeUndefined();
    await ledger.claim('pk', 'bc_write_data', 'digest', target);
    await ledger.settle('pk', { status: 'unknown', replaySafe: false });
    const r = await opWith(keyedRepo('101009', 'Order No.'), 'CRONUS', false, CARD).op.execute({ operationId: 'pk' });
    if (!r.ok) throw r.error;
    expect(r.value.readBackError).toBeUndefined();
    expect(r.value.readBack?.keyFields).toEqual([{ fieldNo: 1, caption: '', value: '1', source: 'bookmark' }, { fieldNo: 3, caption: 'No.', value: '101009' }]);
    expect(r.value.readBack?.fields).toEqual({ 'Address 2': 'X' });
    expect(r.value.evidenceHash).toBeDefined();
  });

  it('resolves recorded DesignNames with the recorded keyBy; the caller\'s keyBy only keys the output', async () => {
    const repo = new PageContextRepository();
    repo.create(CARD, 'C1', { isModal: false, wizardState: null });
    repo.applyToPage(CARD, [{
      type: 'FormCreated', formId: 'C1', isReload: false,
      controlTree: { t: 'lf', ServerId: 'C1', PageType: 0, Caption: 'Klantenkaart', Bookmark: 'BM9',
        Children: [{ t: 'sc', Caption: 'Adres 2', DesignName: 'Address 2', StringValue: 'X' }] },
    } as BCEvent]);
    const describe = createTargetDescriber(repo, () => 'CRONUS');
    expect(describe({ pageContextId: CARD, action: 'Release', keyBy: 'designName' }).fields).toEqual({ 'Address 2': 'X' });
    await ledger.claim('kb', 'bc_write_data', 'digest', describe({ pageContextId: CARD, fields: { 'Address 2': 'X' }, keyBy: 'designName' }));
    await ledger.settle('kb', { status: 'unknown', replaySafe: false });
    const r = await opWith(repo, 'CRONUS', false, CARD).op.execute({ operationId: 'kb', keyBy: 'caption' });
    if (!r.ok) throw r.error;
    expect(r.value.readBack?.fields).toEqual({ 'Adres 2': 'X' });
  });

  it('keeps the leading-field fallback when the key comes only from the bookmark (no key control)', async () => {
    const repo = new PageContextRepository();
    repo.create(CARD, 'C1', { isModal: false, wizardState: null });
    repo.applyToPage(CARD, [{
      type: 'FormCreated', formId: 'C1', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'C1', PageType: 0, Caption: 'Sales Order', Bookmark: SO_101009,
        Metadata: { id: 42, sourceTableId: 36, primaryKeyIds: [1, 3] },
        Children: [{ t: 'sc', Caption: 'Address 2', StringValue: 'X', TableFieldNo: 6 }],
      },
    } as BCEvent]);
    const target = createTargetDescriber(repo, () => 'CRONUS')({ pageContextId: CARD, action: 'Release' });
    expect(target.keyFields).toEqual([{ fieldNo: 1, caption: '', value: '1', source: 'bookmark' }, { fieldNo: 3, caption: '', value: '101009', source: 'bookmark' }]);
    expect(target.fields).toEqual({ 'Address 2': 'X' });
    await ledger.claim('pkb', 'bc_execute_action', 'digest', target);
    await ledger.settle('pkb', { status: 'unknown', replaySafe: false });
    const r = await opWith(repo, 'CRONUS', false, CARD).op.execute({ operationId: 'pkb' });
    if (!r.ok) throw r.error;
    expect(r.value.readBack?.fields).toEqual({ 'Address 2': 'X' });
  });

  it('reports a primary-key mismatch distinctly, without an evidence hash', async () => {
    const target = createTargetDescriber(keyedRepo('101009'), () => 'CRONUS')({ pageContextId: CARD, action: 'Release' });
    await ledger.claim('pkx', 'bc_execute_action', 'digest', target);
    await ledger.settle('pkx', { status: 'unknown', replaySafe: false });
    const r = await opWith(keyedRepo('101010'), 'CRONUS', false, CARD).op.execute({ operationId: 'pkx' });
    if (!r.ok) throw r.error;
    expect(r.value.readBackError?.code).toBe('KEY_MISMATCH');
    expect(r.value.readBackError?.message).toContain("'101009' -> '101010'");
    expect(r.value.readBack?.keyFields).toEqual([{ fieldNo: 1, caption: '', value: '1', source: 'bookmark' }, { fieldNo: 3, caption: 'No.', value: '101010' }]);
    expect(r.value.readBack?.fields).toBeUndefined();
    expect(r.value.evidenceHash).toBeUndefined();
  });

  it('does not open a page while a dialog is open (OpenForm would abort it)', async () => {
    await record('modal', 'unknown', false);
    const { op, pageService } = opWith(listRepo([]), 'CRONUS', true);
    const r = await op.execute({ operationId: 'modal' });
    expect(r.ok && r.value.readBackError?.code).toBe('MODAL_OPEN');
    expect(pageService.openPage).not.toHaveBeenCalled();
  });

  it('refuses an unkeyed open when the card target has no record bookmark', async () => {
    await recordCard('nobm', undefined, { Name: 'X' });
    const { op, pageService } = opWith(cardRepo('BMC', 'X'), 'CRONUS', false, CARD);
    const r = await op.execute({ operationId: 'nobm' });
    expect(r.ok && r.value.readBackError?.code).toBe('NO_TARGET');
    expect(pageService.openPage).not.toHaveBeenCalled();
  });

  it('reads written fields back by the same case-insensitive caption / controlPath rules as bc_write_data', async () => {
    await recordCard('ci', 'BMC', { 'address 2': 'X', 'server:c[0]': 'X' });
    const { op, pageService } = opWith(cardRepo('BMC', 'X'), 'CRONUS', false, CARD);
    const r = await op.execute({ operationId: 'ci' });
    if (!r.ok) throw r.error;
    expect(pageService.openPage).toHaveBeenCalledWith('21', { bookmark: 'BMC' });
    expect(r.value.readBack?.fields).toMatchObject({ 'address 2': 'X', 'server:c[0]': 'X' });
  });

  it('reports a deleted card record instead of reading back the record BC landed on', async () => {
    // Live cronus29: a fully posted order's bookmark opened the NEXT order, no error.
    await recordCard('deleted', 'BMC', { 'Address 2': 'X' });
    const { op, pageService } = opWith(cardRepo('BMNEXT', 'other'), 'CRONUS', false, CARD);
    const r = await op.execute({ operationId: 'deleted' });
    expect(r.ok && r.value.readBackError?.code).toBe('RECORD_NOT_OPENED');
    expect(r.ok && r.value.readBack).toBeUndefined();
    expect(pageService.closePage).toHaveBeenCalled();
  });

  it('reads a document target back with its lines, so a posting shows in the evidence', async () => {
    const DOC = 'session:page:42:doc00001';
    const docRepo = (shipped: string): PageContextRepository => {
      const repo = new PageContextRepository();
      repo.create(DOC, 'H1', { isModal: false, wizardState: null });
      repo.applyToPage(DOC, [{
        type: 'FormCreated', formId: 'H1', isReload: false,
        controlTree: { t: 'lf', ServerId: 'H1', PageType: 0, Caption: 'Sales Order', Bookmark: 'BMH', Children: [{ t: 'sc', Caption: 'No.', StringValue: '101005' }] },
      } as BCEvent]);
      repo.applyToPage(DOC, [{
        type: 'FormCreated', formId: 'L1', parentFormId: 'H1', isReload: false,
        controlTree: { t: 'lf', ServerId: 'L1', PageType: 1, Caption: 'Lines', IsSubForm: true, IsPart: true,
          Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Quantity Shipped', ColumnBinder: { Name: 'q' }, ColumnBinderPath: '37.1' }] }] },
      } as BCEvent]);
      repo.applyToPage(DOC, [{
        type: 'DataLoaded', formId: 'L1', controlPath: 'server:c[0]', currentRowOnly: false,
        rows: [{ DataRowInserted: [0, { bookmark: 'BML', cells: { q: { stringValue: shipped } } }] }],
      } as BCEvent]);
      return repo;
    };
    const target = createTargetDescriber(docRepo('0'), () => 'CRONUS')({ pageContextId: DOC, dialogFormId: 'D1', response: 'ok' });
    expect(target.fields).toEqual({ 'No.': '101005' }); // identity only: unchanged by a posting
    await ledger.claim('post', 'bc_respond_dialog', 'digest', target);
    await ledger.settle('post', { status: 'unknown', replaySafe: false });

    const r = await opWith(docRepo('1'), 'CRONUS', false, DOC).op.execute({ operationId: 'post' });
    if (!r.ok) throw r.error;
    expect(r.value.readBack?.lines).toEqual([{ bookmark: 'BML', cells: { 'Quantity Shipped': '1' } }]);
    const unposted = await opWith(docRepo('0'), 'CRONUS', false, DOC).op.execute({ operationId: 'post' });
    expect(unposted.ok && unposted.value.evidenceHash).not.toBe(r.value.evidenceHash);
  });

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
