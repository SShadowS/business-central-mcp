/**
 * DESTRUCTIVE integration test: stateVersion advances on a real write.
 *
 * Writes "Address 2" on the first customer and restores it (in finally, asserting
 * BC echoed the restore). Destructive tier only: run with permission via
 *   npx vitest run --config vitest.destructive.config.ts tests/integration/staleness-destructive.test.ts
 *
 * These cases used to write `Name` with the form's page caption ("Customer Card")
 * under a "write same value" comment, which renamed customer 10000 for real (the
 * card saves the dirty record on CloseForm: decompiled
 * SaveOnNavigationPattern.FormClosing -> Save(SaveDraftAction.SaveDirty)).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { SortService } from '../../src/services/sort-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { expectRestored } from './helpers/restore.js';

describe('stateVersion on real writes (DESTRUCTIVE, writes a customer)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let openPageOp: OpenPageOperation;
  let readDataOp: ReadDataOperation;
  let writeDataOp: WriteDataOperation;

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
    readDataOp = new ReadDataOperation(dataService, new FilterService(session, repo, logger), new SortService(session, repo, logger), repo);
    writeDataOp = new WriteDataOperation(dataService, repo);
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  /** Customer List -> first customer's card in edit mode. */
  async function openFirstCustomerInEdit(): Promise<{ pageContextId: string; stateVersion: number }> {
    const listOut = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(listOut.pageContextId);
    const listRows = unwrap(dataService.readRows(listOut.pageContextId));
    expect(listRows.length).toBeGreaterThan(0);

    const cardOut = unwrap(await openPageOp.execute({ pageId: '21', bookmark: listRows[0]!.bookmark }));
    openedPages.push(cardOut.pageContextId);

    const editResult = await actionService.executeSystemAction(cardOut.pageContextId, SystemAction.Edit);
    expect(isOk(editResult)).toBe(true);
    repo.applyToPage(cardOut.pageContextId, unwrap(editResult).events ?? []);
    return cardOut;
  }

  /** Current stored value of a card field (never the page caption). */
  function fieldValue(pageContextId: string, caption: string): string {
    const f = unwrap(dataService.readField(pageContextId, caption));
    expect(f, `field "${caption}" not on the card`).toBeDefined();
    return f!.stringValue ?? '';
  }

  it('stateVersion advances after a real mutating write', async () => {
    const cardOut = await openFirstCustomerInEdit();
    const stateVersionAfterOpen = cardOut.stateVersion;

    const stateVersionBeforeWrite = unwrap(await readDataOp.execute({ pageContextId: cardOut.pageContextId })).stateVersion;
    // The Edit action should have bumped generation (it applies events)
    expect(stateVersionBeforeWrite).toBeGreaterThanOrEqual(stateVersionAfterOpen);

    // A CHANGED value: BC echoes only a value that changed (decompiled
    // LogicalControlObserver.BeforeGetChanges), and only echoed events advance the generation.
    const original = fieldValue(cardOut.pageContextId, 'Address 2');
    const probe = original === 'STALENESS' ? 'STALENESS2' : 'STALENESS';
    try {
      const writeResult = await writeDataOp.execute({ pageContextId: cardOut.pageContextId, fields: { 'Address 2': probe } });
      expect(isOk(writeResult)).toBe(true);

      const stateVersionAfterWrite = unwrap(await readDataOp.execute({ pageContextId: cardOut.pageContextId })).stateVersion;
      expect(stateVersionAfterWrite).toBeGreaterThan(stateVersionBeforeWrite);
    } finally {
      const restore = unwrap(await writeDataOp.execute({ pageContextId: cardOut.pageContextId, fields: { 'Address 2': original } }));
      expectRestored(restore.results[0], original);
    }
  }, 120_000);

  it('write with current expectedStateVersion succeeds', async () => {
    const cardOut = await openFirstCustomerInEdit();
    const currentVersion = unwrap(await readDataOp.execute({ pageContextId: cardOut.pageContextId })).stateVersion;

    // Rewrite the field's own stored value (read from the field, not the page caption).
    const currentName = fieldValue(cardOut.pageContextId, 'Name');
    expect(currentName).not.toBe('');

    const writeResult = await writeDataOp.execute({
      pageContextId: cardOut.pageContextId,
      fields: { Name: currentName },
      expectedStateVersion: currentVersion,
    });
    expect(writeResult.ok).toBe(true);
    expect(fieldValue(cardOut.pageContextId, 'Name')).toBe(currentName);
  }, 120_000);
});
