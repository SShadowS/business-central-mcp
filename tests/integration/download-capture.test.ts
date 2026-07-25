import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { realDownloadService } from './helpers/download-service.js';

dotenvConfig();

/**
 * Live download-capture verification against Cronus28, exercising
 * ExecuteActionOperation's composition with DownloadService end-to-end
 * (not RunReportOperation, already covered by report-capture.test.ts).
 *
 * Covers two of the three protocol paths named in Task 9:
 *   1. No-download action (Refresh) -> downloads: [], externalUris: [].
 *   2. List export action ("Open in Excel" on Customer List page 22) ->
 *      one captured download whose bytes are a valid xlsx (PK zip magic).
 *   3. Report 6 PDF via bc_run_report is already proven end-to-end by
 *      report-capture.test.ts -- not duplicated here.
 *
 * Auth note: the download-fetching DownloadService is built from `lease.auth`
 * -- the SAME already-authenticated NTLMAuthProvider `session-pool.ts` used to
 * establish this session's /csh WebSocket connection. DynamicFileHandler.axd
 * ties a generated file to that specific auth session, not merely to the
 * username; a fresh independent login 404s (confirmed live via
 * scripts/diag-download-404.ts). See `PooledLease.auth`'s doc comment.
 *
 * Excel action caption note: Customer List (page 22) exposes exactly one
 * Excel-flavoured ribbon action, captioned "Open in Excel" (systemAction=165,
 * SendToExcelServer per decompiled SystemAction.cs / NavExportDataToDocumentAction.cs).
 * Despite the "Open in Excel" caption -- which elsewhere (e.g. OData add-in
 * launchers) denotes a client-side Office.js add-in that never touches the
 * wire -- this ribbon button is wired to the SERVER-SIDE SendToExcelServer
 * system action, confirmed live to emit a `FileDownloadReady` event
 * (relativeUrl=DynamicFileHandler.axd?...&fname=Customers.xlsx) exactly like
 * the report "Send to" flow. There is no separate "Send to Excel" caption on
 * this page/build; "Open in Excel" IS the UriToShow-emitting export here.
 */
describe('Download capture via ExecuteActionOperation (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let executeAction: ExecuteActionOperation;
  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const cfg = loadConfig();
    const downloadService = realDownloadService(cfg.bc, () => lease.auth.getWebSocketHeaders(), logger);

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    const actionService = new ActionService(session, repo, logger);
    const navigationService = new NavigationService(session, repo, logger);
    executeAction = new ExecuteActionOperation(actionService, repo, navigationService, downloadService);
  }, 60000);

  afterAll(async () => {
    for (const ctxId of openedPages) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('an action with no file (Refresh) yields empty downloads and externalUris', async () => {
    const openResult = await pageService.openPage('22');
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);
    openedPages.push(ctx.pageContextId);

    const result = await executeAction.execute({ pageContextId: ctx.pageContextId, action: 'Refresh' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.downloads).toEqual([]);
    expect(out.externalUris).toEqual([]);
  }, 60000);

  it('captures an Excel file from Customer List (page 22) "Open in Excel" export', async () => {
    const openResult = await pageService.openPage('22');
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);
    openedPages.push(ctx.pageContextId);

    const result = await executeAction.execute({
      pageContextId: ctx.pageContextId,
      action: 'Open in Excel',
      section: 'header',
    });

    if (!isOk(result)) {
      throw new Error(`executeAction('Open in Excel') failed: ${result.error.message}`);
    }

    const out = result.value;
    expect(out.success).toBe(true);
    expect(out.downloads).toHaveLength(1);
    expect(out.downloads[0]!.error).toBeUndefined();

    const dl = out.downloads[0]!;
    const buf = Buffer.from(dl.bytes!, 'base64');
    console.error(`[TEST] captured Customer List Excel export: ${buf.length} bytes, contentType=${dl.contentType}, fileName=${dl.fileName ?? '(none)'}`);

    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  }, 60000);
});
