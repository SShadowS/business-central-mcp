/**
 * Integration test: a rejected field write surfaces as a typed validation error.
 *
 * Writes an unparseable value to "Credit Limit (LCY)" on the first customer's card
 * in edit mode. BC rejects it before it reaches the record, so nothing is stored;
 * WriteDataOperation must return Err(BusinessValidationError).
 *
 * The wire-shape probe (raw SaveValues across many fields, some of which BC accepts)
 * writes the record and lives in validation-errors-destructive.test.ts.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/validation-errors.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import type { BusinessValidationError } from '../../src/core/errors.js';

describe('Validation errors (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let repo: PageContextRepository;
  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
  }, 30_000);

  afterAll(async () => {
    for (const ctxId of openedPages) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('WriteDataOperation returns typed Err(BusinessValidationError) for a rejected numeric write', async () => {
    // Repro: Customer List -> drill to Customer Card -> Edit -> write garbage to Credit Limit (LCY)
    const writeOp = new WriteDataOperation(dataService, repo);

    // Open Customer List
    const listResult = await pageService.openPage('22');
    expect(isOk(listResult)).toBe(true);
    const listCtx = unwrap(listResult);
    openedPages.push(listCtx.pageContextId);

    // Open Customer Card (page 21) directly with the first customer's bookmark
    const rows = unwrap(dataService.readRows(listCtx.pageContextId));
    expect(rows.length).toBeGreaterThan(0);
    const firstBookmark = rows[0]!.bookmark;

    const cardResult = await pageService.openPage('21', { bookmark: firstBookmark });
    expect(isOk(cardResult)).toBe(true);
    const cardCtx = unwrap(cardResult);
    openedPages.push(cardCtx.pageContextId);

    // Enter Edit mode
    const editResult = await actionService.executeSystemAction(cardCtx.pageContextId, SystemAction.Edit);
    if (isOk(editResult)) {
      repo.applyToPage(cardCtx.pageContextId, editResult.value.events ?? []);
    }

    // Write an invalid value to Credit Limit (LCY) via WriteDataOperation
    const writeResult = await writeOp.execute({
      pageContextId: cardCtx.pageContextId,
      fields: { 'Credit Limit (LCY)': 'notanumber$$' },
    });

    expect(isErr(writeResult)).toBe(true);
    if (isErr(writeResult)) {
      const e = writeResult.error as BusinessValidationError;
      expect(e.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(e.fieldErrors)).toBe(true);
      expect(e.fieldErrors.length).toBeGreaterThan(0);
      const desc = e.fieldErrors[0]!.description;
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
      console.error(`[WriteDataOp] BusinessValidationError: ${desc}`);
    }
  }, 120_000);
});
