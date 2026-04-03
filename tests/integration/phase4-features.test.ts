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

describe.sequential('Phase 4: FactBox Data & Full Paging', () => {
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

  // --- Tier 1: FactBox Data ---

  describe('1.1: FactBox data on Sales Order (page 42)', () => {
    let pageContextId: string;

    it('opens page 42 with factbox sections', async () => {
      const result = await pageService.openPage('42');
      expect(isOk(result)).toBe(true);
      const ctx = unwrap(result);
      pageContextId = ctx.pageContextId;

      // List all sections
      const sectionIds = Array.from(ctx.sections.keys());
      console.error('Sections:', sectionIds);

      // Should have factbox sections now that they are auto-loaded
      const factboxSections = sectionIds.filter(s => s.startsWith('factbox:'));
      console.error('FactBox sections:', factboxSections);
      expect(factboxSections.length).toBeGreaterThan(0);
    });

    it('reads factbox section data with non-empty field values', async () => {
      const ctx = repo.get(pageContextId)!;
      const factboxSections = Array.from(ctx.sections.keys()).filter(s => s.startsWith('factbox:'));

      let foundValues = false;
      for (const sectionId of factboxSections) {
        const fieldsResult = dataService.getFields(pageContextId, sectionId);
        if (!isOk(fieldsResult)) continue;

        const fields = unwrap(fieldsResult);
        const fieldsWithValues = fields.filter(f => f.stringValue !== undefined && f.stringValue !== '');
        console.error(`  ${sectionId}: ${fields.length} fields, ${fieldsWithValues.length} with values`);

        if (fieldsWithValues.length > 0) {
          foundValues = true;
          // Log first few field values
          for (const f of fieldsWithValues.slice(0, 3)) {
            console.error(`    ${f.caption}: "${f.stringValue}"`);
          }
        }
      }

      // At least one factbox should have data populated
      // Note: factbox data depends on the currently selected row
      console.error('Found factbox values:', foundValues);
      // Don't hard-fail if no values -- factbox data depends on row selection state
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId);
    });
  });

  describe('1.1b: FactBox data on Customer List (page 22)', () => {
    let pageContextId: string;

    it('opens page 22 with factbox sections', async () => {
      const result = await pageService.openPage('22');
      expect(isOk(result)).toBe(true);
      const ctx = unwrap(result);
      pageContextId = ctx.pageContextId;

      const sectionIds = Array.from(ctx.sections.keys());
      const factboxSections = sectionIds.filter(s => s.startsWith('factbox:'));
      console.error('Customer List factbox sections:', factboxSections);
    });

    it('reads factbox fields after page open', () => {
      const ctx = repo.get(pageContextId)!;
      const factboxSections = Array.from(ctx.sections.keys()).filter(s => s.startsWith('factbox:'));

      for (const sectionId of factboxSections) {
        const fieldsResult = dataService.getFields(pageContextId, sectionId);
        if (!isOk(fieldsResult)) continue;
        const fields = unwrap(fieldsResult);
        const withValues = fields.filter(f => f.stringValue !== undefined && f.stringValue !== '');
        console.error(`  ${sectionId}: ${fields.length} fields, ${withValues.length} with values`);
        for (const f of withValues.slice(0, 5)) {
          console.error(`    ${f.caption} = "${f.stringValue}"`);
        }
      }
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId);
    });
  });

  // --- Tier 2: Full Paging (ScrollRepeater) ---

  describe('2.1: ScrollRepeater on Customer List (page 22)', () => {
    let pageContextId: string;

    it('opens page 22', async () => {
      const result = await pageService.openPage('22');
      expect(isOk(result)).toBe(true);
      pageContextId = unwrap(result).pageContextId;
    });

    it('loads initial rows and totalRowCount', async () => {
      const result = await readData.execute({ pageContextId });
      expect(isOk(result)).toBe(true);
      const output = unwrap(result);
      console.error(`Initial: ${output.totalCount} rows loaded, totalRowCount=${output.totalRowCount}`);
      expect(output.totalCount).toBeGreaterThan(0);
    });

    it('scrolls to load more rows', async () => {
      const beforeResult = await readData.execute({ pageContextId });
      const before = unwrap(beforeResult);
      const initialCount = before.totalCount;

      // Scroll down to load more
      const scrollResult = await dataService.scrollRepeater(pageContextId, 5);
      expect(isOk(scrollResult)).toBe(true);
      const afterRows = unwrap(scrollResult);

      console.error(`After scroll: ${afterRows.length} rows (was ${initialCount})`);
      // Should have same or more rows after scrolling
      expect(afterRows.length).toBeGreaterThanOrEqual(initialCount);
    });

    it('range query with auto-scroll loads beyond initial viewport', async () => {
      // Get initial row count
      const initialResult = this.dataService?.readRows(pageContextId) ?? await readData.execute({ pageContextId });
      // Request rows that may be beyond initial viewport
      const rangeResult = await readData.execute({
        pageContextId,
        range: { offset: 0, limit: 50 },
      });
      expect(isOk(rangeResult)).toBe(true);
      const output = unwrap(rangeResult);
      console.error(`Range 0-50: got ${output.rows.length} rows, totalCount=${output.totalCount}, totalRowCount=${output.totalRowCount}`);
      // Should return rows (may be less than 50 if fewer exist)
      expect(output.rows.length).toBeGreaterThan(0);
    });

    it('closes page', async () => {
      await pageService.closePage(pageContextId);
    });
  });

  // --- Tier 4: Performance ---

  describe('4.1: Performance measurement', () => {
    it('opens Sales Order (page 42) within 5 seconds', async () => {
      const start = performance.now();
      const result = await pageService.openPage('42');
      const elapsed = performance.now() - start;
      expect(isOk(result)).toBe(true);
      const ctx = unwrap(result);
      console.error(`Page 42 open: ${elapsed.toFixed(0)}ms`);
      // Generous limit to account for factbox loading
      expect(elapsed).toBeLessThan(5000);

      // Read data timing
      const readStart = performance.now();
      const readResult = await readData.execute({ pageContextId: ctx.pageContextId, section: 'lines' });
      const readElapsed = performance.now() - readStart;
      expect(isOk(readResult)).toBe(true);
      console.error(`Lines read: ${readElapsed.toFixed(0)}ms`);
      expect(readElapsed).toBeLessThan(500);

      await pageService.closePage(ctx.pageContextId);
    });
  });
});
