import { describe, it, expect } from 'vitest';
import { InteractionEncoder, type EncodeContext } from '../../src/protocol/interaction-encoder.js';
import type { SetCurrentRowInteraction } from '../../src/protocol/types.js';

const ctx: EncodeContext = {
  callbackId: 'cb1', sequenceNo: 'spa#1', lastClientAckSequenceNumber: -1,
  openFormIds: new Set(['f1']),
  session: { sessionId: 's', sessionKey: 'k', company: 'c', tenantId: 't', spaInstanceId: 'spa' },
};

function invocationOf(enc: ReturnType<InteractionEncoder['encode']>) {
  return (enc.params[0] as { interactionsToInvoke: Array<{ interactionName: string; namedParameters: string }> }).interactionsToInvoke[0];
}

describe('SetCurrentRow encoding', () => {
  const encoder = new InteractionEncoder('28.0.0.0');

  it('single-row (no rowsToSelect) is byte-identical to the legacy payload', () => {
    const i: SetCurrentRowInteraction = { type: 'SetCurrentRow', formId: 'f1', controlPath: 'server:c[0]', key: 'BK1' };
    const inv = invocationOf(encoder.encode(i, ctx));
    expect(inv.interactionName).toBe('SetCurrentRowAndRowsSelection');
    expect(JSON.parse(inv.namedParameters)).toEqual({ key: 'BK1', selectAll: false, rowsToSelect: ['BK1'], unselectAll: true, rowsToUnselect: [] });
  });

  it('multi-row emits the full RowsToSelect set with key as anchor', () => {
    const i: SetCurrentRowInteraction = { type: 'SetCurrentRow', formId: 'f1', controlPath: 'server:c[0]', key: 'A', rowsToSelect: ['A', 'B', 'C'] };
    const inv = invocationOf(encoder.encode(i, ctx));
    expect(JSON.parse(inv.namedParameters)).toEqual({ key: 'A', selectAll: false, rowsToSelect: ['A', 'B', 'C'], unselectAll: true, rowsToUnselect: [] });
  });
});
