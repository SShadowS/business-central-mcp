import { describe, it, expect, vi } from 'vitest';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import type { DownloadService } from '../../src/services/download-service.js';
import { ok, err, isErr, isOk } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';

/**
 * Unit coverage for RunReportOperation format handling.
 *
 * The key behaviours under test:
 *  - format omitted   -> opens request page only (calls session.runReport, no download)
 *  - format "pdf"     -> drives the download flow (session.runReportWithDownload, then DownloadService.capture)
 *  - format "excel"   -> drives the download flow (calls session.runReportWithDownload with format)
 *  - format "word"    -> drives the download flow (calls session.runReportWithDownload with format)
 *  - runReportWithDownload returns error for unavailable format -> operation propagates it
 *
 * BCSession.runReportWithDownload only drives the wire protocol and returns the raw
 * `events`; fetching bytes is DownloadService's job (see tests/unit/download-service.test.ts),
 * so these tests mock both collaborators.
 */

function createMockSession(overrides?: Partial<BCSession>): BCSession {
  return {
    runReport: vi.fn(),
    runReportWithDownload: vi.fn(),
    ...overrides,
  } as unknown as BCSession;
}

function createMockDownloadService(overrides?: Partial<DownloadService>): DownloadService {
  return {
    capture: vi.fn().mockResolvedValue({ downloads: [], externalUris: [] }),
    ...overrides,
  } as unknown as DownloadService;
}

describe('RunReportOperation format handling', () => {
  it('drives the download flow for format "pdf"', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({ events: [] }));
    const session = createMockSession({ runReportWithDownload });
    const capture = vi.fn().mockResolvedValue({
      downloads: [{
        fileName: 'Report 6.pdf', contentType: 'application/pdf', sizeBytes: 9, style: 'download',
        bytes: Buffer.from('%PDF-data').toString('base64'),
      }],
      externalUris: [],
    });
    const downloadService = createMockDownloadService({ capture });
    const op = new RunReportOperation(session, new PageContextRepository(), downloadService);

    const result = await op.execute({ reportId: '6', format: 'pdf' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReportWithDownload).toHaveBeenCalledWith(6, 'pdf');
    expect(capture).toHaveBeenCalledWith([], { timeoutMs: 120_000 });
    expect(result.value.downloads).toHaveLength(1);
    expect(Buffer.from(result.value.downloads[0]!.bytes!, 'base64').toString()).toBe('%PDF-data');
    expect(result.value.downloads[0]!.contentType).toBe('application/pdf');
    expect(result.value.downloads[0]!.fileName).toBe('Report 6.pdf');
  });

  it('drives the download flow for format "excel" (passes format through to session)', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({ events: [] }));
    const session = createMockSession({ runReportWithDownload });
    const capture = vi.fn().mockResolvedValue({
      downloads: [{
        fileName: 'Report 6.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 20, style: 'download', bytes: Buffer.from('PK\x03\x04-xlsx-bytes').toString('base64'),
      }],
      externalUris: [],
    });
    const downloadService = createMockDownloadService({ capture });
    const op = new RunReportOperation(session, new PageContextRepository(), downloadService);

    const result = await op.execute({ reportId: '6', format: 'excel' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // Must pass the format to the session so session can drive SaveValue
    expect(runReportWithDownload).toHaveBeenCalledWith(6, 'excel');
    expect(result.value.downloads).toHaveLength(1);
    expect(result.value.downloads[0]!.contentType).toContain('spreadsheet');
    expect(result.value.downloads[0]!.fileName).toBe('Report 6.xlsx');
  });

  it('drives the download flow for format "word" (passes format through to session)', async () => {
    const runReportWithDownload = vi.fn().mockResolvedValue(ok({ events: [] }));
    const session = createMockSession({ runReportWithDownload });
    const capture = vi.fn().mockResolvedValue({
      downloads: [{
        fileName: 'Report 6.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 20, style: 'download', bytes: Buffer.from('PK\x03\x04-docx-bytes').toString('base64'),
      }],
      externalUris: [],
    });
    const downloadService = createMockDownloadService({ capture });
    const op = new RunReportOperation(session, new PageContextRepository(), downloadService);

    const result = await op.execute({ reportId: '120', format: 'word' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReportWithDownload).toHaveBeenCalledWith(120, 'word');
    expect(result.value.downloads).toHaveLength(1);
    expect(result.value.downloads[0]!.contentType).toContain('word');
    expect(result.value.downloads[0]!.fileName).toBe('Report 6.docx');
  });

  it('propagates ProtocolError from session when format is unavailable', async () => {
    const unavailableErr = new ProtocolError('Report 6 does not offer excel; available: PDF Document, Microsoft Word Document');
    const runReportWithDownload = vi.fn().mockResolvedValue(err(unavailableErr));
    const session = createMockSession({ runReportWithDownload });
    const capture = vi.fn();
    const downloadService = createMockDownloadService({ capture });
    const op = new RunReportOperation(session, new PageContextRepository(), downloadService);

    const result = await op.execute({ reportId: '6', format: 'excel' });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toContain('Report 6 does not offer excel');
    // The session failed before any bytes could exist -- DownloadService must not be invoked.
    expect(capture).not.toHaveBeenCalled();
  });

  it('opens request page only when format is omitted (no download)', async () => {
    const runReport = vi.fn().mockResolvedValue(ok([]));
    const session = createMockSession({ runReport });
    const capture = vi.fn();
    const downloadService = createMockDownloadService({ capture });
    const op = new RunReportOperation(session, new PageContextRepository(), downloadService);

    const result = await op.execute({ reportId: '6' });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(runReport).toHaveBeenCalledWith(6);
    expect(session.runReportWithDownload).not.toHaveBeenCalled();
    expect(result.value.downloads).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });
});
