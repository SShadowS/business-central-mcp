// tests/unit/key-by-design-name.test.ts
//
// Opt-in keyBy: 'designName' for bc_read_data. Default (omitted / blank /
// 'caption') must stay byte-identical to the historical caption keying.

import { describe, it, expect, vi } from 'vitest';
import {
  buildBinderToCaptionMap,
  buildColumnMetadata,
  mapRowCellKeys,
  resolveKeyBy,
  DEFAULT_KEY_BY,
  findColumnNode,
  availableColumnNames,
} from '../../src/protocol/row-mapping.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, RepeaterColumn, RepeaterRow } from '../../src/protocol/types.js';

const cols: RepeaterColumn[] = [
  { controlPath: 'a', caption: 'Nr.', type: 'rcc', columnBinderName: 'c1', designName: 'No.', controlIdentifier: 'id1', tableFieldNo: 1, columnBinderPath: '18_Customer.1' },
  { controlPath: 'b', caption: 'Naam', type: 'rcc', columnBinderName: 'c2', designName: 'Name' },
  { controlPath: 'c', caption: 'Hoeveelheid', type: 'rcc', columnBinderName: 'c3' },            // no DesignName
  { controlPath: 'd', caption: 'Naam', type: 'rcc', columnBinderName: 'c4', designName: 'Name' }, // duplicate
  { controlPath: 'e', caption: '', type: 'rcc', columnBinderName: 'c5' },                       // nothing
];

describe('row-mapping keyBy', () => {
  it('defaults to caption', () => {
    expect(DEFAULT_KEY_BY).toBe('caption');
    expect(resolveKeyBy(undefined)).toBe('caption');
    expect(resolveKeyBy('')).toBe('caption');
    expect(resolveKeyBy('bogus')).toBe('caption');
    expect(resolveKeyBy('designName')).toBe('designName');
  });

  it('caption keying is unchanged when keyBy is omitted', () => {
    const legacy = buildBinderToCaptionMap(cols);
    expect([...legacy.entries()]).toEqual([
      ['c1', 'Nr.'], ['c2', 'Naam'], ['c3', 'Hoeveelheid'], ['c4', 'Naam#2'], ['c5', 'c5'],
    ]);
    expect(buildBinderToCaptionMap(cols, 'caption')).toEqual(legacy);
  });

  it('designName keying falls back to caption, then binder name, and dedupes', () => {
    const m = buildBinderToCaptionMap(cols, 'designName');
    expect(Object.fromEntries(m)).toEqual({ c1: 'No.', c2: 'Name', c3: 'Hoeveelheid', c4: 'Name#2', c5: 'c5' });
  });

  it('designName keying gives DesignName-backed keys first pick before "#n"', () => {
    const m = buildBinderToCaptionMap([
      { controlPath: 'a', caption: 'Name', type: 'rcc', columnBinderName: 'c1' },                    // caption fallback
      { controlPath: 'b', caption: 'Naam', type: 'rcc', columnBinderName: 'c2', designName: 'Name' },
    ], 'designName');
    expect(m.get('c2')).toBe('Name');
    expect(m.get('c1')).toBe('Name#2');
  });

  it('mapRowCellKeys keys rows by designName', () => {
    const rows: RepeaterRow[] = [{ bookmark: 'b1', cells: { c1: { stringValue: '10000' }, c2: 'Contoso' } }];
    expect(mapRowCellKeys(rows, cols, 'designName')).toEqual([{ bookmark: 'b1', cells: { 'No.': '10000', Name: 'Contoso' } }]);
    expect(mapRowCellKeys(rows, cols)).toEqual([{ bookmark: 'b1', cells: { 'Nr.': '10000', Naam: 'Contoso' } }]);
  });

  it('buildColumnMetadata describes each key', () => {
    const meta = buildColumnMetadata(cols, 'designName');
    expect(meta[0]).toEqual({ key: 'No.', caption: 'Nr.', designName: 'No.', controlIdentifier: 'id1', tableFieldNo: 1, binderPath: '18_Customer.1' });
    expect(meta[3]).toEqual({ key: 'Name#2', caption: 'Naam', designName: 'Name' });
  });

  it('findColumnNode: caption only by default; DesignName first, then caption, in designName mode', () => {
    const a = { type: 'rcc', controlPath: 'a', properties: { caption: 'Naam', designName: 'Name' } } as any;
    const b = { type: 'rcc', controlPath: 'b', properties: { caption: 'Name', designName: 'Description' } } as any;
    expect(findColumnNode([a, b], 'naam')).toBe(a);
    expect(findColumnNode([a, b], 'name')).toBe(b);               // caption mode: caption "Name"
    expect(findColumnNode([a, b], 'name', 'designName')).toBe(a); // DesignName wins
    expect(findColumnNode([a, b], 'naam', 'designName')).toBe(a); // caption fallback
    expect(availableColumnNames([a, b])).toEqual(['Naam', 'Name']);
    expect(availableColumnNames([a, b], 'designName')).toEqual(['Name', 'Description']);
  });
});

