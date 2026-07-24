/**
 * Session-level unit tests for BCSession.selectReportFormat (driven through the
 * public runReportWithDownload entry point).
 *
 * These exercise the PrintDialog tree-walk + format-label SaveValue WITHOUT a
 * live BC: the SendTo(410) response carries a format-dialog `controlTree` shaped
 * like the real PrintDialog (an `lf` root containing a `sec` SelectionControl
 * with an `Items` array). buildFormTree turns that into a FieldNode with
 * `options`, and selectReportFormat resolves the requested format to a text
 * label and SaveValue-s it before OK(300).
 *
 * Assertions cover:
 *  - excel  -> SaveValue("Microsoft Excel Document (data only)") BEFORE OK(300)
 *  - word   -> SaveValue("Microsoft Word Document") BEFORE OK(300)
 *  - pdf    -> NO SaveValue (BC default), then OK(300)
 *  - format absent from options -> err(ProtocolError) listing available texts, OK NOT sent
 *
 * Reference: live BC28 PrintDialog (2026-06-19). The real SelectionControl sits
 * at ~server:c[0]/c[1]/c[0]; this mock places it under nested gc containers so
 * the tree-walk (first node with non-empty options) must traverse to find it.
 */

import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import type { BCInteraction } from '../../src/protocol/types.js';
import { isOk, isErr } from '../../src/core/result.js';

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Encoder mock that records the interactions it is asked to encode, in order.
 * Production code calls encoder.encode(interaction, context) for every invoke.
 */
function createRecordingEncoder() {
  const interactions: BCInteraction[] = [];
  const encoder = {
    encode: vi.fn((interaction: BCInteraction) => {
      interactions.push(interaction);
      return { method: 'Invoke', params: [{}] };
    }),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
  return { encoder, interactions };
}

function createMockWs() {
  return {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: '1',
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
    setRequestHandler: vi.fn(),
  };
}

/** Request-page dialog: bare lf with no SelectionControl. */
function requestPageHandlers(formId: string) {
  return [
    { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }] },
    { handlerType: 'DN.LogicalClientEventRaisingHandler', parameters: ['DialogToShow', { t: 'lf', ServerId: formId, Children: [] }] },
  ];
}

/**
 * Format dialog (PrintDialog) shaped like the real wire tree: an `lf` root with
 * a nested gc > gc containing a `sec` SelectionControl whose Items are the
 * format choices. buildFormTree maps Items -> options.
 */
function formatDialogHandlers(formId: string, items: Array<{ Text: string; Value: string }>) {
  return [
    { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }] },
    {
      handlerType: 'DN.LogicalClientEventRaisingHandler',
      parameters: ['DialogToShow', {
        t: 'lf',
        ServerId: formId,
        MappingHint: 'PrintDialog',
        Children: [
          {
            t: 'gc',
            Children: [
              { t: 'sc', Caption: 'Some text field' },               // server:c[0]/c[0] (no options)
              {
                t: 'gc',
                Children: [
                  { t: 'sec', Caption: 'Format', Items: items },     // the SelectionControl
                ],
              },
            ],
          },
        ],
      }],
    },
  ];
}

function fileDownloadHandlers(relativeUrl: string) {
  return [
    { handlerType: 'DN.CallbackResponseProperties', parameters: [{ SequenceNumber: 1, CompletedInteractions: [] }] },
    { handlerType: 'DN.LogicalClientEventRaisingHandler', parameters: ['UriToShow', relativeUrl, '1'] },
  ];
}

const FULL_OPTIONS = [
  { Text: 'PDF Document', Value: '0' },
  { Text: 'Microsoft Word Document', Value: '1' },
  { Text: 'Microsoft Excel Document (data only)', Value: '2' },
  { Text: 'Microsoft Excel Document (data and layout)', Value: '3' },
];

