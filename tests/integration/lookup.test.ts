import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { LookupService } from '../../src/services/lookup-service.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('LookupService (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let lookupService: LookupService;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    lookupService = new LookupService(session, repo, logger);
  }, 60_000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('returns salesperson candidates from Customer Card (page 21)', async () => {
    const openResult = await pageService.openPage('21');
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);

    const lookupResult = await lookupService.lookup(ctx.pageContextId, 'Salesperson Code');

    if (isErr(lookupResult)) {
      console.error(`Lookup ERROR: ${lookupResult.error.message}`);
    }
    expect(isOk(lookupResult)).toBe(true);
    const { rows, totalFound } = unwrap(lookupResult);

    console.error(`Salesperson Code lookup: ${rows.length} rows`);
    if (rows.length > 0) {
      console.error('First row:', JSON.stringify(rows[0]));
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.values).toBe('object');
      expect(Object.keys(row.values).length).toBeGreaterThan(0);
    }
    expect(totalFound).toBe(rows.length);

    // Verify non-mutating: page field still exists after lookup
    const dataService = new DataService(session, repo, logger);
    const fields = unwrap(dataService.getFields(ctx.pageContextId));
    const salespersonField = fields.find(f => f.caption === 'Salesperson Code');
    expect(salespersonField).toBeDefined();
  }, 60_000);

  it('returns rows with search filter applied', async () => {
    const openResult = await pageService.openPage('21');
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);

    const allResult = await lookupService.lookup(ctx.pageContextId, 'Salesperson Code');
    const allRows = isOk(allResult) ? unwrap(allResult).rows : [];

    const filteredResult = await lookupService.lookup(ctx.pageContextId, 'Salesperson Code', { search: 'A' });

    console.error(`Salesperson lookup all=${allRows.length}, filtered=${isOk(filteredResult) ? filteredResult.value.rows.length : 'err'}`);

    // Must not error (even if BC's search doesn't narrow, returning all rows is acceptable)
    expect(isOk(filteredResult)).toBe(true);
    if (isOk(filteredResult)) {
      expect(filteredResult.value.rows.length).toBeLessThanOrEqual(allRows.length);
    }
  }, 60_000);

  it('returns error for a field with no lookup (Name field)', async () => {
    const openResult = await pageService.openPage('21');
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);

    const result = await lookupService.lookup(ctx.pageContextId, 'Name');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      console.error(`Expected error: ${result.error.message}`);
      expect(result.error.message).toMatch(/no lookup|isLookup/i);
    }
  }, 60_000);
});
