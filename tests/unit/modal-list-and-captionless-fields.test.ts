// tests/unit/modal-list-and-captionless-fields.test.ts
//
// #59: a List page AL opens with RunModal arrives as DialogToShow with its rows inline
// (rc.Data.Rows.LoadedRows) and no DataLoaded after it (live cronus291: page 31 from
// "Select items..." had 49 inline rows). The rows must be readable and writable.
// #58: a ShowCaption=false control has no Caption on the wire (live cronus291: the
// Company Creation Wizard's name box, DesignName "CompanyName") and no Editable flag,
// which BC omits when true. It must be listed by its control name and be writable.
import { describe, it, expect, vi } from 'vitest';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { HANDLER_TYPES } from '../../src/protocol/handler-types.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { registerDialogs } from '../../src/protocol/mutation-result.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { DataService } from '../../src/services/data-service.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const done = { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent;

function hostPage(repo: PageContextRepository): void {
  repo.create('pc:host', 'HOST');
  repo.applyToPage('pc:host', [{ type: 'FormCreated', formId: 'HOST', isReload: false,
    controlTree: { t: 'lf', ServerId: 'HOST', Caption: 'Host', PageType: 0, Children: [] } } as BCEvent]);
}

const row = (bookmark: string, no: string, action: string) => ({ bookmark, cells: { No: { stringValue: no }, Action: { stringValue: action } } });

const importPage = {
  ServerId: '461D', OwnerForm: 'HOST', Caption: 'Import Content', PageType: 1,
  Children: [
    { t: 'gc', Children: [] },
    { t: 'rc', Caption: '', Columns: [
      { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'No' } },
      { t: 'rcc', Caption: 'Action', ColumnBinder: { Name: 'Action' } },
    ], Data: { Rows: { LoadedRows: [row('B1', 'A', 'Create'), row('B2', 'B', 'Replace'), row('B3', 'C', 'Skip')] } } },
    // A hosted part is its own form: its rows are not this dialog's.
    { t: 'fhc', Children: [{ t: 'lf', ServerId: 'PART', Children: [
      { t: 'rc', Columns: [], Data: { Rows: { LoadedRows: [row('X1', 'x', 'x')] } } },
    ] }] },
  ],
};

describe('a RunModal list page shows its inline rows (#59)', () => {
  const decoded = new EventDecoder().decode([{ handlerType: HANDLER_TYPES.LogicalClientEventRaising, parameters: ['DialogToShow', importPage, {}] }]);

  it('the decoder turns the inline rows into a DataLoaded for the dialog repeater only', () => {
    const loaded = decoded.filter(e => e.type === 'DataLoaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ formId: '461D', controlPath: 'server:c[1]', currentRowOnly: false });
  });

  it('the dialog page context reads the rows and writes a row cell by bookmark', async () => {
    const repo = new PageContextRepository();
    hostPage(repo);
    const [dlg] = registerDialogs(repo, 'pc:host', [...decoded, done]);
    const invoke = vi.fn(async (_i: unknown) => ok([done]));
    const data = new DataService({ invoke, invokeSequence: invoke } as never, repo, logger);

    const rows = data.readRows(dlg!.pageContextId);
    expect(rows.ok && rows.value.map(r => [r.bookmark, r.cells['Action']])).toEqual([['B1', 'Create'], ['B2', 'Replace'], ['B3', 'Skip']]);

    const w = await data.writeField(dlg!.pageContextId, 'Action', 'Skip', { bookmark: 'B2' });
    expect(w.ok).toBe(true);
    const sent = invoke.mock.calls.flatMap(c => [c[0]].flat() as Array<{ type: string; formId?: string }>);
    expect(sent.some(i => i.type === 'SaveValue' && i.formId === '461D')).toBe(true);
  });
});

describe('a caption-less control is named by its control name (#58)', () => {
  const wizard = {
    t: 'lf', ServerId: 'WIZ', Caption: 'Create New Company', PageType: 9,
    Children: [{ t: 'gc', Children: [
      { t: 'ssc', Caption: 'Enter a name for the company.', Editable: false },
      { t: 'sc', DesignName: 'CompanyName', ShowCaption: false, StringValue: '' },
      { t: 'ssc', Editable: false },
    ] }],
  };

  function wizardPage(): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create('pc:wiz', 'WIZ');
    repo.applyToPage('pc:wiz', [{ type: 'FormCreated', formId: 'WIZ', isReload: false, controlTree: wizard } as BCEvent]);
    return repo;
  }

  it('lists it under its DesignName, editable when BC omits Editable', () => {
    const ctx = wizardPage().get('pc:wiz')!;
    const section = buildSection(ctx, 'header');
    expect(section?.fields?.map(f => [f.name, f.editable])).toEqual([
      ['Enter a name for the company.', false],
      ['CompanyName', true],
    ]);
  });

  it('bc_write_data addresses it by that name', async () => {
    const repo = wizardPage();
    const invoke = vi.fn(async () => ok([{ type: 'PropertyChanged', formId: 'WIZ', controlPath: 'server:c[0]/c[1]', changes: { StringValue: 'Test Co' } }, done] as BCEvent[]));
    const w = await new DataService({ invoke } as never, repo, logger).writeField('pc:wiz', 'companyname', 'Test Co');
    expect(w.ok).toBe(true);
    expect((invoke.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'SaveValue', formId: 'WIZ', controlPath: 'server:c[0]/c[1]' });
  });
});