function buildSession(opts: {
  fmtItems: Array<{ Text: string; Value: string }>;
}) {
  const ws = createMockWs();
  const decoder = new EventDecoder();
  const { encoder, interactions } = createRecordingEncoder();

  // Sequence: OpenForm -> req page, SendTo(410) -> format dialog,
  //           [SaveValue], OK(300) -> file download.
  // The SaveValue (when sent) consumes one sendRpc slot before OK.
  ws.sendRpc
    .mockResolvedValueOnce({ ok: true, value: requestPageHandlers('req-1') })
    .mockResolvedValueOnce({ ok: true, value: formatDialogHandlers('fmt-1', opts.fmtItems) })
    // Subsequent calls (SaveValue echo and/or OK) — provide enough responses.
    .mockResolvedValue({ ok: true, value: fileDownloadHandlers('DynamicFileHandler.axd?fname=out') });

  const session = new BCSession(
    ws as any, decoder, encoder,
    createMockLogger() as any, 'default', 30000, '',
  );

  return { session, ws, interactions };
}

describe('BCSession.selectReportFormat (tree-walk + SaveValue, no live BC)', () => {
  it('sends SaveValue("Microsoft Excel Document (data only)") BEFORE OK(300) for format:excel', async () => {
    const { session, interactions } = buildSession({ fmtItems: FULL_OPTIONS });

    const result = await session.runReportWithDownload(6, 'excel');
    expect(isOk(result)).toBe(true);

    const saveValues = interactions.filter(i => i.type === 'SaveValue');
    expect(saveValues).toHaveLength(1);
    expect(saveValues[0]).toMatchObject({
      type: 'SaveValue',
      formId: 'fmt-1',
      newValue: 'Microsoft Excel Document (data only)',
    });

    // SaveValue must precede the OK(300) InvokeAction.
    const saveValueIdx = interactions.findIndex(i => i.type === 'SaveValue');
    const okIdx = interactions.findIndex(i => i.type === 'InvokeAction' && i.systemAction === 300);
    expect(saveValueIdx).toBeGreaterThanOrEqual(0);
    expect(okIdx).toBeGreaterThan(saveValueIdx);
  });

  it('sends SaveValue("Microsoft Word Document") BEFORE OK(300) for format:word', async () => {
    const { session, interactions } = buildSession({ fmtItems: FULL_OPTIONS });

    const result = await session.runReportWithDownload(6, 'word');
    expect(isOk(result)).toBe(true);

    const saveValues = interactions.filter(i => i.type === 'SaveValue');
    expect(saveValues).toHaveLength(1);
    expect(saveValues[0]).toMatchObject({
      type: 'SaveValue',
      formId: 'fmt-1',
      newValue: 'Microsoft Word Document',
    });

    const saveValueIdx = interactions.findIndex(i => i.type === 'SaveValue');
    const okIdx = interactions.findIndex(i => i.type === 'InvokeAction' && i.systemAction === 300);
    expect(okIdx).toBeGreaterThan(saveValueIdx);
  });

  it('sends NO SaveValue for format:pdf (BC default), then OK(300)', async () => {
    const { session, interactions } = buildSession({ fmtItems: FULL_OPTIONS });

    const result = await session.runReportWithDownload(6, 'pdf');
    expect(isOk(result)).toBe(true);

    const saveValues = interactions.filter(i => i.type === 'SaveValue');
    expect(saveValues).toHaveLength(0);

    const okIdx = interactions.findIndex(i => i.type === 'InvokeAction' && i.systemAction === 300);
    expect(okIdx).toBeGreaterThanOrEqual(0);
  });

  it('returns ProtocolError listing available texts and does NOT send OK when format is absent', async () => {
    // Options WITHOUT any "Word" entry.
    const noWordOptions = [
      { Text: 'PDF Document', Value: '0' },
      { Text: 'Microsoft Excel Document (data only)', Value: '1' },
    ];
    const { session, interactions } = buildSession({ fmtItems: noWordOptions });

    const result = await session.runReportWithDownload(6, 'word');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toContain('does not offer word');
    expect(result.error.message).toContain('PDF Document');
    expect(result.error.message).toContain('Microsoft Excel Document (data only)');

    // No SaveValue and no OK(300) should have been attempted.
    expect(interactions.some(i => i.type === 'SaveValue')).toBe(false);
    expect(interactions.some(i => i.type === 'InvokeAction' && i.systemAction === 300)).toBe(false);
  });
});
