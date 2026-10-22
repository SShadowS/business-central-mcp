// PR #45 point 2: SaveValue on a control that is not visible, enabled or editable
// is a silent no-op in BC (SaveValueInteraction.InvokeCore returns early, no echo,
// no error). bc_write_data must fail that field and send nothing; a write BC does
// not echo is reported as not confirmed.
import { describe, it, expect, vi } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function open(pcId: string, formId: string, lf: Record<string, unknown>) {
  const repo = new PageContextRepository();
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{
    type: 'FormCreated', formId, isReload: false,
    controlTree: { t: 'lf', ServerId: formId, PageType: 1, ...lf },
  } as BCEvent]);
  return repo;
}

function service(repo: PageContextRepository, events: BCEvent[] = []) {
  const invoke = vi.fn(async (_interaction: { type: string }) => ok(events));
  return { data: new DataService({ invoke } as never, repo, logger), invoke };
}

const echo = (formId: string, controlPath: string, value: string): BCEvent =>
  ({ type: 'PropertyChanged', formId, controlPath, changes: { StringValue: value } }) as BCEvent;

const card = open('pc:card', 'F1', {
  Children: [
    { t: 'sc', Caption: 'Name', Editable: true, StringValue: 'Old' },
    { t: 'sc', Caption: 'No.', Editable: false },
    { t: 'sc', Caption: 'Hidden Code', Editable: true, Visible: false },
    { t: 'sc', Caption: 'Greyed Out', Editable: true, Enabled: false },
    { t: 'sc', Caption: 'Everything Wrong', Visible: false, Enabled: false, Editable: false },
    { t: 'sc', Caption: 'Defaults' },
  ],
});