describe('form-tree-builder rcc TableFieldNo', () => {
  it('captures TableFieldNo and DesignName on repeater columns', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F', Children: [{ t: 'rc', Columns: [
        { t: 'rcc', Caption: 'Nr.', DesignName: 'No.', TableFieldNo: 1, ColumnBinder: { Name: 'c1' } },
      ] }],
    } as any);
    const rc = (root as any).children[0];
    expect(rc.columns[0].tableFieldNo).toBe(1);
    expect(rc.columns[0].properties.designName).toBe('No.');
  });
});

function makeListCtx(repo: PageContextRepository) {
  repo.create('pc:1', 'F1');
  repo.applyToPage('pc:1', [{
    type: 'FormCreated', formId: 'F1', isReload: false,
    controlTree: {
      t: 'lf', ServerId: 'F1', PageType: 1, Caption: 'Klanten',
      Children: [{ t: 'rc', Columns: [
        { t: 'rcc', Caption: 'Nr.', DesignName: 'No.', TableFieldNo: 1, ColumnBinder: { Name: 'c1' }, ColumnBinderPath: '18.1' },
        { t: 'rcc', Caption: 'Naam', DesignName: 'Name', ColumnBinder: { Name: 'c2' }, ColumnBinderPath: '18.2' },
      ] }],
    },
  } as BCEvent, {
    type: 'DataLoaded', formId: 'F1', controlPath: 'server:c[0]', currentRowOnly: false,
    rows: [{ DataRowInserted: [0, { bookmark: 'bk1', cells: { c1: '10000', c2: 'Contoso' } }] }],
  } as BCEvent]);
}

function makeCardCtx(repo: PageContextRepository) {
  repo.create('pc:2', 'F2');
  repo.applyToPage('pc:2', [{
    type: 'FormCreated', formId: 'F2', isReload: false,
    controlTree: { t: 'lf', ServerId: 'F2', PageType: 2, Caption: 'Klant', Children: [
      { t: 'sc', Caption: 'Naam', DesignName: 'Name', Editable: true, Visible: true },
      { t: 'sc', Caption: 'Plaats', Editable: true, Visible: true },
    ] },
  } as BCEvent]);
}

function makeOp(repo: PageContextRepository, sort = { applySort: vi.fn(async () => ok(undefined as any)) }) {
  const data = { readRows: vi.fn(() => ok([])), getRepeaterTotalRowCount: vi.fn(() => null), getTabs: vi.fn(() => ok(null)), scrollRepeater: vi.fn() } as any;
  const filter = { applyFilters: vi.fn(async () => ok(undefined as any)), clearFilters: vi.fn() } as any;
  return { op: new ReadDataOperation(data, filter, sort as any, repo), filter, sort };
}

