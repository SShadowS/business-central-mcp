import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { derivePageState } from '../../src/protocol/types.js';
import { repeaters } from '../../src/protocol/form-views.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('BC28 Compatibility (integration)', () => {
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
  }, 60000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('connects and establishes session on BC28', () => {
    expect(session.isAlive).toBe(true);
    console.error('[BC28] Session established');
  });

  it('opens Customer List (page 22) with fields and rows', async () => {
    const result = await pageService.openPage('22', { tenantId: 'default' });
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const state = derivePageState(ctx);

    const headerForm = ctx.forms.get(ctx.rootFormId);
    expect(headerForm).toBeDefined();
    const headerRepeaters = repeaters(headerForm!.root);
    const primaryRepeater = headerRepeaters.values().next().value;
    const repeaterRows = primaryRepeater
      ? (headerForm!.rows.get(primaryRepeater.controlPath) ?? [])
      : [];

    console.error('[BC28] Page 22:', {
      pageType: state.pageType,
      fields: state.controlTree.length,
      actions: state.actions.length,
      rows: repeaterRows.length,
      columns: primaryRepeater?.columns.length ?? 0,
    });

    expect(state.formId).toBeTruthy();
    expect(state.pageType).toBe('List');
    // Customer List is a List page -- its primary content is rows in a repeater,
    // not card fields. Verify the page has at least one repeater section.
    expect(headerRepeaters.size).toBeGreaterThan(0);
    expect(primaryRepeater).toBeDefined();
    expect(primaryRepeater!.columns.length).toBeGreaterThan(0);
  }, 30000);

  it('opens Customer Card (page 21) with fields', async () => {
    const result = await pageService.openPage('21', { tenantId: 'default' });
    expect(isOk(result)).toBe(true);
    const state = derivePageState(unwrap(result));

    console.error('[BC28] Page 21:', {
      pageType: state.pageType,
      fields: state.controlTree.length,
      actions: state.actions.length,
      sampleFields: state.controlTree
        .filter(f => f.caption)
        .slice(0, 5)
        .map(f => `${f.caption}: ${f.stringValue ?? '(empty)'}`),
    });

    expect(state.formId).toBeTruthy();
    expect(state.pageType).toBe('Card');
    expect(state.controlTree.length).toBeGreaterThan(10);
  }, 30000);

  it('reads data rows from Customer List', async () => {
    const openResult = await pageService.openPage('22', { tenantId: 'default' });
    expect(isOk(openResult)).toBe(true);
    const state = derivePageState(unwrap(openResult));

    const rowsResult = dataService.readRows(state.pageContextId);
    expect(isOk(rowsResult)).toBe(true);
    const rows = unwrap(rowsResult);

    console.error(`[BC28] Customer List: ${rows.length} rows`);
    if (rows.length > 0) {
      console.error('[BC28] First row cells:', Object.keys(rows[0]!.cells).length, 'columns');
    }

    expect(rows.length).toBeGreaterThan(0);
  }, 30000);
});
