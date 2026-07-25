/**
 * Integration test: stateVersion (generation token) staleness guard.
 *
 * Verifies against real BC28 (Cronus28) that:
 *   1. bc_open_page and bc_read_data return a stateVersion
 *   2. After a real mutating write, stateVersion advances
 *   3. A write/execute with a stale expectedStateVersion is rejected with STALE_CONTEXT
 *   4. A write/execute with the current stateVersion proceeds normally
 *
 * Flow: Customer List (22) -> drill-down -> Edit=40 -> write Name field
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/staleness.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { SortService } from '../../src/services/sort-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

describe('stateVersion staleness guard (integration, Cronus28)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let openPageOp: OpenPageOperation;
  let readDataOp: ReadDataOperation;
  let writeDataOp: WriteDataOperation;
  let executeActionOp: ExecuteActionOperation;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);

    const filterService = new FilterService(session, repo, logger);
    const sortService = new SortService(session, repo, logger);
    openPageOp = new OpenPageOperation(pageService);
    readDataOp = new ReadDataOperation(dataService, filterService, sortService, repo);
    writeDataOp = new WriteDataOperation(dataService, repo);
    const navigationService = new NavigationService(session, repo, logger);
    executeActionOp = new ExecuteActionOperation(actionService, repo, navigationService, stubDownloadService(logger));
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  it('stateVersion is present in bc_open_page response', async () => {
    const result = await openPageOp.execute({ pageId: '22' });
    expect(isOk(result)).toBe(true);
    const out = unwrap(result);
    openedPages.push(out.pageContextId);

    expect(typeof out.stateVersion).toBe('number');
    expect(out.stateVersion).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('stateVersion is present in bc_read_data response', async () => {
    const openResult = await openPageOp.execute({ pageId: '22' });
    expect(isOk(openResult)).toBe(true);
    const openOut = unwrap(openResult);
    openedPages.push(openOut.pageContextId);

    const readResult = await readDataOp.execute({ pageContextId: openOut.pageContextId });
    expect(isOk(readResult)).toBe(true);
    const readOut = unwrap(readResult);

    expect(typeof readOut.stateVersion).toBe('number');
    expect(readOut.stateVersion).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('stateVersion advances after a real mutating write', async () => {
    // Open Customer List
    const listResult = await openPageOp.execute({ pageId: '22' });
    expect(isOk(listResult)).toBe(true);
    const listOut = unwrap(listResult);
    openedPages.push(listOut.pageContextId);

    // Drill down to Customer Card
    const listRows = unwrap(dataService.readRows(listOut.pageContextId));
    expect(listRows.length).toBeGreaterThan(0);
    const firstBk = listRows[0]!.bookmark;

    const cardResult = await openPageOp.execute({ pageId: '21', bookmark: firstBk });
    expect(isOk(cardResult)).toBe(true);
    const cardOut = unwrap(cardResult);
    openedPages.push(cardOut.pageContextId);

    const stateVersionAfterOpen = cardOut.stateVersion;

    // Enter Edit mode
    const editResult = await actionService.executeSystemAction(cardOut.pageContextId, SystemAction.Edit);
    expect(isOk(editResult)).toBe(true);
    repo.applyToPage(cardOut.pageContextId, unwrap(editResult).events ?? []);

    // Read current stateVersion
    const readBeforeResult = await readDataOp.execute({ pageContextId: cardOut.pageContextId });
    expect(isOk(readBeforeResult)).toBe(true);
    const stateVersionBeforeWrite = unwrap(readBeforeResult).stateVersion;

    // The Edit action should have bumped generation (it applies events)
    expect(stateVersionBeforeWrite).toBeGreaterThanOrEqual(stateVersionAfterOpen);

    // Write a valid name value to trigger a state-mutating BC event
    const currentName = repo.get(cardOut.pageContextId)!.forms.get(
      repo.get(cardOut.pageContextId)!.rootFormId,
    )?.root.properties.caption ?? 'Test';

    const writeResult = await writeDataOp.execute({
      pageContextId: cardOut.pageContextId,
      fields: { Name: currentName }, // write same value — BC still emits PropertyChanged
    });
    expect(isOk(writeResult)).toBe(true);

    // Read stateVersion after write
    const readAfterResult = await readDataOp.execute({ pageContextId: cardOut.pageContextId });
    expect(isOk(readAfterResult)).toBe(true);
    const stateVersionAfterWrite = unwrap(readAfterResult).stateVersion;

    // Generation must have advanced
    expect(stateVersionAfterWrite).toBeGreaterThan(stateVersionBeforeWrite);
  }, 120_000);

  it('write with stale expectedStateVersion is rejected with STALE_CONTEXT', async () => {
    // Open Customer List
    const listResult = await openPageOp.execute({ pageId: '22' });
    expect(isOk(listResult)).toBe(true);
    const listOut = unwrap(listResult);
    openedPages.push(listOut.pageContextId);

    const listRows = unwrap(dataService.readRows(listOut.pageContextId));
    expect(listRows.length).toBeGreaterThan(0);
    const firstBk = listRows[0]!.bookmark;

    const cardResult = await openPageOp.execute({ pageId: '21', bookmark: firstBk });
    expect(isOk(cardResult)).toBe(true);
    const cardOut = unwrap(cardResult);
    openedPages.push(cardOut.pageContextId);

    // Capture stateVersion N
    const staleVersion = cardOut.stateVersion;

    // Trigger a state mutation (Edit action bumps generation)
    const editResult = await actionService.executeSystemAction(cardOut.pageContextId, SystemAction.Edit);
    expect(isOk(editResult)).toBe(true);
    repo.applyToPage(cardOut.pageContextId, unwrap(editResult).events ?? []);

    const currentGen = repo.get(cardOut.pageContextId)!.generation;
    expect(currentGen).toBeGreaterThan(staleVersion);

    // Now attempt a write with the OLD staleVersion — must be rejected
    const writeResult = await writeDataOp.execute({
      pageContextId: cardOut.pageContextId,
      fields: { Name: 'Contoso' },
      expectedStateVersion: staleVersion,
    });

    expect(writeResult.ok).toBe(false);
    if (!writeResult.ok) {
      expect(writeResult.error.code).toBe('STALE_CONTEXT');
    }
  }, 120_000);

  it('write with current expectedStateVersion succeeds', async () => {
    // Open Customer List
    const listResult = await openPageOp.execute({ pageId: '22' });
    expect(isOk(listResult)).toBe(true);
    const listOut = unwrap(listResult);
    openedPages.push(listOut.pageContextId);

    const listRows = unwrap(dataService.readRows(listOut.pageContextId));
    expect(listRows.length).toBeGreaterThan(0);
    const firstBk = listRows[0]!.bookmark;

    const cardResult = await openPageOp.execute({ pageId: '21', bookmark: firstBk });
    expect(isOk(cardResult)).toBe(true);
    const cardOut = unwrap(cardResult);
    openedPages.push(cardOut.pageContextId);

    // Enter Edit mode
    const editResult = await actionService.executeSystemAction(cardOut.pageContextId, SystemAction.Edit);
    expect(isOk(editResult)).toBe(true);
    repo.applyToPage(cardOut.pageContextId, unwrap(editResult).events ?? []);

    // Read CURRENT stateVersion
    const readResult = await readDataOp.execute({ pageContextId: cardOut.pageContextId });
    expect(isOk(readResult)).toBe(true);
    const currentVersion = unwrap(readResult).stateVersion;

    // Write with the current version — must succeed
    const currentName = repo.get(cardOut.pageContextId)!.forms.get(
      repo.get(cardOut.pageContextId)!.rootFormId,
    )?.root.properties.caption ?? 'Test';

    const writeResult = await writeDataOp.execute({
      pageContextId: cardOut.pageContextId,
      fields: { Name: currentName },
      expectedStateVersion: currentVersion,
    });

    expect(writeResult.ok).toBe(true);
  }, 120_000);

  it('execute-action with stale expectedStateVersion is rejected with STALE_CONTEXT', async () => {
    const listResult = await openPageOp.execute({ pageId: '22' });
    expect(isOk(listResult)).toBe(true);
    const listOut = unwrap(listResult);
    openedPages.push(listOut.pageContextId);

    const listRows = unwrap(dataService.readRows(listOut.pageContextId));
    expect(listRows.length).toBeGreaterThan(0);
    const firstBk = listRows[0]!.bookmark;

    const cardResult = await openPageOp.execute({ pageId: '21', bookmark: firstBk });
    expect(isOk(cardResult)).toBe(true);
    const cardOut = unwrap(cardResult);
    openedPages.push(cardOut.pageContextId);

    // Capture staleVersion before mutation
    const staleVersion = cardOut.stateVersion;

    // Trigger state mutation
    const editResult = await actionService.executeSystemAction(cardOut.pageContextId, SystemAction.Edit);
    expect(isOk(editResult)).toBe(true);
    repo.applyToPage(cardOut.pageContextId, unwrap(editResult).events ?? []);

    const currentGen = repo.get(cardOut.pageContextId)!.generation;
    expect(currentGen).toBeGreaterThan(staleVersion);

    // Attempt action with stale version — must be rejected
    const actionResult = await executeActionOp.execute({
      pageContextId: cardOut.pageContextId,
      action: 'Refresh',
      expectedStateVersion: staleVersion,
    });

    expect(actionResult.ok).toBe(false);
    if (!actionResult.ok) {
      expect(actionResult.error.code).toBe('STALE_CONTEXT');
    }
  }, 120_000);
});
