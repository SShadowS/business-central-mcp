import { describe, it, expect } from 'vitest';
import { actionReplaySafe, formClosed, valueEchoed, writeDataReplaySafe } from '../../src/protocol/replay-safety.js';
import { SystemAction, type BCEvent } from '../../src/protocol/types.js';

// Event shapes below mirror live cronus29 captures (scratch probe, 2026-10-13).
const closed = (formId: string): BCEvent => ({ type: 'PropertyChanged', formId, controlPath: 'server:', changes: { State: 0 } });
const echo = (formId: string, controlPath: string, v = 'X'): BCEvent => ({ type: 'PropertyChanged', formId, controlPath, changes: { StringValue: v } });
const done: BCEvent = { type: 'InvokeCompleted' } as BCEvent;

describe('replaySafe rules', () => {
  it('valueEchoed: StringValue/ObjectValue on the written path, under the write form or the page root', () => {
    expect(valueEchoed([done, echo('C1', 'server:c[2]/c[0]/c[1]')], ['C1'], 'server:c[2]/c[0]/c[1]')).toBe(true);
    // Line cell echo arrives under the page ROOT formId with the subpage-relative path.
    expect(valueEchoed([echo('100', 'server:c[1]/cr/c[16]')], ['107', '100'], 'server:c[1]/cr/c[16]')).toBe(true);
    expect(valueEchoed([echo('C1', 'server:c[9]')], ['C1'], 'server:c[2]')).toBe(false);
    expect(valueEchoed([echo('OTHER', 'server:c[2]')], ['C1'], 'server:c[2]')).toBe(false);
    // A non-value property on the path (e.g. Dirty) is not an echo; neither is silence
    // (SaveValue on a non-editable control is a silent no-op, decompiled SaveValueInteraction).
    expect(valueEchoed([{ type: 'PropertyChanged', formId: 'C1', controlPath: 'server:c[2]', changes: { Dirty: true } }], ['C1'], 'server:c[2]')).toBe(false);
    expect(valueEchoed([done], ['C1'], 'server:c[2]')).toBe(false);
  });

  it('formClosed: State=0 on the form root only', () => {
    expect(formClosed([done, closed('44')], '44')).toBe(true);
    expect(formClosed([closed('42')], '44')).toBe(false);
    expect(formClosed([{ type: 'PropertyChanged', formId: '44', controlPath: 'server:', changes: { State: 2 } }], '44')).toBe(false);
    expect(formClosed([{ type: 'PropertyChanged', formId: '44', controlPath: 'server:c[1]', changes: { State: 0 } }], '44')).toBe(false);
    expect(formClosed([closed('44')], undefined)).toBe(false);
  });

  it('write_data: every field written and echoed, no pending dialog', () => {
    expect(writeDataReplaySafe([{ success: true, echoed: true }, { success: true, echoed: true }], 0)).toBe(true);
    expect(writeDataReplaySafe([{ success: true, echoed: true }, { success: true, echoed: false }], 0)).toBe(false);
    expect(writeDataReplaySafe([{ success: false }], 0)).toBe(false);
    expect(writeDataReplaySafe([{ success: true, echoed: true }], 1)).toBe(false);
    expect(writeDataReplaySafe([], 0)).toBe(false);
  });

  it('execute_action / wizard_navigate: Refresh, or the invoked form closed; anything else false', () => {
    expect(actionReplaySafe({ systemAction: SystemAction.Refresh, formId: 'F', events: [done] })).toBe(true);
    expect(actionReplaySafe({ systemAction: SystemAction.Refresh, formId: 'F', events: [{ type: 'DialogOpened', formId: 'D', controlTree: {} } as BCEvent] })).toBe(false);
    expect(actionReplaySafe({ systemAction: 0, formId: 'F', events: [done, closed('F')] })).toBe(true);
    // A post that opens the posted document but leaves the source open proves nothing.
    expect(actionReplaySafe({ systemAction: 0, formId: 'F', events: [done, { type: 'FormCreated', formId: 'G', controlTree: {} } as BCEvent] })).toBe(false);
    expect(actionReplaySafe({ systemAction: SystemAction.Delete, formId: 'F', events: [done] })).toBe(false);
    expect(actionReplaySafe({ systemAction: SystemAction.New, formId: 'F', events: [closed('G')] })).toBe(false);
  });
});
