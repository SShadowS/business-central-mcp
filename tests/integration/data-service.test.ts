import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('DataService (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
  });

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('reads rows from Customer List (page 22)', async () => {
    const openResult = await pageService.openPage('22');
    expect(isOk(openResult)).toBe(true);
    const state = unwrap(openResult);

    const rowsResult = dataService.readRows(state.pageContextId);
    expect(isOk(rowsResult)).toBe(true);
    const rows = unwrap(rowsResult);

    console.error(`Customer List rows: ${rows.length}`);
    if (rows.length > 0) {
      console.error('First row cells:', JSON.stringify(rows[0]!.cells, null, 2));
      console.error('First row bookmark:', rows[0]!.bookmark);
    }
  });

  it('reads fields from Customer Card (page 21)', async () => {
    const openResult = await pageService.openPage('21');
    expect(isOk(openResult)).toBe(true);
    const state = unwrap(openResult);

    const fieldsResult = dataService.getFields(state.pageContextId);
    expect(isOk(fieldsResult)).toBe(true);
    const fields = unwrap(fieldsResult);

    console.error(`Customer Card: ${fields.length} fields`);
    const withCaptions = fields.filter(f => f.caption);
    console.error(`  With captions: ${withCaptions.length}`);
    for (const f of withCaptions.slice(0, 15)) {
      console.error(`  ${f.caption}: "${f.stringValue ?? ''}" [editable=${f.editable}, path=${f.controlPath}]`);
    }
    const withValues = fields.filter(f => f.stringValue);
    console.error(`  With values: ${withValues.length}`);
    for (const f of withValues.slice(0, 10)) {
      console.error(`  ${f.controlPath}: "${f.stringValue}" (caption: ${f.caption || 'none'})`);
    }
  });
});
