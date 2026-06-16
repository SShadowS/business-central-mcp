// tests/integration/sort.test.ts
//
// Integration test for bc_read_data sort parameter (Task 3 of field-options plan).
//
// Verified live wire behavior (Cronus28, 2026-06-16):
//   - SortColumn interaction: InvokeAction systemAction=470, controlPath=rcc node
//     (e.g. server:c[3]/co[2] for the Description column of Item List page 31).
//   - SortOrder MUST be nested under a "Data" sub-dictionary in namedParameters:
//     { Data: { SortOrder: 1 } } (asc) / { Data: { SortOrder: 2 } } (desc).
//     A FLAT SortOrder is silently ignored by BC (defaults to Ascending), so the
//     nesting is what makes DESC actually descend.
//     Reference: decompiled InvokeActionExecutionStrategy.cs (reads "Data" dict),
//     SortColumnAction.cs (reads "SortOrder" from that dict).
//   - SortOrder enum (Microsoft.Dynamics.Framework.UI.SortOrder):
//     None=0, Ascending=1, Descending=2.
//
// This test uses Item List (page 31, 49 items in Cronus28) so DESC reversal is
// genuinely observable: asc-first != desc-first, and desc-first sorts AFTER
// asc-first. With the old flat encoding asc-first == desc-first and the test FAILS.
//
// Rules: uses integrationPool; no 2>/dev/null; no emojis.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { SortService } from '../../src/services/sort-service.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

const SORT_COLUMN = 'Description';

describe.sequential('bc_read_data sort — integration (Cronus28)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let readData: ReadDataOperation;
  let repo: PageContextRepository;
  const logger = createNullLogger();

  let pageContextId: string;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    const filterService = new FilterService(session, repo, logger);
    const sortService = new SortService(session, repo, logger);
    readData = new ReadDataOperation(dataService, filterService, sortService, repo);

    // Open Item List (page 31) — a list page with ~49 rows and a Description column
    const ctx = unwrap(await pageService.openPage('31', { tenantId: 'default' }));
    pageContextId = ctx.pageContextId;
  }, 60000);

  afterAll(async () => {
    if (pageContextId) {
      await pageService.closePage(pageContextId, { discardChanges: true }).catch(() => {});
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it(`sort asc by ${SORT_COLUMN} returns rows in ascending order`, async () => {
    const result = await readData.execute({
      pageContextId,
      sort: { column: SORT_COLUMN, direction: 'asc' },
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const rows = result.value.section.rows ?? [];
    expect(rows.length).toBeGreaterThan(1);

    const values = rows.map(r => String(r.cells[SORT_COLUMN] ?? ''));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!.localeCompare(values[i - 1]!)).toBeGreaterThanOrEqual(0);
    }
  }, 30000);

  it(`sort desc by ${SORT_COLUMN} returns rows in descending order`, async () => {
    const result = await readData.execute({
      pageContextId,
      sort: { column: SORT_COLUMN, direction: 'desc' },
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const rows = result.value.section.rows ?? [];
    expect(rows.length).toBeGreaterThan(1);

    const values = rows.map(r => String(r.cells[SORT_COLUMN] ?? ''));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!.localeCompare(values[i - 1]!)).toBeLessThanOrEqual(0);
    }
  }, 30000);

  it('asc-first and desc-first DIFFER and desc-first sorts last (DESC genuinely reverses)', async () => {
    // This is the regression guard for the flat-vs-nested SortOrder bug. With the
    // old flat encoding, DESC silently no-ops (defaults to Ascending) so asc-first
    // == desc-first and this assertion FAILS. With Data-nesting, DESC reverses.
    const ascResult = await readData.execute({
      pageContextId,
      sort: { column: SORT_COLUMN, direction: 'asc' },
    });
    const descResult = await readData.execute({
      pageContextId,
      sort: { column: SORT_COLUMN, direction: 'desc' },
    });

    expect(isOk(ascResult)).toBe(true);
    expect(isOk(descResult)).toBe(true);
    if (!isOk(ascResult) || !isOk(descResult)) return;

    const ascRows = ascResult.value.section.rows ?? [];
    const descRows = descResult.value.section.rows ?? [];
    expect(ascRows.length).toBeGreaterThan(1);
    expect(descRows.length).toBeGreaterThan(1);

    const ascFirst = String(ascRows[0]!.cells[SORT_COLUMN] ?? '');
    const descFirst = String(descRows[0]!.cells[SORT_COLUMN] ?? '');

    // The two top rows must differ — proof DESC is not a silent no-op.
    expect(ascFirst).not.toBe(descFirst);
    // And the descending top value must sort AFTER the ascending top value.
    expect(descFirst.localeCompare(ascFirst)).toBeGreaterThan(0);
  }, 60000);

  it('sort with non-existent column returns ProtocolError with availableColumns', async () => {
    const result = await readData.execute({
      pageContextId,
      sort: { column: 'NoSuchColumnXYZ', direction: 'asc' },
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.message).toContain('NoSuchColumnXYZ');
    expect(result.error.context).toBeDefined();
    const ctx = result.error.context as Record<string, unknown>;
    expect(Array.isArray(ctx.availableColumns)).toBe(true);
  }, 30000);
});
