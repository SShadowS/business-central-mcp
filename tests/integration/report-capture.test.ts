import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BCSession } from '../../src/session/bc-session.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { isOk } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

/**
 * Live report-output capture against Cronus28.
 *
 * Proves the end-to-end "Send to..." PDF flow:
 *   OpenForm(report=6) -> InvokeAction(410 SendTo) -> InvokeAction(300 OK)
 *   -> inline UriToShow event (FileDownloadReady) -> GET DynamicFileHandler.axd
 *   -> PDF bytes.
 *
 * The pool builds sessions WITH a reportDownloader (ConnectionFactory.createReportDownloader),
 * so RunReportOperation.executeWithDownload can resolve the captured URL.
 *
 * Report 6 = Trial Balance. It has no mandatory request-page parameters, so the
 * default PDF render succeeds with no SaveValue. If this ever changes, swap to
 * another no-param report that renders a PDF and note it here.
 */
describe('Report output capture (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  }, 60000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('captures a non-empty PDF for report 6 (Trial Balance) via format:pdf', async () => {
    const op = new RunReportOperation(session);

    const result = await op.execute({ reportId: '6', format: 'pdf' });

    if (!isOk(result)) {
      throw new Error(`runReport(format:pdf) failed: ${result.error.message}`);
    }

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.reportId).toBe(6);
    expect(out.download).toBeDefined();

    const dl = out.download!;
    // Bytes are base64; decode and assert non-empty + %PDF magic.
    const buf = Buffer.from(dl.bytes, 'base64');
    console.error(`[TEST] captured report 6: ${buf.length} bytes, contentType=${dl.contentType}, fileName=${dl.fileName ?? '(none)'}`);

    expect(buf.length).toBeGreaterThan(0);
    const magic = buf.subarray(0, 4).toString('latin1');
    expect(magic).toBe('%PDF');

    // contentType should indicate a PDF (BC serves application/pdf; allow octet-stream fallback only if it still parses as PDF).
    expect(dl.contentType.toLowerCase()).toContain('pdf');
  }, 120000);
});
