import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { isOk, unwrap } from '../../src/core/result.js';

dotenvConfig();

describe.sequential('Phase 3 Feature Verification', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let readData: ReadDataOperation;
  let repo: PageContextRepository;
  const logger = createNullLogger();

  beforeAll(async () => {
    const appConfig = loadConfig();
    const auth = new NTLMAuthProvider({
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
    const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);

    const result = await sessionFactory.create();
    session = unwrap(result);

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    const filterService = new FilterService(session, repo, logger);
    readData = new ReadDataOperation(dataService, filterService);
  });

  afterAll(() => {
    session?.close();
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
      await pageService.closePage(pageContextId);
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
      if (output.rows.length > 0) {
        const cellKeys = Object.keys(output.rows[0]!.cells);
        console.error('General tab fields:', cellKeys.slice(0, 10));
        // Should have substantially fewer fields than all fields
        const allResult = await readData.execute({ pageContextId });
        if (isOk(allResult)) {
          const allKeys = Object.keys(unwrap(allResult).rows[0]!.cells);
          expect(cellKeys.length).toBeLessThan(allKeys.length);
          console.error(`General tab: ${cellKeys.length} fields vs all: ${allKeys.length} fields`);
        }
      }
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId);
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

      console.error(`Customer List: ${output.totalCount} rows loaded, totalRowCount=${output.totalRowCount}`);
      expect(output.totalCount).toBeGreaterThan(0);
    });

    it('slices first 3 rows with range', async () => {
      const allResult = await readData.execute({ pageContextId });
      const all = unwrap(allResult);

      const rangeResult = await readData.execute({ pageContextId, range: { offset: 0, limit: 3 } });
      expect(isOk(rangeResult)).toBe(true);
      const ranged = unwrap(rangeResult);

      expect(ranged.rows.length).toBe(3);
      // totalCount should be the full count (before slicing)
      expect(ranged.totalCount).toBe(all.totalCount);
      // First 3 rows should match
      expect(ranged.rows[0]!.bookmark).toBe(all.rows[0]!.bookmark);
      expect(ranged.rows[2]!.bookmark).toBe(all.rows[2]!.bookmark);
    });

    it('slices with offset', async () => {
      const allResult = await readData.execute({ pageContextId });
      const all = unwrap(allResult);

      const rangeResult = await readData.execute({ pageContextId, range: { offset: 2, limit: 2 } });
      expect(isOk(rangeResult)).toBe(true);
      const ranged = unwrap(rangeResult);

      expect(ranged.rows.length).toBe(2);
      // Row at offset 2 should match all.rows[2]
      expect(ranged.rows[0]!.bookmark).toBe(all.rows[2]!.bookmark);
      expect(ranged.rows[1]!.bookmark).toBe(all.rows[3]!.bookmark);
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId);
    });
  });
});
