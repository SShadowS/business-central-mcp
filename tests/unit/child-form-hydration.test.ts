// An embedded part (fhc -> lf) is registered by ChildFormHydrationStrategy only
// after the caller applied the open events, so the open response's changes for the
// part (host formId, refFormId = part) must be replayed. Live cronus28: page 42
// opened without a bookmark sends "Line Discount %" `co[33] {Enabled:true}` that way.
import { describe, it, expect, vi } from 'vitest';
import { ChildFormHydrationStrategy } from '../../src/services/strategies/child-form-hydration.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { repeaters as treeRepeaters } from '../../src/protocol/form-views.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('ChildFormHydrationStrategy', () => {
  it("replays the open response's changes for an embedded part once the part is registered", async () => {
    const openEvents = [
      {
        type: 'FormCreated', formId: 'R', isReload: false,
        controlTree: {
          t: 'lf', ServerId: 'R', PageType: 1,
          Children: [{
            t: 'fhc',
            Children: [{
              t: 'lf', ServerId: 'L', IsSubForm: true, Caption: 'Lines',
              Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Line Discount %', Enabled: false, ColumnBinder: { Name: 'disc' } }] }],
            }],
          }],
        },
      },
      { type: 'PropertyChanged', formId: 'R', refFormId: 'L', controlPath: 'server:c[0]/co[0]', changes: { Enabled: true } },
    ] as BCEvent[];

    const repo = new PageContextRepository();
    repo.create('pc', 'R');
    repo.applyToPage('pc', openEvents);
    const session = { invoke: vi.fn(async () => ok([])) };
    await new ChildFormHydrationStrategy(session as never, repo, logger).hydrate('pc', openEvents);

    const lines = repo.get('pc')!.forms.get('L')!;
    const col = [...treeRepeaters(lines.root).values()][0]!.columns[0]!;
    expect(col.properties.enabled).toBe(true);
  });

  it('keeps ListPart FactBoxes valid and routes each part\'s rows by refFormId', async () => {
    // Live cronus28 Bank Account Card 370 + fixture page 50992: an extension ListPart FactBox and
    // the Notes system part, both repeater-only; BC sends both parts' rows as formId=root server:c[0].
    const listPart = (id: string, caption: string) => ({
      t: 'fhc', Caption: caption,
      Children: [{
        t: 'lf', ServerId: id, IsPart: true, Caption: caption, State: 1,
        Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } }] }],
      }],
    });
    const openEvents = [{
      type: 'FormCreated', formId: 'R', isReload: false,
      controlTree: { t: 'lf', ServerId: 'R', PageType: 0, Children: [listPart('A', 'Bank Connection'), listPart('N', 'Notes')] },
    }] as BCEvent[];
    const rowsFor = (refFormId: string, count: number): BCEvent => ({
      type: 'DataLoaded', formId: 'R', refFormId, controlPath: 'server:c[0]', currentRowOnly: false,
      rows: Array.from({ length: count }, (_, i) => ({ DataRowInserted: [i, { bookmark: `${refFormId}${i}`, cells: { no: { stringValue: String(i) } } }] })),
    } as BCEvent);

    const repo = new PageContextRepository();
    repo.create('pc', 'R');
    repo.applyToPage('pc', openEvents);
    const session = {
      invoke: vi.fn(async (i: { type: string; formId: string }) =>
        ok(i.type === 'LoadForm' ? [rowsFor(i.formId, i.formId === 'A' ? 1 : 0)] : [])),
    };
    await new ChildFormHydrationStrategy(session as never, repo, logger).hydrate('pc', openEvents);

    const ctx = repo.get('pc')!;
    const bank = ctx.sections.get('factbox:Bank Connection')!;
    expect(bank).toMatchObject({ valid: true, repeaterControlPath: 'server:c[0]' });
    expect(ctx.sections.get('factbox:Notes')).toMatchObject({ valid: true });
    expect(ctx.forms.get('A')!.rows.get('server:c[0]')).toHaveLength(1);
    expect(ctx.forms.get('N')!.rows.get('server:c[0]')).toHaveLength(0);
  });

  it('discovers a part on a wizard (DialogOpened root), opens it and keeps the page a NavigatePage', async () => {
    // Live cronus28 fixture page 50990: the NavigatePage root is an ownerless DialogOpened and the
    // step-2 ListPart arrives Built (State=1), so LoadForm must carry openForm:true to load it.
    const openEvents = [
      {
        type: 'DialogOpened', formId: 'W',
        controlTree: {
          t: 'lf', ServerId: 'W', PageType: 9,
          Children: [{
            t: 'fhc', DesignName: 'SetupBankAccountList', Caption: ' ',
            Children: [{
              t: 'lf', ServerId: 'P', IsSubForm: true, IsPart: true, Caption: ' ', State: 1,
              Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } }] }],
            }],
          }],
        },
      },
    ] as BCEvent[];

    const repo = new PageContextRepository();
    repo.create('pc', 'W', { isModal: true });
    repo.applyToPage('pc', openEvents);
    const session = { invoke: vi.fn(async () => ok([])) };
    await new ChildFormHydrationStrategy(session as never, repo, logger).hydrate('pc', openEvents);

    const ctx = repo.get('pc')!;
    expect(ctx.pageType).toBe('NavigatePage');
    expect(ctx.sections.get('lines')).toMatchObject({ formId: 'P', caption: 'SetupBankAccountList' });
    expect(session.invoke).toHaveBeenCalledWith(expect.objectContaining({ type: 'LoadForm', formId: 'P', openForm: true }), expect.anything());
  });
});
