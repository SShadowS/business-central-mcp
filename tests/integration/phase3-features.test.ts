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

describe.sequential('Phase 3 Feature Verification', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let readData: ReadDataOperation;
  let repo: PageContextRepository;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    const filterService = new FilterService(session, repo, logger);
    const sortService = new SortService(session, repo, logger);
    readData = new ReadDataOperation(dataService, filterService, sortService, repo);
  });

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  // --- 1.2: Field Metadata (isLookup, showMandatory) ---

  describe('1.2: Field metadata on Customer Card (page 21)', () => {
    let pageContextId: string;

    it('opens page 21', async () => {
      const result = await pageService.openPage('21');
      expect(isOk(result)).toBe(true);
      pageContextId = unwrap(result).pageContextId;
    });

    it('has isLookup on No. field (AssistEdit)', () => {
      const fieldsResult = dataService.getFields(pageContextId);
      expect(isOk(fieldsResult)).toBe(true);
      const fields = unwrap(fieldsResult);

      const noField = fields.find(f => f.caption === 'No.');
      expect(noField).toBeDefined();
      expect(noField!.isLookup).toBe(true);
    });

    it('has showMandatory on Name field', () => {
      const fieldsResult = dataService.getFields(pageContextId);
      expect(isOk(fieldsResult)).toBe(true);
      const fields = unwrap(fieldsResult);

      const nameField = fields.find(f => f.caption === 'Name');
      expect(nameField).toBeDefined();
      expect(nameField!.showMandatory).toBe(true);
    });

    it('non-lookup fields have isLookup undefined', () => {
      const fieldsResult = dataService.getFields(pageContextId);
      expect(isOk(fieldsResult)).toBe(true);
      const fields = unwrap(fieldsResult);

      // Address is a plain text field, no lookup
      const addressField = fields.find(f => f.caption === 'Address');
      if (addressField) {
        expect(addressField.isLookup).toBeUndefined();
      }
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId, { discardChanges: true });
    });
  });

  // --- 2.1: Tab Groups ---

  describe('2.1: Tab groups on Sales Order (page 42)', () => {
    let pageContextId: string;

    it('opens page 42', async () => {
      const result = await pageService.openPage('42');
      expect(isOk(result)).toBe(true);
      pageContextId = unwrap(result).pageContextId;
    });

    it('exposes tab groups with known tab names', () => {
      const tabsResult = dataService.getTabs(pageContextId);
      expect(isOk(tabsResult)).toBe(true);
      const tabs = unwrap(tabsResult);

      expect(tabs).toBeDefined();
      expect(tabs!.length).toBeGreaterThanOrEqual(3);

      const tabNames = tabs!.map(t => t.caption);
      console.error('Tab names:', tabNames);

      // Sales Order should have General and Invoice Details tabs
      expect(tabNames.some(n => n.toLowerCase().includes('general'))).toBe(true);
      expect(tabNames.some(n => n.toLowerCase().includes('invoice'))).toBe(true);
    });

    it('reads header filtered by tab "General"', async () => {
      const result = await readData.execute({ pageContextId, tab: 'General' });
      expect(isOk(result)).toBe(true);
      const output = unwrap(result);

      // General tab should include No. and Sell-to Customer No.
      const tabFields = output.section.fields ?? [];
      if (tabFields.length > 0) {
        const fieldNames = tabFields.map(f => f.name);
        console.error('General tab fields:', fieldNames.slice(0, 10));
        // Should have substantially fewer fields than all fields
        const allResult = await readData.execute({ pageContextId });
        if (isOk(allResult)) {
          const allFields = unwrap(allResult).section.fields ?? [];
          expect(tabFields.length).toBeLessThan(allFields.length);
          console.error(`General tab: ${tabFields.length} fields vs all: ${allFields.length} fields`);
        }
      }
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId, { discardChanges: true });
    });
  });

  // --- 2.2: Paging MVP ---

  describe('2.2: Range slicing on Customer List (page 22)', () => {
    let pageContextId: string;

    it('opens page 22', async () => {
      const result = await pageService.openPage('22');
      expect(isOk(result)).toBe(true);
      pageContextId = unwrap(result).pageContextId;
    });

    it('reads all rows and reports totalRowCount', async () => {
      const result = await readData.execute({ pageContextId });
      expect(isOk(result)).toBe(true);
      const output = unwrap(result);

      const loadedRows = output.section.rows ?? [];
      console.error(`Customer List: ${loadedRows.length} rows loaded, totalRowCount=${output.section.totalRowCount}`);
      expect(loadedRows.length).toBeGreaterThan(0);
    });

    it('slices first 3 rows with range', async () => {
      const allResult = await readData.execute({ pageContextId });
      const all = unwrap(allResult);
      const allRows = all.section.rows ?? [];

      const rangeResult = await readData.execute({ pageContextId, range: { offset: 0, limit: 3 } });
      expect(isOk(rangeResult)).toBe(true);
      const ranged = unwrap(rangeResult);
      const rangedRows = ranged.section.rows ?? [];

      expect(rangedRows.length).toBe(3);
      // totalRowCount should be the full count (before slicing)
      expect(ranged.section.totalRowCount).toBe(all.section.totalRowCount);
      // First 3 rows should match
      expect(rangedRows[0]!.bookmark).toBe(allRows[0]!.bookmark);
      expect(rangedRows[2]!.bookmark).toBe(allRows[2]!.bookmark);
    });

    it('slices with offset', async () => {
      const allResult = await readData.execute({ pageContextId });
      const all = unwrap(allResult);
      const allRows = all.section.rows ?? [];

      const rangeResult = await readData.execute({ pageContextId, range: { offset: 2, limit: 2 } });
      expect(isOk(rangeResult)).toBe(true);
      const ranged = unwrap(rangeResult);
      const rangedRows = ranged.section.rows ?? [];

      expect(rangedRows.length).toBe(2);
      // Row at offset 2 should match allRows[2]
      expect(rangedRows[0]!.bookmark).toBe(allRows[2]!.bookmark);
      expect(rangedRows[1]!.bookmark).toBe(allRows[3]!.bookmark);
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId, { discardChanges: true });
    });
  });
});
