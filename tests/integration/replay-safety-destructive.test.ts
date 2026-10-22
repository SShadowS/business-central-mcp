/**
 * DESTRUCTIVE integration test: replaySafe verdict of a real card write (#24).
 *
 *   - a changed card value is echoed (replaySafe true); rewriting the same value
 *     is not echoed (false: unproven)
 *   - close_page with no blocking dialog -> true
 *
 * Writes Address 2 on the first customer; restores it in finally and asserts BC
 * echoed the restore. Destructive tier only: run with permission via
 *   npx vitest run --config vitest.destructive.config.ts tests/integration/replay-safety-destructive.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { SystemAction } from '../../src/protocol/types.js';
import { fields as treeFields } from '../../src/protocol/form-views.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { expectRestored } from './helpers/restore.js';

describe('replaySafe verdict of a real write (DESTRUCTIVE, writes a customer)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let openPageOp: OpenPageOperation;
  let writeDataOp: WriteDataOperation;
  let closePageOp: ClosePageOperation;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    openPageOp = new OpenPageOperation(pageService);
    writeDataOp = new WriteDataOperation(dataService, repo);
    closePageOp = new ClosePageOperation(pageService, repo);
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
    openedPages.push(card.pageContextId);
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
      const restore = unwrap(await writeDataOp.execute({ pageContextId: card.pageContextId, fields: { 'Address 2': original } }));
      expectRestored(restore.results[0], original);
    }

    const closed = unwrap(await closePageOp.execute({ pageContextId: card.pageContextId }));
    expect(closed.replaySafe).toBe(true);
  }, 120_000);
});