describe('ReadDataOperation keyBy', () => {
  it('default output is caption-keyed with no metadata', async () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    for (const keyBy of [undefined, '', 'caption'] as const) {
      const r = await makeOp(repo).op.execute({ pageContextId: 'pc:1', section: 'header', ...(keyBy !== undefined ? { keyBy } : {}) });
      if (!r.ok) throw r.error;
      expect(r.value.section.rows).toEqual([{ bookmark: 'bk1', cells: { 'Nr.': '10000', Naam: 'Contoso' } }]);
      expect(r.value.section.columns).toBeUndefined();
    }
  });

  it('keyBy designName keys rows by DesignName; columns accept caption or designName', async () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    const r = await makeOp(repo).op.execute({ pageContextId: 'pc:1', keyBy: 'designName', columns: ['Nr.', 'name'] });
    if (!r.ok) throw r.error;
    expect(r.value.section.rows).toEqual([{ bookmark: 'bk1', cells: { 'No.': '10000', Name: 'Contoso' } }]);
    expect(r.value.section.columns).toBeUndefined();
  });

  it('includeColumnMetadata returns column metadata', async () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    const r = await makeOp(repo).op.execute({ pageContextId: 'pc:1', keyBy: 'designName', includeColumnMetadata: true });
    if (!r.ok) throw r.error;
    expect(r.value.section.columns).toEqual([
      { key: 'No.', caption: 'Nr.', designName: 'No.', tableFieldNo: 1, binderPath: '18.1' },
      { key: 'Name', caption: 'Naam', designName: 'Name', binderPath: '18.2' },
    ]);
  });

  it('passes keyBy to sort/filter only in designName mode', async () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    const { op, filter, sort } = makeOp(repo);
    await op.execute({ pageContextId: 'pc:1', keyBy: 'designName', sort: { column: 'Name', direction: 'asc' }, filters: [{ column: 'No.', value: '1' }] });
    expect(sort.applySort).toHaveBeenCalledWith('pc:1', 'Name', 'asc', undefined, 'designName');
    expect(filter.applyFilters).toHaveBeenCalledWith('pc:1', [{ column: 'No.', value: '1' }], undefined, 'designName');
  });

  it('card fields: name = DesignName (fallback caption) plus caption/designName', async () => {
    const repo = new PageContextRepository(); makeCardCtx(repo);
    const legacy = await makeOp(repo).op.execute({ pageContextId: 'pc:2' });
    if (!legacy.ok) throw legacy.error;
    expect(legacy.value.section.fields!.map(f => f.name)).toEqual(['Naam', 'Plaats']);
    expect(legacy.value.section.fields![0]).not.toHaveProperty('caption');
    const r = await makeOp(repo).op.execute({ pageContextId: 'pc:2', keyBy: 'designName', columns: ['naam', 'Plaats'] });
    if (!r.ok) throw r.error;
    expect(r.value.section.fields!.map(f => [f.name, f.caption, f.designName])).toEqual([
      ['Name', 'Naam', 'Name'], ['Plaats', 'Plaats', undefined],
    ]);
  });
});

import { findField } from '../../src/protocol/form-views.js';
import { buildAllSections, sectionOptionsFrom } from '../../src/protocol/section-dto.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { LookupOperation } from '../../src/operations/lookup.js';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { WizardNavigateOperation } from '../../src/operations/wizard-navigate.js';
import { detectDialogs } from '../../src/protocol/mutation-result.js';
import { OpenPageSchema, WriteDataSchema, LookupSchema, NavigateSchema, GetOperationSchema, ExecuteActionSchema, WizardNavigateSchema, toMcpJsonSchema } from '../../src/mcp/schemas.js';

