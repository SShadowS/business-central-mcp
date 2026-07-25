import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import type { BCInteraction } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

// Minimal fake WS: records sendRpc order, resolves each with an InvokeCompleted-shaped payload.
function fakeWs(sendOrder: string[]) {
  return {
    nextSequenceNo: 'spa#1',
    lastClientAckSequenceNumber: -1,
    spaInstanceId: 'spa',
    isConnected: true,
    onMessage: () => () => {},
    setRequestHandler: undefined,
    async sendRpc(_method: string, params: unknown[]) {
      const inv = (params[0] as { interactionsToInvoke: Array<{ interactionName: string }> }).interactionsToInvoke[0];
      sendOrder.push(inv.interactionName);
      // Return a decoder-compatible CallbackResponseProperties payload -> InvokeCompleted event.
      return ok([{ handlerType: 'DN.CallbackResponseProperties', parameters: [{ CompletedInteractions: [{ CallbackId: 'x' }] }] }]);
    },
    closeWs: () => {},
  } as never;
}

describe('BCSession.invokeSequence', () => {
  it('sends interactions in order within a single queue entry and merges events', async () => {
    const order: string[] = [];
    const session = new BCSession(fakeWs(order), new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger, 'default');
    // set credentials so encode does not throw
    (session as unknown as { sessionId: string }).sessionId = 's';
    (session as unknown as { sessionKey: string }).sessionKey = 'k';
    (session as unknown as { company: string }).company = 'c';
    (session as unknown as { _initialized: boolean })._initialized = true;

    const a: BCInteraction = { type: 'SetCurrentRow', formId: 'f', controlPath: 'p', key: 'A', rowsToSelect: ['A', 'B'] };
    const b: BCInteraction = { type: 'InvokeAction', formId: 'f', controlPath: 'p/cr/c[0]', systemAction: 20 };
    const res = await session.invokeSequence([a, b], (e) => e.type === 'InvokeCompleted');
    expect(res.ok).toBe(true);
    expect(order).toEqual(['SetCurrentRowAndRowsSelection', 'InvokeAction']);
  });

  it('merges events from both interactions', async () => {
    const order: string[] = [];
    const session = new BCSession(fakeWs(order), new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger, 'default');
    (session as unknown as { sessionId: string }).sessionId = 's';
    (session as unknown as { sessionKey: string }).sessionKey = 'k';
    (session as unknown as { company: string }).company = 'c';
    (session as unknown as { _initialized: boolean })._initialized = true;

    const a: BCInteraction = { type: 'SetCurrentRow', formId: 'f', controlPath: 'p', key: 'A', rowsToSelect: ['A', 'B'] };
    const b: BCInteraction = { type: 'InvokeAction', formId: 'f', controlPath: 'p/cr/c[0]', systemAction: 20 };
    const res = await session.invokeSequence([a, b], (e) => e.type === 'InvokeCompleted');
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Each of the two sends yields one InvokeCompleted event -> two events merged.
      expect(res.value.filter(e => e.type === 'InvokeCompleted')).toHaveLength(2);
    }
  });

  it('does not allow a concurrent invoke() to interleave between the sequence sends', async () => {
    const order: string[] = [];
    let releaseFirstSend: (() => void) | undefined;
    const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });

    let callCount = 0;
    const ws = {
      nextSequenceNo: 'spa#1',
      lastClientAckSequenceNumber: -1,
      spaInstanceId: 'spa',
      isConnected: true,
      onMessage: () => () => {},
      setRequestHandler: undefined,
      async sendRpc(_method: string, params: unknown[]) {
        const inv = (params[0] as { interactionsToInvoke: Array<{ interactionName: string; controlPath: string }> }).interactionsToInvoke[0];
        callCount++;
        if (callCount === 1) {
          // Stall the first send of the sequence until the concurrent invoke()
          // has had a chance to try to jump the queue.
          await firstSendGate;
        }
        // Discriminate by controlPath too: `b` and `other` are both InvokeAction
        // interactions, so recording interactionName alone would pass identically
        // for the correct order [a,b,other] and the broken interleaved [a,other,b].
        order.push(`${inv.interactionName}:${inv.controlPath}`);
        return ok([{ handlerType: 'DN.CallbackResponseProperties', parameters: [{ CompletedInteractions: [{ CallbackId: 'x' }] }] }]);
      },
      closeWs: () => {},
    } as never;

    const session = new BCSession(ws, new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger, 'default');
    (session as unknown as { sessionId: string }).sessionId = 's';
    (session as unknown as { sessionKey: string }).sessionKey = 'k';
    (session as unknown as { company: string }).company = 'c';
    (session as unknown as { _initialized: boolean })._initialized = true;

    const a: BCInteraction = { type: 'SetCurrentRow', formId: 'f', controlPath: 'p', key: 'A', rowsToSelect: ['A', 'B'] };
    const b: BCInteraction = { type: 'InvokeAction', formId: 'f', controlPath: 'p/cr/c[0]', systemAction: 20 };
    const other: BCInteraction = { type: 'InvokeAction', formId: 'f', controlPath: 'other', systemAction: 30 };

    const seqPromise = session.invokeSequence([a, b], (e) => e.type === 'InvokeCompleted');
    // Give the sequence's first send a chance to register in sendRpc (and stall there).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrentPromise = session.invoke(other, (e) => e.type === 'InvokeCompleted');
    // Now release the stalled first send of the sequence.
    releaseFirstSend!();

    const [seqRes] = await Promise.all([seqPromise, concurrentPromise]);
    expect(seqRes.ok).toBe(true);
    // The concurrent invoke() must not land between the two sequence sends.
    // (controlPath discriminates `b` from `other` — both are InvokeAction.)
    expect(order).toEqual(['SetCurrentRowAndRowsSelection:p', 'InvokeAction:p/cr/c[0]', 'InvokeAction:other']);
  });
});
