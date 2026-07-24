/**
 * Branch-coverage tests for BCSession focusing on paths not exercised by the
 * existing suites (drain-on-death, invoke-timeout, modal-tracking,
 * session-reconnect, file-handler):
 *
 *   - initialize(): license-dialog auto-dismiss (success + failure), credential
 *     extraction from a nested OpenSession response.
 *   - closeGracefully(): already-dead early return, save-changes dialog dismissal
 *     during the form-close loop, the 20-iteration safety cap, and the
 *     try/finally teardown when CloseForm throws.
 *   - runReportWithDownload(): no-format-dialog error and dead-session fast-fail.
 *   - close(): unconditional teardown idempotency.
 *
 * All imports use .js extensions (ESM project). No 2>nul. No emojis.
 */

import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import { isOk, isErr } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function createMockEncoder(onEncode?: (i: BCInteraction) => void) {
  return {
    encode: vi.fn((i: BCInteraction) => {
      onEncode?.(i);
      return { method: 'Invoke', params: [{}] };
    }),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}

/** Decoder mock returning a fixed event list per call. */
function createMockDecoder(decode: () => BCEvent[]) {
  return { decode: vi.fn(decode) } as unknown as EventDecoder;
}

function createMockWs(sendRpc: ReturnType<typeof vi.fn>) {
  return {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc,
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// initialize(): credential extraction + license-dialog auto-dismiss
// ---------------------------------------------------------------------------

describe('BCSession.initialize', () => {
  it('extracts session credentials from a nested OpenSession response', async () => {
    // Credentials are buried in a nested object/array to exercise the recursive
    // extractSessionCredentials walk.
    const responseData = [
      {
        wrapper: {
          ServerSessionId: 'srv-123',
          inner: [{ SessionKey: 'key-abc' }, { CompanyName: 'CRONUS' }],
        },
      },
    ];
    const ws = createMockWs(vi.fn(async () => ok(responseData)));
    const decoder = createMockDecoder(() => []); // no events -> no license dialog
    const session = new BCSession(
      ws as any, decoder, createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const result = await session.initialize('default');

    expect(isOk(result)).toBe(true);
    expect(session.isInitialized).toBe(true);
    expect(session.companyName).toBe('CRONUS');
  });

  it('returns the rpc error when OpenSession sendRpc fails', async () => {
    const ws = createMockWs(vi.fn(async () => ({ ok: false, error: { message: 'connect refused' } })));
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const result = await session.initialize('default');
    expect(isErr(result)).toBe(true);
    expect(session.isInitialized).toBe(false);
  });

  it('auto-dismisses a license dialog with Ok=300 and drops it from openFormIds', async () => {
    const sentActions: BCInteraction[] = [];
    // First sendRpc = OpenSession response carrying a license DialogOpened.
    // Second sendRpc = the Ok=300 dismiss invoke.
    let call = 0;
    const ws = createMockWs(vi.fn(async () => {
      call += 1;
      return ok([{ call }]);
    }));
    const decoder = createMockDecoder(() => {
      // On the OpenSession decode we return a license DialogOpened so
      // findLicenseDialog matches; the dismiss invoke decode returns nothing.
      if (call === 1) {
        return [{ type: 'DialogOpened', formId: 'LIC1', controlTree: { Caption: 'Your license is about to expire' } } as BCEvent];
      }
      return [];
    });
    const session = new BCSession(
      ws as any, decoder,
      createMockEncoder((i) => { if (i.type === 'InvokeAction') sentActions.push(i); }),
      createMockLogger() as any, 'default', 5000,
    );

    const result = await session.initialize('default');
    expect(isOk(result)).toBe(true);

    // The license dialog formId must have been removed from openFormIds.
    expect(Array.from(session.openFormIds)).not.toContain('LIC1');

    // An Ok=300 InvokeAction against the dialog formId was sent.
    const dismiss = sentActions.find(a => a.type === 'InvokeAction' && (a as any).formId === 'LIC1');
    expect(dismiss).toBeDefined();
    expect((dismiss as any).systemAction).toBe(300);
  });

  it('continues when license dialog dismiss invoke throws (best-effort catch)', async () => {
    let call = 0;
    const ws = createMockWs(vi.fn(async () => {
      call += 1;
      if (call === 1) return ok([{ open: true }]); // OpenSession ok
      // The dismiss invoke: a fatal RPC error marks dead and the invoke returns
      // an Err result. closeGracefully isn't involved; initialize swallows it.
      return { ok: false, error: { message: 'InvalidSessionException' } };
    }));
    const decoder = createMockDecoder(() => {
      if (call === 1) {
        return [{ type: 'DialogOpened', formId: 'LIC1', controlTree: { Message: 'This is an evaluation version' } } as BCEvent];
      }
      return [];
    });
    const logger = createMockLogger();
    const session = new BCSession(
      ws as any, decoder, createMockEncoder(),
      logger as any, 'default', 5000,
    );

    // Even though the dismiss fails, initialize resolves ok (license dismiss is
    // best-effort). It returns the decoded OpenSession events.
    const result = await session.initialize('default');
    expect(isOk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// closeGracefully(): early return, save-changes dismissal, cap, finally
// ---------------------------------------------------------------------------

describe('BCSession.closeGracefully', () => {
  it('is a no-op when the session is already dead (no ws.close, no sendRpc)', async () => {
    const sendRpc = vi.fn(async () => ok([]));
    const ws = createMockWs(sendRpc);
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    session.markDead();
    await session.closeGracefully();

    expect(sendRpc).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes open forms, dismisses a save-changes dialog with No=390, then closes ws', async () => {
    const sentActions: BCInteraction[] = [];
    // sendRpc resolves ok for every call. The decoder injects a save-changes
    // DialogOpened only on the FIRST CloseForm response so the loop dismisses it.
    let closeFormCalls = 0;
    const sendRpc = vi.fn(async (_method: string, _params: unknown[]) => ok([]));
    const ws = createMockWs(sendRpc);

    const decoder = createMockDecoder(() => []); // default empty
    // Replace decode with one that keys off the interaction recorded by encoder.
    let lastWasCloseForm = false;
    const encoder = createMockEncoder((i) => {
      sentActions.push(i);
      lastWasCloseForm = i.type === 'CloseForm';
      if (lastWasCloseForm) closeFormCalls += 1;
    });
    (decoder.decode as any) = vi.fn(() => {
      if (lastWasCloseForm && closeFormCalls === 1) {
        // First CloseForm spawns a save-changes dialog.
        return [{ type: 'DialogOpened', formId: 'SAVE1', controlTree: { Caption: 'Save changes?' } } as BCEvent];
      }
      return [];
    });

    const session = new BCSession(
      ws as any, decoder, encoder,
      createMockLogger() as any, 'default', 5000,
    );
    session.addOpenForm('F1');

    await session.closeGracefully();

    // A No=390 dismiss was sent against the save-changes dialog.
    const noAction = sentActions.find(a => a.type === 'InvokeAction' && (a as any).systemAction === 390);
    expect(noAction).toBeDefined();
    expect((noAction as any).formId).toBe('SAVE1');

    // The original form was closed via CloseForm.
    expect(sentActions.some(a => a.type === 'CloseForm')).toBe(true);

    // ws.close fired in the finally block, exactly once.
    expect(ws.close).toHaveBeenCalledOnce();

    // openFormIds is drained.
    expect(session.openFormIds.size).toBe(0);
  });

  it('honours the 20-iteration cap when CloseForm never reduces openFormIds', async () => {
    // The decoder re-injects a fresh DialogOpened on EVERY CloseForm response,
    // so the loop keeps finding new forms. But CloseForm also deletes the
    // popped formId at the bottom of the loop; to defeat that we make the
    // encoder re-add a NEW form each iteration via the decode path. The cap
    // (20) guarantees termination regardless.
    let iter = 0;
    const sendRpc = vi.fn(async () => ok([]));
    const ws = createMockWs(sendRpc);

    let lastClose = false;
    const encoder = createMockEncoder((i) => { lastClose = i.type === 'CloseForm'; });
    const decoder = createMockDecoder(() => []);
    (decoder.decode as any) = vi.fn(() => {
      if (lastClose) {
        iter += 1;
        // Each CloseForm response opens a brand-new form, keeping the set
        // non-empty so the loop runs to its 20-iteration cap.
        return [{ type: 'FormCreated', formId: `NEW${iter}`, controlTree: {} } as BCEvent];
      }
      return [];
    });

    const session = new BCSession(
      ws as any, decoder, encoder,
      createMockLogger() as any, 'default', 5000,
    );
    session.addOpenForm('F1');

    await session.closeGracefully();

    // The loop is capped at 20 CloseForm iterations.
    const closeFormSends = (encoder.encode as any).mock.calls
      .filter((c: any[]) => c[0]?.type === 'CloseForm').length;
    expect(closeFormSends).toBe(20);

    // ws still closed via finally despite forms remaining.
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('still closes ws when CloseForm sendRpc rejects (try/finally teardown)', async () => {
    // sendRpc rejects -> invokeUnqueued's awaited sendRpc throws -> caught by
    // the per-iteration try/catch; the outer finally must still close ws.
    const sendRpc = vi.fn(async () => { throw new Error('socket exploded'); });
    const ws = createMockWs(sendRpc);
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );
    session.addOpenForm('F1');

    await session.closeGracefully();

    expect(ws.close).toHaveBeenCalledOnce();
    // Even on failure the form is removed from tracking (delete at loop bottom).
    expect(session.openFormIds.size).toBe(0);
  });

  it('second closeGracefully call short-circuits (idempotent)', async () => {
    const sendRpc = vi.fn(async () => ok([]));
    const ws = createMockWs(sendRpc);
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    await session.closeGracefully(); // no open forms -> straight to finally
    expect(ws.close).toHaveBeenCalledOnce();

    await session.closeGracefully(); // dead now -> early return, no extra close
    expect(ws.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// runReportWithDownload(): no-format-dialog + dead-session fast-fail
// ---------------------------------------------------------------------------

function dialogHandlers(formId: string) {
  return [
    { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }] },
    { handlerType: 'DN.LogicalClientEventRaisingHandler', parameters: ['DialogToShow', { ServerId: formId }] },
  ];
}
function invokeCompletedHandlers() {
  return [
    { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }] },
  ];
}

describe('BCSession.runReportWithDownload (additional branches)', () => {
  it('returns error when SendTo (410) opens no format dialog', async () => {
    const sendRpc = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('req-1') }) // OpenForm -> request page
      .mockResolvedValueOnce({ ok: true, value: invokeCompletedHandlers() }); // SendTo -> NO dialog
    const ws = createMockWs(sendRpc);
    const session = new BCSession(
      ws as any, new EventDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const result = await session.runReportWithDownload(6);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/no format dialog/i);
  });

  it('fast-fails when the session is already dead', async () => {
    const ws = createMockWs(vi.fn(async () => ok([])));
    const session = new BCSession(
      ws as any, new EventDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );
    session.markDead();

    const result = await session.runReportWithDownload(6);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/Session is dead/i);
  });
});

// ---------------------------------------------------------------------------
// close(): unconditional teardown
// ---------------------------------------------------------------------------

describe('BCSession.close', () => {
  it('marks dead and closes ws; second call is idempotent', () => {
    const ws = createMockWs(vi.fn(async () => ok([])));
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    expect(session.isAlive).toBe(true);
    session.close();
    expect(session.isAlive).toBe(false);
    expect(ws.close).toHaveBeenCalledOnce();

    session.close(); // idempotent -- closeWs guards via wsClosed flag
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('runReport fast-fails on a dead session', async () => {
    const ws = createMockWs(vi.fn(async () => ok([])));
    const session = new BCSession(
      ws as any, createMockDecoder(() => []), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );
    session.close();

    const result = await session.runReport(6);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/Session is dead/i);
  });
});
