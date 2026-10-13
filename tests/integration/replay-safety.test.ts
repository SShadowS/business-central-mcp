/**
 * Integration test: replaySafe verdicts (#24) against live BC.
 *
 * Codifies the probe findings the rules in src/protocol/replay-safety.ts rest on:
 *   - Refresh is replay-safe
 *   - Cancel on a report request page closes the dialog form (State=0) -> true
 *
 * Read-only. The write_data / close_page verdicts write a real customer and live in
 * replay-safety-destructive.test.ts.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/replay-safety.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { unwrap } from '../../src/core/result.js';
import { loadConfig } from '../../src/core/config.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

describe('replaySafe verdicts (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let openPageOp: OpenPageOperation;
  let executeActionOp: ExecuteActionOperation;
  let runReportOp: RunReportOperation;
  let respondDialogOp: RespondDialogOperation;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    const actionService = new ActionService(session, repo, logger);
    const downloads = stubDownloadService(logger);
    openPageOp = new OpenPageOperation(pageService);
    executeActionOp = new ExecuteActionOperation(actionService, repo, new NavigationService(session, repo, logger), downloads, loadConfig().bc.maxSelection);
    runReportOp = new RunReportOperation(session, repo, downloads);
    respondDialogOp = new RespondDialogOperation(session, repo, downloads);
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  it('Refresh is replay-safe', async () => {
    const list = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(list.pageContextId);
    const out = unwrap(await executeActionOp.execute({ pageContextId: list.pageContextId, action: 'Refresh' }));
    expect(out.replaySafe).toBe(true);
  }, 60_000);

  it('cancelling a report request page closes the dialog form, so respond_dialog is replay-safe; run_report never is', async () => {
    const report = unwrap(await runReportOp.execute({ reportId: '6' }));
    expect(report.replaySafe).toBe(false);
    expect(report.requestPage).toBeDefined();
    const out = unwrap(await respondDialogOp.execute({
      pageContextId: report.requestPage!.pageContextId,
      dialogFormId: report.requestPage!.formId,
      response: 'cancel',
    }));
    expect(out.replaySafe).toBe(true);
  }, 60_000);
});
