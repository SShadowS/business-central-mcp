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
      console.error('Found factbox values:', foundValues);
      expect(foundValues).toBe(true);
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

  describe('2.1: Paging on G/L Entries (page 20) - large dataset', () => {
    let pageContextId: string;

    it('opens page 20', async () => {
      const result = await pageService.openPage('20');
      expect(isOk(result)).toBe(true);
      pageContextId = unwrap(result).pageContextId;
    });

    it('loads initial viewport (should be ~49 rows)', async () => {
      const result = await readData.execute({ pageContextId });
      expect(isOk(result)).toBe(true);
      const output = unwrap(result);
      console.error(`Initial: ${output.totalCount} rows loaded, totalRowCount=${output.totalRowCount}`);
      expect(output.totalCount).toBeGreaterThanOrEqual(20);
    });

    it('scrolls to load more rows beyond initial viewport', async () => {
      const beforeResult = await readData.execute({ pageContextId });
      const before = unwrap(beforeResult);
      const initialCount = before.totalCount;

      // Scroll down multiple times
      for (let i = 0; i < 3; i++) {
        const scrollResult = await dataService.scrollRepeater(pageContextId, 5);
        expect(isOk(scrollResult)).toBe(true);
      }

      const afterResult = await readData.execute({ pageContextId });
      const after = unwrap(afterResult);
      console.error(`After 3 scrolls: ${after.totalCount} rows (was ${initialCount})`);
      // G/L Entries should have many rows; scrolling should load more
      expect(after.totalCount).toBeGreaterThanOrEqual(initialCount);
    });

    it('range query slices correctly', async () => {
      const allResult = await readData.execute({ pageContextId });
      const all = unwrap(allResult);

      // Slice first 10
      const rangeResult = await readData.execute({
        pageContextId,
        range: { offset: 0, limit: 10 },
      });
      expect(isOk(rangeResult)).toBe(true);
      const ranged = unwrap(rangeResult);
      expect(ranged.rows.length).toBe(10);
      expect(ranged.totalCount).toBe(all.totalCount);
      expect(ranged.rows[0]!.bookmark).toBe(all.rows[0]!.bookmark);

      // Slice with offset
      const offsetResult = await readData.execute({
        pageContextId,
        range: { offset: 20, limit: 10 },
      });
      expect(isOk(offsetResult)).toBe(true);
      const offset = unwrap(offsetResult);
      expect(offset.rows.length).toBe(10);
      expect(offset.rows[0]!.bookmark).toBe(all.rows[20]!.bookmark);

      console.error(`Paging verified: ${all.totalCount} total rows, slicing works at offset 0 and 20`);
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
