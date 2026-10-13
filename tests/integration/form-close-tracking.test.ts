/**
 * Integration test (#31): BC reports a real form close as PropertyChanged
 * State=0 on the form's server: path, and BCSession turns it into FormClosed
 * for open-form / modal tracking and PageContextRepository. Read-only: opens
 * an existing customer card in view mode and cancels a report request page.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/form-close-tracking.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { RunReportOperation } from '../../src/operations/run-report.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

/** Collect the formIds of every FormClosed the session derives until restore(). */
function captureFormClosed(session: BCSession): { closes: string[]; restore: () => void } {
  const closes: string[] = [];
  const original = session.invoke;
  session.invoke = (async (...args: Parameters<BCSession['invoke']>) => {
    const result = await original.apply(session, args);
    if (result.ok) for (const e of result.value) if (e.type === 'FormClosed') closes.push(e.formId);
    return result;
  }) as BCSession['invoke'];
  return { closes, restore: () => { session.invoke = original; } };
}

describe('form close tracking (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let openPageOp: OpenPageOperation;
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
    const downloads = stubDownloadService(logger);
    openPageOp = new OpenPageOperation(pageService);
    runReportOp = new RunReportOperation(session, repo, downloads);
    respondDialogOp = new RespondDialogOperation(session, repo, downloads);
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  it('cancelling a report request page drops it from the modal stack and openFormIds', async () => {
    const report = unwrap(await runReportOp.execute({ reportId: '6' }));
    const formId = report.requestPage!.formId;
    expect(session.openFormIds.has(formId)).toBe(true);

    unwrap(await respondDialogOp.execute({ pageContextId: report.requestPage!.pageContextId, dialogFormId: formId, response: 'cancel' }));

    expect(session.modalStackSnapshot()).toEqual([]);
    expect(session.openFormIds.has(formId)).toBe(false);
  }, 60_000);

  it('a card with factboxes produces no false closes; closing it drops every form', async () => {
    const list = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(list.pageContextId);
    const bookmark = unwrap(dataService.readRows(list.pageContextId))[0]!.bookmark;
    const { closes, restore } = captureFormClosed(session);
    try {
      const card = unwrap(await openPageOp.execute({ pageId: '21', bookmark }));
      openedPages.push(card.pageContextId);

      const ctx = repo.get(card.pageContextId)!;
      expect(ctx.forms.size).toBeGreaterThan(1); // root + factboxes
      expect(session.openFormIds.has(ctx.rootFormId)).toBe(true);
      expect(closes).toEqual([]);
      // A FormClosed would have dropped the part's form (markFormClosed).
      expect([...ctx.sections.values()].filter(s => !ctx.forms.has(s.formId)).map(s => s.sectionId)).toEqual([]);

      await pageService.closePage(card.pageContextId, { discardChanges: true });
      expect(closes).toContain(ctx.rootFormId);
    } finally {
      restore();
    }
  }, 120_000);
});

describe('form close tracking on a Role Center (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;

  beforeAll(async () => {
    lease = await integrationPool.checkOut({ profile: 'BUSINESS MANAGER' });
    session = lease.session;
  }, 60_000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  it('loading the hosted CardParts produces no false closes', async () => {
    const repo = new PageContextRepository();
    const pageService = new PageService(session, repo, createNullLogger());
    const { closes, restore } = captureFormClosed(session);
    try {
      const rc = unwrap(await new OpenPageOperation(pageService).execute({ pageId: '9022' }));
      expect(rc.pageType).toBe('RoleCenter');
      const ctx = repo.get(rc.pageContextId)!;
      expect(ctx.forms.size).toBeGreaterThan(1);
      expect(closes).toEqual([]);
      expect(session.openFormIds.has(ctx.rootFormId)).toBe(true);
      // A FormClosed would have dropped the part's form (markFormClosed).
      expect([...ctx.sections.values()].filter(s => !ctx.forms.has(s.formId)).map(s => s.sectionId)).toEqual([]);
    } finally {
      restore();
    }
  }, 120_000);
});
