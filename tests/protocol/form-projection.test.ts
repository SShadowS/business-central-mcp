import { describe, it, expect } from 'vitest';
import { FormProjection } from '../../src/protocol/form-state.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import {
  fields as treeFields, repeaters as treeRepeaters,
} from '../../src/protocol/form-views.js';

function makeForm(overrides: Partial<FormState> = {}): FormState {
  const root = buildFormTree({ t: 'lf', ServerId: 'f1', PageType: 0, Children: [] });
  return {
    formId: 'f1',
    root,
    rows: new Map(),
    ...overrides,
  };
}

/** Creates a form whose tree contains a repeater at server:c[1] with one column.
 * A dummy group at c[0] pushes the repeater to index 1, matching the original
 * test controlPath `server:c[1]`. */
function makeRepeaterForm(): FormState {
  const root = buildFormTree({
    t: 'lf', ServerId: 'f1', PageType: 1,
    Children: [
      { t: 'gc', Children: [] },  // c[0] — dummy group
      { t: 'rc', Children: [], Columns: [{ t: 'rcc', Caption: 'No.' }] },  // c[1] — repeater
    ],
  });
  return {
    formId: 'f1',
    root,
    rows: new Map(),
  };
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
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.bookmark).toBe('bm1');
    // totalRowCount lives on the tree node, not in rows map
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.totalRowCount ?? null).toBeNull(); // not inferred from rows.length
  });

  it('ignores DataLoaded for unknown controlPath', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[99]',
      currentRowOnly: false, rows: [],
    };
    const updated = projection.apply(form, event);
    expect(updated.rows.get('server:c[1]') ?? []).toHaveLength(0);
  });

  it('merges currentRowOnly DataLoaded by bookmark', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
        { bookmark: 'bm2', cells: { 'No.': '20000' } },
      ]]]),
    };
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowUpdated', DataRowUpdated: [0, { cells: { 'No.': '10001' }, bookmark: 'bm1' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cells['No.']).toBe('10001');
    expect(rows[1]!.cells['No.']).toBe('20000');
  });

  it('currentRowOnly DataLoaded appends a re-bookmarked row instead of dropping it', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [{ bookmark: 'draft1', cells: { 'No.': '' } }]]]),
    };
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
      rows: [{ t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' }, bookmark: 'committed1' }] }],
    };
    const rows = projection.apply(form, event).rows.get('server:c[1]')!;
    expect(rows.map(r => r.bookmark)).toContain('committed1');
  });

  it('applies RowDelta remove by bookmark', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
        { bookmark: 'bm2', cells: { 'No.': '20000' } },
      ]]]),
    };
    const event: BCEvent = { type: 'RowDelta', formId: 'f1', controlPath: 'server:c[1]', op: 'remove', bookmark: 'bm1' };
    const rows = projection.apply(form, event).rows.get('server:c[1]')!;
    expect(rows.map(r => r.bookmark)).toEqual(['bm2']);
  });

  it('applies RowDelta update by bookmark', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [{ bookmark: 'bm1', cells: { 'No.': '10000' } }]]]),
    };
    const event: BCEvent = { type: 'RowDelta', formId: 'f1', controlPath: 'server:c[1]', op: 'update', bookmark: 'bm1', cells: { 'No.': '10009' } };
    const rows = projection.apply(form, event).rows.get('server:c[1]')!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells['No.']).toBe('10009');
  });

  it('applies RowDelta insert at the given viewport index', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
        { bookmark: 'bm3', cells: { 'No.': '30000' } },
      ]]]),
    };
    const event: BCEvent = { type: 'RowDelta', formId: 'f1', controlPath: 'server:c[1]', op: 'insert', bookmark: 'bm2', index: 1, cells: { 'No.': '20000' } };
    const rows = projection.apply(form, event).rows.get('server:c[1]')!;
    expect(rows.map(r => r.bookmark)).toEqual(['bm1', 'bm2', 'bm3']);
  });

  it('RowDelta on an unknown controlPath is a no-op (same reference)', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = { type: 'RowDelta', formId: 'f1', controlPath: 'server:c[99]', op: 'remove', bookmark: 'x' };
    expect(projection.apply(form, event)).toBe(form);
  });

  it('applies PropertyChanged TotalRowCount to repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
      changes: { TotalRowCount: 42 },
    };
    const updated = projection.apply(form, event);
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.totalRowCount).toBe(42);
  });

  it('applies PropertyChanged to tree fields', () => {
    // Build a form with a real field in the tree. The field lands at server:c[0]
    // (first child of the lf root).
    const root = buildFormTree({
      t: 'lf', ServerId: 'f1', PageType: 0,
      Children: [{ t: 'sc', Caption: 'Name', Editable: true, Visible: true }],
    });
    const form: FormState = { ...makeForm(), root };
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'Hello', Caption: 'Name', Editable: true, Visible: true },
    };
    const updated = projection.apply(form, event);
    const field = treeFields(updated.root).find(f => f.controlPath === 'server:c[0]');
    expect(field).toBeDefined();
    expect(field!.properties.stringValue).toBe('Hello');
    expect(field!.properties.caption).toBe('Name');
  });

  it('applies BookmarkChanged to correct repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'BookmarkChanged', formId: 'f1', controlPath: 'server:c[1]', bookmark: 'bm5',
    };
    const updated = projection.apply(form, event);
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.bookmark).toBe('bm5');
  });

  it('creates initial FormState', () => {
    const form = projection.createInitial('myForm', 'parentForm');
    expect(form.formId).toBe('myForm');
    expect(form.parentFormId).toBe('parentForm');
    expect(form.rows.size).toBe(0);
    expect(treeFields(form.root)).toHaveLength(0);
    expect(treeRepeaters(form.root).size).toBe(0);
  });

  it('updates existing field on repeated PropertyChanged', () => {
    // Build a form with a real field at server:c[0] so that PropertyChanged
    // events can mutate it via the tree.
    const root = buildFormTree({
      t: 'lf', ServerId: 'f1', PageType: 0,
      Children: [{ t: 'sc', Caption: 'Field1', Editable: false, Visible: true }],
    });
    let form: FormState = { ...makeForm(), root };
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'first', Caption: 'Field1' },
    } as BCEvent);
    expect(treeFields(form.root)).toHaveLength(1);
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'second' },
    } as BCEvent);
    expect(treeFields(form.root)).toHaveLength(1);
    expect(treeFields(form.root)[0]!.properties.stringValue).toBe('second');
    expect(treeFields(form.root)[0]!.properties.caption).toBe('Field1'); // preserved from first apply
  });
});
