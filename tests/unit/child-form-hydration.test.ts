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