describe('keyBy beyond bc_read_data', () => {
  it('sectionOptionsFrom: omitted / blank / caption produce no options', () => {
    expect(sectionOptionsFrom({})).toEqual({});
    expect(sectionOptionsFrom({ keyBy: '' })).toEqual({});
    expect(sectionOptionsFrom({ keyBy: 'caption' })).toEqual({});
    expect(sectionOptionsFrom({ keyBy: 'designName', includeColumnMetadata: true })).toEqual({ keyBy: 'designName', includeColumnMetadata: true });
  });

  it('findField: DesignName first, then caption, only in designName mode', () => {
    const repo = new PageContextRepository(); makeCardCtx(repo);
    const root = repo.get('pc:2')!.forms.get('F2')!.root;
    expect(findField(root, 'Name')).toBeUndefined();
    expect(findField(root, 'name', 'designName')?.properties.caption).toBe('Naam');
    expect(findField(root, 'Plaats', 'designName')?.properties.caption).toBe('Plaats');
    expect(findField(root, 'Naam')?.properties.caption).toBe('Naam');
  });

  it('buildAllSections (bc_open_page / bc_navigate) honours keyBy and metadata', () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    const ctx = repo.get('pc:1')!;
    expect(buildAllSections(ctx)).toEqual(buildAllSections(ctx, sectionOptionsFrom({ keyBy: '' })));
    const [s] = buildAllSections(ctx, { keyBy: 'designName', includeColumnMetadata: true });
    expect(s!.rows![0]!.cells).toEqual({ 'No.': '10000', Name: 'Contoso' });
    expect(s!.columns!.map(c => c.key)).toEqual(['No.', 'Name']);
    expect(buildAllSections(ctx)[0]!.columns).toBeUndefined();
  });

  it('describeTarget keys target rows by the call\'s keyBy', () => {
    const repo = new PageContextRepository(); makeListCtx(repo);
    const d = createTargetDescriber(repo, () => 'CRONUS')({ pageContextId: 'pc:1', bookmark: 'bk1', keyBy: 'designName' });
    expect(d.rows).toEqual([{ bookmark: 'bk1', cells: { 'No.': '10000', Name: 'Contoso' } }]);
  });

  it('bc_wizard_navigate keys fields[].name by DesignName; dialog fields carry designName', async () => {
    const repo = new PageContextRepository(); makeCardCtx(repo);
    const actions = { executeWizardNav: vi.fn(async () => ok({ success: true, events: [] })) } as any;
    const op = new WizardNavigateOperation(actions, repo, { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any);
    const names = async (keyBy?: 'designName') => {
      const r = await op.execute({ pageContextId: 'pc:2', action: 'next', keyBy });
      if (!r.ok) throw r.error;
      return r.value.fields.map(f => f.name);
    };
    expect(await names()).toEqual(['Naam', 'Plaats']);
    expect(await names('designName')).toEqual(['Name', 'Plaats']);
    const [d] = detectDialogs([{ type: 'DialogOpened', formId: 'D1', controlTree: { Children: [{ t: 'sc', Caption: 'Naam', DesignName: 'Name' }] } } as BCEvent]);
    expect(d!.fields![0]).toMatchObject({ caption: 'Naam', designName: 'Name' });
  });

  it('bc_write_data forwards keyBy only in designName mode', async () => {
    const writeFields = vi.fn(async () => ok({ results: [], events: [] }));
    const repo = new PageContextRepository(); makeCardCtx(repo);
    const op = new WriteDataOperation({ writeFields } as any, repo);
    await op.execute({ pageContextId: 'pc:2', fields: { Name: 'X' } });
    await op.execute({ pageContextId: 'pc:2', fields: { Name: 'X' }, keyBy: '' });
    await op.execute({ pageContextId: 'pc:2', fields: { Name: 'X' }, keyBy: 'designName' });
    expect(writeFields.mock.calls.map((c: any[]) => c[2])).toEqual([
      { sectionId: undefined, rowIndex: undefined, bookmark: undefined },
      { sectionId: undefined, rowIndex: undefined, bookmark: undefined },
      { sectionId: undefined, rowIndex: undefined, bookmark: undefined, keyBy: 'designName' },
    ]);
  });

  it('bc_lookup forwards keyBy only in designName mode', async () => {
    const lookup = vi.fn(async () => ok({ rows: [], totalFound: 0 }));
    const op = new LookupOperation({ lookup } as any);
    await op.execute({ pageContextId: 'p', field: 'Naam' });
    await op.execute({ pageContextId: 'p', field: 'Name', keyBy: 'designName' });
    expect(lookup.mock.calls.map((c: any[]) => c[2])).toEqual([
      { search: undefined, maxRows: undefined },
      { search: undefined, maxRows: undefined, keyBy: 'designName' },
    ]);
  });

  it('schemas accept keyBy and advertise it', () => {
    for (const [schema, extra] of [
      [OpenPageSchema, { pageId: '21' }], [WriteDataSchema, { pageContextId: 'p', fields: { a: 'b' } }],
      [LookupSchema, { pageContextId: 'p', field: 'f' }], [NavigateSchema, { pageContextId: 'p', bookmark: 'b' }],
      [GetOperationSchema, { operationId: 'o' }], [ExecuteActionSchema, { pageContextId: 'p', action: 'a' }],
      [WizardNavigateSchema, { pageContextId: 'p', action: 'next' }],
    ] as const) {
      expect((schema as any).safeParse({ ...extra, keyBy: 'designName' }).success).toBe(true);
      expect((schema as any).safeParse({ ...extra, keyBy: '' }).success).toBe(false);
      expect((schema as any).safeParse({ ...extra, keyBy: 'bogus' }).success).toBe(false);
      expect((toMcpJsonSchema(schema as any) as any).properties.keyBy).toBeDefined();
    }
  });
});
