/**
 * Integration test: replaySafe verdicts (#24) against live BC.
 *
 * Codifies the probe findings the rules in src/protocol/replay-safety.ts rest on:
 *   - a changed card value is echoed (replaySafe true); rewriting the same value
 *     is not echoed (false: unproven)
 *   - Refresh is replay-safe
 *   - Cancel on a report request page closes the dialog form (State=0) -> true
 *   - close_page with no blocking dialog -> true
 *
 * Writes Address 2 on the first customer and restores it.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/replay-safety.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { SystemAction } from '../../src/protocol/types.js';
import { fields as treeFields } from '../../src/protocol/form-views.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { loadConfig } from '../../src/core/config.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

describe('replaySafe verdicts (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let openPageOp: OpenPageOperation;
  let writeDataOp: WriteDataOperation;
  let executeActionOp: ExecuteActionOperation;
  let closePageOp: ClosePageOperation;
  let runReportOp: RunReportOperation;
  let respondDialogOp: RespondDialogOperation;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    const downloads = stubDownloadService(logger);
    openPageOp = new OpenPageOperation(pageService);
    writeDataOp = new WriteDataOperation(dataService, repo);
    executeActionOp = new ExecuteActionOperation(actionService, repo, new NavigationService(session, repo, logger), downloads, loadConfig().bc.maxSelection);
    closePageOp = new ClosePageOperation(pageService);
    runReportOp = new RunReportOperation(session, repo, downloads);
    respondDialogOp = new RespondDialogOperation(session, repo, downloads);
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  it('write_data is replay-safe only when BC echoes the value; close_page without a dialog is replay-safe', async () => {
    const list = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(list.pageContextId);
    const bookmark = unwrap(dataService.readRows(list.pageContextId))[0]!.bookmark;
    const card = unwrap(await openPageOp.execute({ pageId: '21', bookmark }));
    expect(isOk(await actionService.executeSystemAction(card.pageContextId, SystemAction.Edit))).toBe(true);

    const ctx = repo.get(card.pageContextId)!;
    const original = treeFields(ctx.forms.get(ctx.rootFormId)!.root)
      .find(f => f.properties.caption === 'Address 2')?.properties.stringValue ?? '';
    const probe = original === 'REPLAYSAFE' ? 'REPLAYSAFE2' : 'REPLAYSAFE';

    try {
      const changed = unwrap(await writeDataOp.execute({ pageContextId: card.pageContextId, fields: { 'Address 2': probe } }));
      expect(changed.replaySafe).toBe(true);
      const same = unwrap(await writeDataOp.execute({ pageContextId: card.pageContextId, fields: { 'Address 2': probe } }));
      expect(same.replaySafe).toBe(false);
    } finally {
      await writeDataOp.execute({ pageContextId: card.pageContextId, fields: { 'Address 2': original } });
    }

    const closed = unwrap(await closePageOp.execute({ pageContextId: card.pageContextId }));
    expect(closed.replaySafe).toBe(true);
  }, 120_000);

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
