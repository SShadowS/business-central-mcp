import { describe, it, expect } from 'vitest';
import { FormProjection } from '../../src/protocol/form-state.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    formId: 'f1',
    controlTree: [],
    repeaters: new Map(),
    actions: [],
    filterControlPath: null,
    ...overrides,
  };
}

function makeRepeaterForm(): FormState {
  return makeForm({
    repeaters: new Map([
      ['server:c[1]', {
        controlPath: 'server:c[1]',
        columns: [{ controlPath: 'server:c[1]/co[0]', caption: 'No.', type: 'rcc' }],
        rows: [],
        totalRowCount: null,
        currentBookmark: null,
      }],
    ]),
  });
}

describe('FormProjection', () => {
  const projection = new FormProjection();

  it('applies DataLoaded to matching repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: false,
      rows: [
        { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' }, bookmark: 'bm1' }] },
        { t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': '20000' }, bookmark: 'bm2' }] },
      ],
    };
    const updated = projection.apply(form, event);
    const rep = updated.repeaters.get('server:c[1]')!;
    expect(rep.rows).toHaveLength(2);
    expect(rep.rows[0]!.bookmark).toBe('bm1');
    expect(rep.totalRowCount).toBeNull(); // not inferred from rows.length
  });

  it('ignores DataLoaded for unknown controlPath', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[99]',
      currentRowOnly: false, rows: [],
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.rows).toHaveLength(0);
  });

  it('merges currentRowOnly DataLoaded by bookmark', () => {
    const form = makeForm({
      repeaters: new Map([['server:c[1]', {
        controlPath: 'server:c[1]', columns: [], totalRowCount: null, currentBookmark: null,
        rows: [{ bookmark: 'bm1', cells: { 'No.': '10000' } }, { bookmark: 'bm2', cells: { 'No.': '20000' } }],
      }]]),
    });
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowUpdated', DataRowUpdated: [0, { cells: { 'No.': '10001' }, bookmark: 'bm1' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.repeaters.get('server:c[1]')!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cells['No.']).toBe('10001');
    expect(rows[1]!.cells['No.']).toBe('20000');
  });

  it('applies PropertyChanged TotalRowCount to repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
      changes: { TotalRowCount: 42 },
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.totalRowCount).toBe(42);
  });

  it('applies PropertyChanged to controlTree fields', () => {
    const form = makeForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]/c[1]',
      changes: { StringValue: 'Hello', Caption: 'Name', Editable: true, Visible: true },
    };
    const updated = projection.apply(form, event);
    const field = updated.controlTree.find(f => f.controlPath === 'server:c[0]/c[1]');
    expect(field).toBeDefined();
    expect(field!.stringValue).toBe('Hello');
    expect(field!.caption).toBe('Name');
  });

  it('applies BookmarkChanged to correct repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'BookmarkChanged', formId: 'f1', controlPath: 'server:c[1]', bookmark: 'bm5',
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.currentBookmark).toBe('bm5');
  });

  it('creates initial FormState', () => {
    const form = projection.createInitial('myForm', 'parentForm');
    expect(form.formId).toBe('myForm');
    expect(form.parentFormId).toBe('parentForm');
    expect(form.controlTree).toEqual([]);
    expect(form.repeaters.size).toBe(0);
    expect(form.actions).toEqual([]);
    expect(form.filterControlPath).toBeNull();
  });

  it('updates existing field on repeated PropertyChanged', () => {
    let form = makeForm();
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]',
      changes: { StringValue: 'first', Caption: 'Field1' },
    } as BCEvent);
    expect(form.controlTree.length).toBe(1);
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]',
      changes: { StringValue: 'second' },
    } as BCEvent);
    expect(form.controlTree.length).toBe(1);
    expect(form.controlTree[0]!.stringValue).toBe('second');
    expect(form.controlTree[0]!.caption).toBe('Field1'); // preserved from first
  });
});
