import { describe, it, expect } from 'vitest';
import { StateProjection } from '../../src/protocol/state-projection.js';
import type { BCEvent } from '../../src/protocol/types.js';

describe('StateProjection', () => {
  const projection = new StateProjection();

  it('creates initial PageState', () => {
    const state = projection.createInitial('ctx:page:22', 'formId123');
    expect(state.pageContextId).toBe('ctx:page:22');
    expect(state.formId).toBe('formId123');
    expect(state.controlTree).toEqual([]);
    expect(state.repeater).toBeNull();
  });

  it('applies DataLoaded events to repeater', () => {
    let state = projection.createInitial('ctx:page:22', 'formId123');
    const events: BCEvent[] = [{
      type: 'DataLoaded',
      formId: 'formId123',
      controlPath: 'server:c[1]',
      currentRowOnly: false,
      rows: [
        { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000', 'Name': 'Test' }, bookmark: 'bm1' }] },
        { t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': '20000', 'Name': 'Test2' }, bookmark: 'bm2' }] },
      ],
    }];
    state = projection.apply(state, events);
    expect(state.repeater).not.toBeNull();
    expect(state.repeater!.rows.length).toBe(2);
    expect(state.repeater!.rows[0]!.bookmark).toBe('bm1');
  });

  it('applies PropertyChanged events to control tree', () => {
    let state = projection.createInitial('ctx:page:22', 'formId123');
    const events: BCEvent[] = [{
      type: 'PropertyChanged',
      formId: 'formId123',
      controlPath: 'server:c[2]/c[0]/c[3]',
      changes: { StringValue: 'Hello', Caption: 'Name', Editable: true, Visible: true },
    }];
    state = projection.apply(state, events);
    const field = state.controlTree.find(f => f.controlPath === 'server:c[2]/c[0]/c[3]');
    expect(field).toBeDefined();
    expect(field!.stringValue).toBe('Hello');
    expect(field!.caption).toBe('Name');
  });

  it('tracks dialogs from DialogOpened events', () => {
    let state = projection.createInitial('ctx:page:22', 'formId123');
    const events: BCEvent[] = [{
      type: 'DialogOpened',
      formId: 'dialog001',
      ownerFormId: 'formId123',
      controlTree: { message: 'License expired' },
    }];
    state = projection.apply(state, events);
    expect(state.dialogs.length).toBe(1);
    expect(state.dialogs[0]!.formId).toBe('dialog001');
  });

  it('ignores events for different formId', () => {
    let state = projection.createInitial('ctx:page:22', 'formId123');
    const events: BCEvent[] = [{
      type: 'PropertyChanged',
      formId: 'otherForm',
      controlPath: 'c[0]',
      changes: { StringValue: 'ignored' },
    }];
    state = projection.apply(state, events);
    expect(state.controlTree.length).toBe(0);
  });

  it('updates existing field on repeated PropertyChanged', () => {
    let state = projection.createInitial('ctx', 'f1');
    state = projection.apply(state, [{
      type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]',
      changes: { StringValue: 'first', Caption: 'Field1' },
    }]);
    expect(state.controlTree.length).toBe(1);
    state = projection.apply(state, [{
      type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]',
      changes: { StringValue: 'second' },
    }]);
    expect(state.controlTree.length).toBe(1);
    expect(state.controlTree[0]!.stringValue).toBe('second');
    expect(state.controlTree[0]!.caption).toBe('Field1'); // preserved from first
  });
});
