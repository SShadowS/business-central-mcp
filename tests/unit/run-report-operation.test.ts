import { describe, it, expect, vi } from 'vitest';
import { RunReportOperation } from '../../src/operations/run-report.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { ok, err, isErr, isOk } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';

/**
 * Unit coverage for RunReportOperation format handling.
 *
 * The key behaviours under test:
 *  - format omitted   -> opens request page only (calls session.runReport, no download)
 *  - format "pdf"     -> drives the download flow (calls session.runReportWithDownload)
 *  - format "excel"   -> drives the download flow (calls session.runReportWithDownload with format)
 *  - format "word"    -> drives the download flow (calls session.runReportWithDownload with format)
 *  - runReportWithDownload returns error for unavailable format -> operation propagates it
 */

function createMockSession(overrides?: Partial<BCSession>): BCSession {
  return {
    runReport: vi.fn(),
    runReportWithDownload: vi.fn(),
    ...overrides,
  } as unknown as BCSession;
}

describe('RunReportOperation format handling', () => {
  it('drives the download flow for format "pdf"', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({
      events: [],
      bytes: Buffer.from('%PDF-data'),
      contentType: 'application/pdf',
      fileName: 'Report 6.pdf',
    }));
    const session = createMockSession({ runReportWithDownload });
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6', format: 'pdf' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReportWithDownload).toHaveBeenCalledWith(6, 'pdf');
    expect(result.value.download).toBeDefined();
    expect(Buffer.from(result.value.download!.bytes, 'base64').toString()).toBe('%PDF-data');
    expect(result.value.download!.contentType).toBe('application/pdf');
    expect(result.value.download!.fileName).toBe('Report 6.pdf');
  });

  it('drives the download flow for format "excel" (passes format through to session)', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({
      events: [],
      bytes: Buffer.from('PK\x03\x04-xlsx-bytes'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'Report 6.xlsx',
    }));
    const session = createMockSession({ runReportWithDownload });
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6', format: 'excel' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // Must pass the format to the session so session can drive SaveValue
    expect(runReportWithDownload).toHaveBeenCalledWith(6, 'excel');
    expect(result.value.download).toBeDefined();
    expect(result.value.download!.contentType).toContain('spreadsheet');
    expect(result.value.download!.fileName).toBe('Report 6.xlsx');
  });

  it('drives the download flow for format "word" (passes format through to session)', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({
      events: [],
      bytes: Buffer.from('PK\x03\x04-docx-bytes'),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'Report 6.docx',
    }));
    const session = createMockSession({ runReportWithDownload });
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '120', format: 'word' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReportWithDownload).toHaveBeenCalledWith(120, 'word');
    expect(result.value.download).toBeDefined();
    expect(result.value.download!.contentType).toContain('word');
    expect(result.value.download!.fileName).toBe('Report 6.docx');
  });

  it('propagates ProtocolError from session when format is unavailable', async () => {
    const unavailableErr = new ProtocolError('Report 6 does not offer excel; available: PDF Document, Microsoft Word Document');
    const runReportWithDownload = vi.fn().mockResolvedValue(err(unavailableErr));
    const session = createMockSession({ runReportWithDownload });
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6', format: 'excel' });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toContain('Report 6 does not offer excel');
  });

  it('opens request page only when format is omitted (no download)', async () => {
    const runReport = vi.fn().mockResolvedValue(ok([]));
    const session = createMockSession({ runReport });
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReport).toHaveBeenCalledWith(6);
    expect(session.runReportWithDownload).not.toHaveBeenCalled();
    expect(result.value.download).toBeUndefined();
  });
});
