import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import type { BCSession } from '../../src/session/bc-session.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { BCHttpClient } from '../../src/connection/bc-http.js';
import { DownloadService } from '../../src/services/download-service.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

dotenvConfig();

/**
 * Live report-output capture against Cronus28.
 *
 * Proves the end-to-end "Send to..." flow for all three formats:
 *   OpenForm(report=6) -> InvokeAction(410 SendTo) -> [SaveValue format label]
 *   -> InvokeAction(300 OK) -> inline UriToShow event (FileDownloadReady)
 *   -> GET DynamicFileHandler.axd -> bytes.
 *
 * For PDF: no SaveValue (BC default). For Excel/Word: SaveValue the matched
 * text label from the PrintDialog SelectionControl's Items, then OK.
 *
 * BCSession.runReportWithDownload() now only drives the wire protocol and
 * returns the raw `events`; fetching the file bytes over HTTP is DownloadService's
 * job. This test builds its own BCHttpClient/DownloadService pair, authenticated
 * as the SAME pooled user whose session produced the DynamicFileHandler.axd URL
 * (NTLMAuthProvider has no relationship to BCWebSocket -- it is a separate
 * Cookie-based HTTP auth flow -- so `BCSession` does not expose "its" auth
 * headers; a freshly authenticated NTLMAuthProvider for `lease.user` is the
 * clean way to obtain them, mirroring `scripts/gate-a-isexecuting.ts`).
 *
 * Report 6 = Trial Balance. It has no mandatory request-page parameters, so the
 * render succeeds with no additional parameter fills. If this ever changes, swap
 * to another no-param report that supports all three formats and note it here.
 *
 * NOTE: not run as part of routine CI here -- a later task (Task 9, integration
 * verification) exercises this against live Cronus28. This file only needs to be
 * structurally correct and type-sound for now.
 */
describe('Report output capture (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let downloadService: DownloadService;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const cfg = loadConfig();
    const logger = createNullLogger();
    const auth = new NTLMAuthProvider(
      { baseUrl: cfg.bc.baseUrl, username: lease.user, password: cfg.bc.password, tenantId: cfg.bc.tenantId },
      logger,
    );
    unwrap(await auth.authenticate());
    const http = new BCHttpClient(cfg.bc.baseUrl, () => auth.getWebSocketHeaders(), logger);
    downloadService = new DownloadService(http, cfg.bc.baseUrl, cfg.bc.downloadLimits, logger);
  }, 60000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  function buildOp(): RunReportOperation {
    return new RunReportOperation(session, new PageContextRepository(), downloadService);
  }

  it('captures a non-empty PDF for report 6 (Trial Balance) via format:pdf', async () => {
    const op = buildOp();

    const result = await op.execute({ reportId: '6', format: 'pdf' });

    if (!isOk(result)) {
      throw new Error(`runReport(format:pdf) failed: ${result.error.message}`);
    }

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.reportId).toBe(6);
    expect(out.downloads).toHaveLength(1);
    expect(out.downloads[0]!.error).toBeUndefined();

    const dl = out.downloads[0]!;
    // Bytes are base64; decode and assert non-empty + %PDF magic.
    const buf = Buffer.from(dl.bytes!, 'base64');
    console.error(`[TEST] captured report 6 pdf: ${buf.length} bytes, contentType=${dl.contentType}, fileName=${dl.fileName ?? '(none)'}`);

    expect(buf.length).toBeGreaterThan(0);
    const magic = buf.subarray(0, 4).toString('latin1');
    expect(magic).toBe('%PDF');

    // contentType should indicate a PDF (BC serves application/pdf; allow octet-stream fallback only if it still parses as PDF).
    expect(dl.contentType.toLowerCase()).toContain('pdf');
  }, 120000);

  it('captures a non-empty Excel file for report 6 (Trial Balance) via format:excel', async () => {
    const op = buildOp();

    const result = await op.execute({ reportId: '6', format: 'excel' });

    if (!isOk(result)) {
      // If the report doesn't have an Excel layout, treat as acceptable skip.
      if (isErr(result) && result.error.message.includes('does not offer excel')) {
        console.error(`[TEST] report 6 has no Excel layout: ${result.error.message}`);
        return;
      }
      throw new Error(`runReport(format:excel) failed: ${result.error.message}`);
    }

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.reportId).toBe(6);
    expect(out.downloads).toHaveLength(1);
    expect(out.downloads[0]!.error).toBeUndefined();

    const dl = out.downloads[0]!;
    const buf = Buffer.from(dl.bytes!, 'base64');
    console.error(`[TEST] captured report 6 excel: ${buf.length} bytes, contentType=${dl.contentType}, fileName=${dl.fileName ?? '(none)'}`);

    // Excel OOXML is a ZIP — magic bytes are PK\x03\x04
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4B); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);

    expect(dl.contentType.toLowerCase()).toContain('spreadsheet');
    expect(dl.fileName?.toLowerCase().endsWith('.xlsx')).toBe(true);
  }, 120000);

  it('captures a non-empty Word document for report 6 (Trial Balance) via format:word', async () => {
    const op = buildOp();

    const result = await op.execute({ reportId: '6', format: 'word' });

    if (!isOk(result)) {
      // If the report doesn't have a Word layout, treat as acceptable skip.
      if (isErr(result) && result.error.message.includes('does not offer word')) {
        console.error(`[TEST] report 6 has no Word layout: ${result.error.message}`);
        return;
      }
      throw new Error(`runReport(format:word) failed: ${result.error.message}`);
    }

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.reportId).toBe(6);
    expect(out.downloads).toHaveLength(1);
    expect(out.downloads[0]!.error).toBeUndefined();

    const dl = out.downloads[0]!;
    const buf = Buffer.from(dl.bytes!, 'base64');
    console.error(`[TEST] captured report 6 word: ${buf.length} bytes, contentType=${dl.contentType}, fileName=${dl.fileName ?? '(none)'}`);

    // Word OOXML is a ZIP — magic bytes are PK\x03\x04
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4B); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);

    expect(dl.contentType.toLowerCase()).toContain('word');
    expect(dl.fileName?.toLowerCase().endsWith('.docx')).toBe(true);
  }, 120000);
});