describe('DataService.writeField on a card field BC would ignore', () => {
  it.each([
    ['No.', /not editable/],
    ['Hidden Code', /hidden \(Visible=false/],
    ['Greyed Out', /disabled \(Enabled=false/],
  ])("fails '%s' with a clear error and sends nothing", async (name, message) => {
    const { data, invoke } = service(card);
    const res = await data.writeField('pc:card', name, 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain(`Field '${name}'`);
      expect(res.error.message).toMatch(message);
      expect(res.error.message).toContain('nothing was sent');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('names every reason when a field is hidden, disabled and not editable', async () => {
    const { data, invoke } = service(card);
    const res = await data.writeField('pc:card', 'Everything Wrong', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/hidden.*disabled.*not editable/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('writes a field that is explicitly editable', async () => {
    const { data, invoke } = service(card, [echo('F1', 'server:c[0]', 'New')]);
    const res = await data.writeField('pc:card', 'Name', 'New');
    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toMatchObject({ type: 'SaveValue', formId: 'F1', controlPath: 'server:c[0]', newValue: 'New' });
  });

  it('writes a field that publishes none of the three properties (BC omits a true value)', async () => {
    const { data, invoke } = service(card);
    const res = await data.writeField('pc:card', 'Defaults', 'x');
    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('picks up an Editable change BC pushed after the page opened', async () => {
    const repo = open('pc:flip', 'F1', { Children: [{ t: 'sc', Caption: 'Name', Editable: false }] });
    const { data, invoke } = service(repo);
    expect((await data.writeField('pc:flip', 'Name', 'x')).ok).toBe(false);
    repo.applyToPage('pc:flip', [{ type: 'PropertyChanged', formId: 'F1', controlPath: 'server:c[0]', changes: { Editable: true } } as BCEvent]);
    expect((await data.writeField('pc:flip', 'Name', 'x')).ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('bc_write_data with a mix of writable and non-writable fields', () => {
  it('fails only the unwritable field and sends SaveValue for the rest', async () => {
    const { data, invoke } = service(card, [echo('F1', 'server:c[0]', 'New')]);
    const op = new WriteDataOperation(data, card);
    const res = await op.execute({ pageContextId: 'pc:card', fields: { 'No.': '10', Name: 'New' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(invoke).toHaveBeenCalledOnce();
    expect(res.value.allSucceeded).toBe(false);
    expect(res.value.replaySafe).toBe(false);
    expect(res.value.results[0]).toMatchObject({ fieldName: 'No.', success: false, controlPath: '' });
    expect(res.value.results[0]!.error).toContain('not editable');
    expect(res.value.results[1]).toMatchObject({ fieldName: 'Name', success: true, echoed: true });
    expect(res.value.results[1]!.warning).toBeUndefined();
  });
});

describe('dialogs and request pages', () => {
  const requestPage = () => open('pc:rp', 'RP1', {
    MappingHint: 'RequestPage',
    Children: [{
      t: 'gc',
      Children: [
        { t: 'sc', Caption: 'Maximum rows', Editable: true, StringValue: '' },
        { t: 'sc', Caption: 'Starting date' },
        { t: 'sc', Caption: 'Read only total', Editable: false },
      ],
    }],
  });

  it('still writes legitimately editable request-page fields, with or without an explicit Editable', async () => {
    const repo = requestPage();
    const { data, invoke } = service(repo, [echo('RP1', 'server:c[0]/c[0]', '5')]);
    const op = new WriteDataOperation(data, repo);
    const res = await op.execute({ pageContextId: 'pc:rp', fields: { 'Maximum rows': '5', 'Starting date': '010125' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(res.value.results.every(r => r.success)).toBe(true);
  });

  it('fails a read-only dialog field through its own page context', async () => {
    const repo = requestPage();
    const { data, invoke } = service(repo);
    const res = await data.writeField('pc:rp', 'Read only total', '1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("Field 'Read only total' is not editable");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('DataService.writeField when BC sends no echo', () => {
  it('reports success with echoed=false and a not-confirmed warning', async () => {
    const { data } = service(card, [{ type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
    const res = await data.writeField('pc:card', 'Name', 'Old');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ success: true, echoed: false });
    expect(res.value.warning).toContain('not confirmed');
    expect(res.value.warning).toContain("'Name'");
  });

  it('has no warning when BC echoed the value', async () => {
    const { data } = service(card, [echo('F1', 'server:c[0]', 'New')]);
    const res = await data.writeField('pc:card', 'Name', 'New');
    expect(res.ok && res.value.echoed).toBe(true);
    expect(res.ok && res.value.warning).toBeUndefined();
  });
});

describe('DataService line cell writes', () => {
  const lines = () => open('pc:lines', 'F1', {
    Children: [{
      t: 'rc',
      Columns: [
        { t: 'rcc', Caption: 'Bin Code', ColumnBinder: { Name: 'bin' } },
        { t: 'rcc', Caption: 'Zone Code', Visible: false, ColumnBinder: { Name: 'zone' } },
        { t: 'rcc', Caption: 'Locked', Editable: false, ColumnBinder: { Name: 'locked' } },
        { t: 'rcc', Caption: 'Off', Enabled: false, ColumnBinder: { Name: 'off' } },
      ],
    }],
  });

  it('a hidden column (page 393 bin columns) fails as hidden and sends nothing, not even the row selection', async () => {
    const { data, invoke } = service(lines());
    const res = await data.writeField('pc:lines', 'Zone Code', 'Z1', { bookmark: 'B1' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Column 'Zone Code' is hidden");
      expect(res.error.message).toContain('nothing was sent');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['Locked', /not editable/],
    ['Off', /disabled/],
  ])("a '%s' column fails and sends nothing", async (name, message) => {
    const { data, invoke } = service(lines());
    const res = await data.writeField('pc:lines', name, 'x', { bookmark: 'B1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(message);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('writes a visible, enabled column: SetCurrentRow then SaveValue on the cell', async () => {
    const repo = lines();
    const invoke = vi.fn(async (interaction: { type: string }) =>
      ok(interaction.type === 'SaveValue' ? [echo('F1', 'server:c[0]/cr/c[0]', 'BIN1')] : []));
    const data = new DataService({ invoke } as never, repo, logger);
    const res = await data.writeField('pc:lines', 'Bin Code', 'BIN1', { bookmark: 'B1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(invoke.mock.calls.map(c => c[0].type)).toEqual(['SetCurrentRow', 'SaveValue']);
    expect(res.value).toMatchObject({ success: true, echoed: true, controlPath: 'server:c[0]/cr/c[0]' });
    expect(res.value.warning).toBeUndefined();
  });

  it('a cell write BC does not echo is reported as not confirmed', async () => {
    const { data } = service(lines());
    const res = await data.writeField('pc:lines', 'Bin Code', 'BIN1', { bookmark: 'B1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ success: true, echoed: false });
    expect(res.value.warning).toContain('not confirmed');
  });

  it('an unknown column is still reported before anything is sent', async () => {
    const { data, invoke } = service(lines());
    const res = await data.writeField('pc:lines', 'Nope', 'x', { bookmark: 'B1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("Column 'Nope' not found");
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a cell BC marked not editable on this row fails; another row of the same column writes', async () => {
    const repo = lines();
    repo.applyToPage('pc:lines', [{
      type: 'DataLoaded', formId: 'F1', controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [
        { DataRowInserted: [0, { bookmark: 'B1', cells: { bin: { stringValue: 'A', editable: false } } }] },
        { DataRowInserted: [1, { bookmark: 'B2', cells: { bin: { stringValue: 'B' } } }] },
      ],
    } as BCEvent]);
    const { data, invoke } = service(repo);
    const locked = await data.writeField('pc:lines', 'Bin Code', 'X', { bookmark: 'B1' });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.message).toContain('not editable (Editable=false) on this row');
    expect(invoke).not.toHaveBeenCalled();
    expect((await data.writeField('pc:lines', 'Bin Code', 'X', { rowIndex: 1 })).ok).toBe(true);
  });
});

describe('document lines subpage after Edit', () => {
  // Live cronus28, Sales Order 42: the lines columns open as Editable=false (view
  // mode); Edit flips them with PropertyChanged on the HOST formId whose
  // refFormId names the lines form, at the lines-form-relative column path.
  const doc = () => {
    const repo = open('pc:so', 'R', { Children: [{ t: 'sc', Caption: 'No.' }] });
    repo.applyToPage('pc:so', [{
      type: 'FormCreated', formId: 'L', parentFormId: 'R',
      controlTree: {
        t: 'lf', ServerId: 'L', PageType: 0, Caption: 'Lines',
        Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Quantity', Editable: false, ColumnBinder: { Name: 'qty' } }] }],
      },
    } as BCEvent]);
    return repo;
  };

  it('refuses a line write in view mode, then writes once the host-routed Editable flip arrives', async () => {
    const repo = doc();
    const { data, invoke } = service(repo);
    const before = await data.writeField('pc:so', 'Quantity', '2', { sectionId: 'lines', bookmark: 'B1' });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.message).toContain('not editable');

    repo.applyToPage('pc:so', [{
      type: 'PropertyChanged', formId: 'R', refFormId: 'L', controlPath: 'server:c[0]/co[0]', changes: { Editable: true },
    } as BCEvent]);
    const after = await data.writeField('pc:so', 'Quantity', '2', { sectionId: 'lines', bookmark: 'B1' });
    expect(after.ok).toBe(true);
    expect(invoke.mock.calls.map(c => c[0].type)).toEqual(['SetCurrentRow', 'SaveValue']);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ formId: 'L' });
  });
});

describe('wizard step fields', () => {
  // BC publishes an inactive step's controls as Visible=false and does not
  // re-publish them when our step machine activates the step (Continia 6175295).
  it('writes a field of the active step despite its stale Visible=false', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:wiz', 'W', { isModal: true, wizardState: { stepPaths: ['server:c[0]', 'server:c[1]'], currentStepIndex: 1 } });
    repo.applyToPage('pc:wiz', [{
      type: 'FormCreated', formId: 'W', isReload: false,
      controlTree: {
        t: 'lf', ServerId: 'W', PageType: 1,
        Children: [
          { t: 'gc', DesignName: 'Step1', Children: [{ t: 'sc', Caption: 'Intro' }] },
          { t: 'gc', DesignName: 'Step2', Visible: false, Children: [{ t: 'sc', Caption: 'Company Name', Visible: false }] },
        ],
      },
    } as BCEvent]);
    const { data, invoke } = service(repo);
    expect((await data.writeField('pc:wiz', 'Company Name', 'Acme')).ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
