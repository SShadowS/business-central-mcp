import { describe, it, expect, vi } from 'vitest';
import { RunReportOperation } from '../../src/operations/run-report.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { ok, isErr, isOk } from '../../src/core/result.js';

/**
 * Unit coverage for RunReportOperation format handling.
 *
 * The key behaviours under test:
 *  - format omitted  -> opens request page only (calls session.runReport, no download)
 *  - format "pdf"    -> drives the download flow (calls session.runReportWithDownload)
 *  - format "excel"/"word" -> errors BEFORE executing (no BC calls), no silent PDF
 */

function createMockSession(overrides?: Partial<BCSession>): BCSession {
  return {
    runReport: vi.fn(),
    runReportWithDownload: vi.fn(),
    ...overrides,
  } as unknown as BCSession;
}

describe('RunReportOperation format handling', () => {
  it('errors on format "excel" before executing (no BC calls, no silent PDF)', async () => {
    const session = createMockSession();
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6', format: 'excel' });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toBe('Only format "pdf" is currently supported for report capture');

    // Must NOT have touched BC at all.
    expect(session.runReport).not.toHaveBeenCalled();
    expect(session.runReportWithDownload).not.toHaveBeenCalled();
  });

  it('errors on format "word" before executing', async () => {
    const session = createMockSession();
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '120', format: 'word' });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toBe('Only format "pdf" is currently supported for report capture');
    expect(session.runReportWithDownload).not.toHaveBeenCalled();
  });

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
    expect(runReportWithDownload).toHaveBeenCalledWith(6);
    expect(result.value.download).toBeDefined();
    expect(Buffer.from(result.value.download!.bytes, 'base64').toString()).toBe('%PDF-data');
    expect(result.value.download!.contentType).toBe('application/pdf');
    expect(result.value.download!.fileName).toBe('Report 6.pdf');
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
