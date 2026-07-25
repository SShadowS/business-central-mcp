/**
 * Tests for BCSession report-download flow via UriToShow / FileDownloadReady events.
 *
 * The /csh protocol delivers download URLs inline in the invoke callback response as
 * DN.LogicalClientEventRaisingHandler("UriToShow", relativeUrl, style). These arrive
 * as FileDownloadReady events after EventDecoder.decode(). BCSession.runReportWithDownload()
 * drives the full SendTo flow and returns the raw `events` -- fetching the file bytes
 * from the FileDownloadReady.relativeUrl is DownloadService's job, not BCSession's
 * (see tests/unit/download-service.test.ts).
 *
 * Reference: ResponseManager.RegisterUriToShowEvents (decompiled
 *   Microsoft.Dynamics.Framework.UI.Web). Verified from live BC28 wire capture (2026-06-15).
 */

import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { isOk, isErr } from '../../src/core/result.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}

/** Returns a real EventDecoder so UriToShow decoding is actually exercised. */
function createRealDecoder() {
  return new EventDecoder();
}

/**
 * Build the compressed-like handler payload that BCSession.invokeUnqueued
 * returns via ws.sendRpc. We bypass decompression by having sendRpc return
 * a pre-decoded handler array directly (the production code passes the result
 * through decoder.decode()).
 */
function fileDownloadHandlers(relativeUrl: string, style = '1') {
  return [
    {
      handlerType: 'DN.CallbackResponseProperties',
      parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }],
    },
    {
      handlerType: 'DN.LogicalClientEventRaisingHandler',
      parameters: ['UriToShow', relativeUrl, style],
    },
  ];
}

/** Minimal request-page / format-dialog handlers so invoke returns a DialogOpened. */
function dialogHandlers(formId: string) {
  return [
    {
      handlerType: 'DN.CallbackResponseProperties',
      parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }],
    },
    {
      handlerType: 'DN.LogicalClientEventRaisingHandler',
      parameters: ['DialogToShow', { ServerId: formId }],
    },
  ];
}

function invokeCompletedHandlers() {
  return [
    {
      handlerType: 'DN.CallbackResponseProperties',
      parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }],
    },
  ];
}

function createMockWsWithRequestHandler() {
  let capturedHandler: ((method: string, params: unknown[], id: string) => Promise<unknown>) | null = null;

  const ws = {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: '1',
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
    setRequestHandler: vi.fn((handler: (method: string, params: unknown[], id: string) => Promise<unknown>) => {
      capturedHandler = handler;
    }),
  };

  return {
    ws,
    invokeHandler: async (method: string, params: unknown[] = [], id = 'req-1') => {
      if (!capturedHandler) throw new Error('No request handler was registered');
      return capturedHandler(method, params, id);
    },
  };
}

describe('BCSession inbound request handler', () => {
  it('registers a request handler on construction when setRequestHandler is available', () => {
    const { ws } = createMockWsWithRequestHandler();
    ws.sendRpc.mockResolvedValue({ ok: true, value: [] });
    new BCSession(ws as any, createRealDecoder(), createMockEncoder(), createMockLogger() as any, 'default');
    expect(ws.setRequestHandler).toHaveBeenCalledOnce();
  });

  it('does NOT throw when ws has no setRequestHandler (old mock compatibility)', () => {
    const ws = {
      isConnected: true,
      spaInstanceId: 'spa-test',
      nextSequenceNo: '1',
      lastClientAckSequenceNumber: 0,
      sendRpc: vi.fn(),
      onMessage: vi.fn(() => () => {}),
      close: vi.fn(),
    };
    expect(() => {
      new BCSession(ws as any, createRealDecoder(), createMockEncoder(), createMockLogger() as any, 'default');
    }).not.toThrow();
  });

  it('returns {} for any inbound method (no FileActionDialog special-casing on /csh)', async () => {
    const { ws, invokeHandler } = createMockWsWithRequestHandler();
    ws.sendRpc.mockResolvedValue({ ok: true, value: [] });
    new BCSession(ws as any, createRealDecoder(), createMockEncoder(), createMockLogger() as any, 'default');

    const result = await invokeHandler('FileActionDialog', [{ FileName: 'report.pdf' }]);
    expect(result).toEqual({});

    const result2 = await invokeHandler('SomeUnknownMethod', []);
    expect(result2).toEqual({});
  });
});

describe('BCSession.runReportWithDownload', () => {
  function buildSession() {
    const { ws } = createMockWsWithRequestHandler();
    const decoder = createRealDecoder();

    // Sequence:
    //  call 1: OpenForm(report=6) → DialogOpened(reqPage="req-1")
    //  call 2: InvokeAction(410) → DialogOpened(fmtDlg="fmt-1")
    //  call 3: InvokeAction(300) → FileDownloadReady(DynamicFileHandler.axd?...)
    ws.sendRpc
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('req-1') })
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('fmt-1') })
      .mockResolvedValueOnce({ ok: true, value: fileDownloadHandlers('DynamicFileHandler.axd?form=41D&fname=Trial%20Balance.pdf') });

    const session = new BCSession(
      ws as any, decoder, createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '',
    );

    return { session, ws };
  }

  it('drives SendTo flow and returns a FileDownloadReady event on success', async () => {
    const { session } = buildSession();

    const result = await session.runReportWithDownload(6);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const dlReady = result.value.events.find(e => e.type === 'FileDownloadReady');
    expect(dlReady).toBeDefined();
    if (dlReady?.type !== 'FileDownloadReady') return;
    expect(dlReady.relativeUrl).toBe('DynamicFileHandler.axd?form=41D&fname=Trial%20Balance.pdf');
    expect(dlReady.style).toBe('1');
  });

  it('returns error when request page dialog is not returned', async () => {
    const { ws } = createMockWsWithRequestHandler();
    ws.sendRpc.mockResolvedValue({ ok: true, value: invokeCompletedHandlers() });

    const session = new BCSession(
      ws as any, createRealDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '',
    );

    const result = await session.runReportWithDownload(6);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toMatch(/no request page dialog/i);
  });

  it('returns error when FileDownloadReady event is absent from format-OK response', async () => {
    const { ws } = createMockWsWithRequestHandler();
    ws.sendRpc
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('req-1') })
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('fmt-1') })
      .mockResolvedValueOnce({ ok: true, value: invokeCompletedHandlers() }); // no UriToShow

    const session = new BCSession(
      ws as any, createRealDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '',
    );

    const result = await session.runReportWithDownload(6);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toMatch(/FileDownloadReady event missing/i);
  });

  it('skips request-page open when requestPageFormId is provided', async () => {
    const { ws } = createMockWsWithRequestHandler();
    ws.sendRpc
      .mockResolvedValueOnce({ ok: true, value: dialogHandlers('fmt-1') })
      .mockResolvedValueOnce({ ok: true, value: fileDownloadHandlers('DynamicFileHandler.axd?fname=x.pdf') });

    const session = new BCSession(
      ws as any, createRealDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 30000, '',
    );

    const result = await session.runReportWithDownload(6, 'pdf', { requestPageFormId: 'req-already-open' });
    expect(isOk(result)).toBe(true);
    // Only 2 sendRpc calls: SendTo + OK (no OpenForm)
    expect(ws.sendRpc).toHaveBeenCalledTimes(2);
  });
});
