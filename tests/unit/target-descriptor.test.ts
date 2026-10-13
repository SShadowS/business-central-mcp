import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import { TimeoutError } from '../../src/core/errors.js';
import type { BCEvent } from '../../src/protocol/types.js';

const PC = 'session:page:22:abcd1234';

function listRepo(): PageContextRepository {
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
    rows: [
      { DataRowInserted: [0, { bookmark: 'BM1', cells: { c1: { stringValue: '10000' }, c2: { stringValue: 'Adatum' } } }] },
      { DataRowInserted: [1, { bookmark: 'BM2', cells: { c1: { stringValue: '20000' }, c2: { stringValue: 'Trey' } } }] },
    ],
  } as BCEvent]);
  return repo;
}

describe('createTargetDescriber', () => {
  it('captures page identity, company and the targeted row by bookmark', () => {
    const d = createTargetDescriber(listRepo(), () => 'CRONUS')({ pageContextId: PC, action: 'Delete', bookmark: 'BM2', expectedStateVersion: 3 });
    expect(d.company).toBe('CRONUS');
    expect(d.page).toMatchObject({ pageContextId: PC, pageId: '22', isModal: false });
    expect(d.section).toMatchObject({ sectionId: 'header' });
    expect(d.rows).toEqual([{ bookmark: 'BM2', cells: { 'No.': '20000', Name: 'Trey' } }]);
    expect(d.args).toEqual({ pageContextId: PC, action: 'Delete', bookmark: 'BM2' }); // staleness guard dropped
  });

  it('takes pageId from the form Metadata, so an action-opened page is identified', () => {
    const repo = new PageContextRepository();
    const pc = 'session:page:action:ab12cd34';
    repo.create(pc, 'F9', { isModal: false, wizardState: null });
    repo.applyToPage(pc, [{
      type: 'FormCreated', formId: 'F9', isReload: false,
      controlTree: { t: 'lf', ServerId: 'F9', PageType: 0, Caption: 'Sales Order', Metadata: { id: 42, sourceTableId: 36 }, Children: [] },
    } as BCEvent]);
    expect(createTargetDescriber(repo, () => 'CRONUS')({ pageContextId: pc }).page).toMatchObject({ pageId: '42' });
  });

  it('identifies a card by Metadata.primaryKeyIds joined to TableFieldNo, in key order, skipping repeater templates', () => {
    const repo = new PageContextRepository();
    const pc = 'session:page:42:pk000001';
    repo.create(pc, 'F7', { isModal: false, wizardState: null });
    repo.applyToPage(pc, [{
      type: 'FormCreated', formId: 'F7', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'F7', PageType: 0, Caption: 'Sales Order', Metadata: { id: 42, sourceTableId: 36, primaryKeyIds: [1, 3] },
        Children: [
          { t: 'rc', Columns: [], Children: [{ t: 'sc', Caption: 'Template', TableFieldNo: 3, StringValue: 'row' }] },
          { t: 'sc', Caption: 'Customer Name', TableFieldNo: 79, StringValue: 'Adatum' },
          { t: 'sc', Caption: 'No.', TableFieldNo: 3, StringValue: '101009', Visible: false },
          { t: 'sec', Caption: 'Document Type', TableFieldNo: 1, StringValue: 'Order' },
        ],
      },
    } as BCEvent]);
    const d = createTargetDescriber(repo, () => undefined)({ pageContextId: pc });
    expect(d.keyFields).toEqual([{ fieldNo: 1, caption: 'Document Type', value: 'Order' }, { fieldNo: 3, caption: 'No.', value: '101009' }]);
    expect(d.fields).toBeUndefined();
  });

  it('falls back to the leading card fields on an unbound form', () => {
    const repo = new PageContextRepository();
    const pc = 'session:page:1310:unb00001';
    repo.create(pc, 'F8', { isModal: false, wizardState: null });
    repo.applyToPage(pc, [{
      type: 'FormCreated', formId: 'F8', isReload: false,
      controlTree: { t: 'lf', ServerId: 'F8', PageType: 0, Caption: 'Headline', Metadata: { id: 1310, sourceTableId: 0 },
        Children: [{ t: 'sc', Caption: 'Greeting', StringValue: 'Hi' }] },
    } as BCEvent]);
    const d = createTargetDescriber(repo, () => undefined)({ pageContextId: pc });
    expect(d.keyFields).toBeUndefined();
    expect(d.fields).toEqual({ Greeting: 'Hi' });
  });

  it('resolves rowIndex and bookmarks[]', () => {
    const describe = createTargetDescriber(listRepo(), () => undefined);
    expect(describe({ pageContextId: PC, rowIndex: 0, fields: { Name: 'X' } }).rows?.map(r => r.bookmark)).toEqual(['BM1']);
    expect(describe({ pageContextId: PC, bookmarks: ['BM1', 'BM2'] }).rows?.map(r => r.bookmark)).toEqual(['BM1', 'BM2']);
  });

  it('falls back to BC\'s current row when the call names no row', () => {
    const repo = listRepo();
    const describe = createTargetDescriber(repo, () => undefined);
    expect(describe({ pageContextId: PC, action: 'Post' }).rows).toBeUndefined(); // no cursor yet
    repo.applyToPage(PC, [{ type: 'BookmarkChanged', formId: 'F1', controlPath: 'server:c[0]', bookmark: 'BM2' } as BCEvent]);
    expect(describe({ pageContextId: PC, action: 'Post' }).rows).toEqual([{ bookmark: 'BM2', cells: { 'No.': '20000', Name: 'Trey' } }]);
    expect(describe({ pageContextId: PC, action: 'Post', bookmark: 'BM1' }).rows?.map(r => r.bookmark)).toEqual(['BM1']);
  });

  it('captures the root form\'s record bookmark (PropertyChanged Bookmark on server:)', () => {
    const repo = listRepo();
    repo.applyToPage(PC, [{ type: 'PropertyChanged', formId: 'F1', controlPath: 'server:', changes: { Bookmark: 'ROOT1' } } as BCEvent]);
    expect(createTargetDescriber(repo, () => undefined)({ pageContextId: PC }).page?.bookmark).toBe('ROOT1');
  });

  it('keeps args only when there is no page context (report, company switch, dead context) and drops file payloads', () => {
    const describe = createTargetDescriber(listRepo(), () => 'CRONUS');
    expect(describe({ reportId: '6' })).toMatchObject({ company: 'CRONUS', args: { reportId: '6' } });
    const up = describe({ pageContextId: 'gone', base64: 'AAAA', fileName: 'a.app' });
    expect(up.page).toBeUndefined();
    expect(up.args).toEqual({ pageContextId: 'gone', fileName: 'a.app' });
  });
});

describe('replay gate stores the target descriptor', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-target-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('captures before execute so it survives clearAll(), and surfaces it on OPERATION_IN_DOUBT', async () => {
    const repo = listRepo();
    const execute = vi.fn(async () => { repo.clearAll(); return { ok: false, error: new TimeoutError('watchdog') }; });
    const tool = {
      name: 'bc_execute_action', description: 'd', inputSchema: {},
      zodSchema: z.object({ pageContextId: z.string(), action: z.string(), bookmark: z.string() }),
      execute,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false as const },
    };
    const ledger = new OperationLedger(dir);
    const h = new MCPHandler([tool], { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, [], {
      ledger, describeTarget: createTargetDescriber(repo, () => 'CRONUS'),
    });
    const args = { pageContextId: PC, action: 'Post', bookmark: 'BM1', operationId: 'op-t' };
    const call = () => h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: args } });

    await call();
    const entry = await ledger.get('op-t');
    expect(entry?.status).toBe('unknown');
    expect(entry?.target).toMatchObject({ company: 'CRONUS', page: { pageId: '22' }, rows: [{ bookmark: 'BM1', cells: { 'No.': '10000' } }] });

    const retry = (await call()).result as { structuredContent: Record<string, unknown> };
    expect(retry.structuredContent).toMatchObject({ code: 'OPERATION_IN_DOUBT', target: { args: { action: 'Post' } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
