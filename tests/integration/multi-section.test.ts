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
import { isOk, unwrap } from '../../src/core/result.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { BCConfig } from '../../src/core/config.js';

dotenvConfig();

describe.sequential('Multi-Section: Sales Order (page 42)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let pageContextId: string;
  let ctx: PageContext;
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

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
  });

  afterAll(async () => {
    if (pageContextId) {
      await pageService.closePage(pageContextId);
    }
    session?.close();
  });

  it('opens page 42 and finds sections', async () => {
    const result = await pageService.openPage('42');
    expect(isOk(result)).toBe(true);

    if (isOk(result)) {
      ctx = result.value;
      pageContextId = ctx.pageContextId;

      const sectionIds = Array.from(ctx.sections.keys());
      console.error('Sales Order (page 42) sections:', sectionIds);
      console.error('PageType:', ctx.pageType);
      console.error('Caption:', ctx.caption);
      console.error('Forms count:', ctx.forms.size);
      console.error('OwnedFormIds:', ctx.ownedFormIds);

      for (const [sectionId, section] of ctx.sections) {
        console.error(`  Section '${sectionId}': kind=${section.kind}, caption='${section.caption}', formId=${section.formId}, repeaterPath=${section.repeaterControlPath ?? 'none'}`);
      }

      // Must have at least a 'header' section
      expect(ctx.sections.has('header')).toBe(true);
      expect(ctx.pageContextId).toContain('page:42');

      // Log if 'lines' section is present
      if (ctx.sections.has('lines')) {
        const linesSection = ctx.sections.get('lines')!;
        console.error('Lines section found:', JSON.stringify({
          sectionId: linesSection.sectionId,
          kind: linesSection.kind,
          caption: linesSection.caption,
          formId: linesSection.formId,
          repeaterControlPath: linesSection.repeaterControlPath,
        }, null, 2));
        expect(linesSection.repeaterControlPath).toBeTruthy();
      } else {
        console.error('No lines section detected -- document subpage may not have arrived yet or uses a different section id');
        // Check for any non-header section
        const otherSections = sectionIds.filter(id => id !== 'header');
        console.error('Non-header sections:', otherSections);
      }
    }
  });

  it('reads header fields from root form', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    const fieldsResult = dataService.getFields(pageContextId, 'header');
    expect(isOk(fieldsResult)).toBe(true);

    if (isOk(fieldsResult)) {
      const fields = fieldsResult.value;
      console.error(`Header fields count: ${fields.length}`);
      const withCaptions = fields.filter(f => f.caption);
      console.error(`  With captions: ${withCaptions.length}`);
      for (const f of withCaptions.slice(0, 15)) {
        console.error(`  ${f.caption}: "${f.stringValue ?? ''}" [editable=${f.editable}]`);
      }
    }
  });

  it('reads line items from lines section if present', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    // Find any lines-kind section
    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];

    if (!linesSectionId) {
      console.error('No lines section found -- skipping line item read test');
      // This is not a failure, just diagnostic
      return;
    }

    console.error(`Reading rows from section '${linesSectionId}'`);
    const rowsResult = dataService.readRows(pageContextId, linesSectionId);
    expect(isOk(rowsResult)).toBe(true);

    if (isOk(rowsResult)) {
      const rows = rowsResult.value;
      console.error(`Line items count: ${rows.length}`);

      if (rows.length > 0) {
        const firstRow = rows[0]!;
        console.error('First row bookmark:', firstRow.bookmark);
        const cellKeys = Object.keys(firstRow.cells);
        console.error(`Column paths (${cellKeys.length}):`, cellKeys.slice(0, 10));
        // After cell key mapping, values are already extracted (strings/numbers, not objects)
        const cellsWithValues = Object.entries(firstRow.cells)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .slice(0, 15);
        console.error('First row values:', JSON.stringify(
          Object.fromEntries(cellsWithValues),
          null, 2,
        ));
      }
    }
  });

  it('writes to a line cell (Line Discount %)', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];
    if (!linesSectionId) { console.error('Skipping: no lines section'); return; }

    // Read current rows to get a bookmark
    const rowsResult = dataService.readRows(pageContextId, linesSectionId);
    expect(isOk(rowsResult)).toBe(true);
    if (!isOk(rowsResult) || rowsResult.value.length === 0) {
      console.error('Skipping: no line rows');
      return;
    }

    const firstRow = rowsResult.value[0]!;
    const originalDiscount = firstRow.cells['Line Discount %'];
    console.error(`Line Discount % before write: ${originalDiscount}`);

    // Write Line Discount % = 5 using rowIndex
    const writeResult = await dataService.writeField(
      pageContextId, 'Line Discount %', '5',
      { sectionId: linesSectionId, rowIndex: 0 },
    );
    console.error('Write result:', isOk(writeResult) ? writeResult.value : writeResult.error);
    expect(isOk(writeResult)).toBe(true);

    // The write succeeded -- verify the FieldWriteResult
    if (isOk(writeResult)) {
      expect(writeResult.value.success).toBe(true);
      expect(writeResult.value.fieldName).toBe('Line Discount %');
    }

    // Restore original value
    const restoreValue = String(originalDiscount ?? '0');
    await dataService.writeField(
      pageContextId, 'Line Discount %', restoreValue,
      { sectionId: linesSectionId, rowIndex: 0 },
    );
    console.error(`Line Discount % restored to: ${restoreValue}`);
  });

  it('writes to a header field (External Document No.)', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    // Write a header field
    const writeResult = await dataService.writeField(pageContextId, 'External Document No.', 'GATE4-TEST');
    console.error('Header write result:', isOk(writeResult) ? writeResult.value : writeResult.error);
    expect(isOk(writeResult)).toBe(true);

    if (isOk(writeResult)) {
      expect(writeResult.value.success).toBe(true);
      expect(writeResult.value.fieldName).toBe('External Document No.');
    }

    // Restore
    await dataService.writeField(pageContextId, 'External Document No.', '');
    console.error('Restored External Document No. to empty');
  });

  it('verifies multi-section architecture: section count and form count are consistent', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    const sectionCount = ctx.sections.size;
    const formCount = ctx.forms.size;

    console.error(`Sections: ${sectionCount}, Forms: ${formCount}`);
    // Each section maps to a form, so sections <= forms
    expect(sectionCount).toBeGreaterThanOrEqual(1);
    expect(formCount).toBeGreaterThanOrEqual(1);
    expect(sectionCount).toBeLessThanOrEqual(formCount);

    // Verify each section's formId exists in forms
    for (const [sectionId, section] of ctx.sections) {
      const form = ctx.forms.get(section.formId);
      if (!form) {
        console.error(`WARNING: Section '${sectionId}' references formId ${section.formId} which is NOT in forms map`);
      }
      expect(form).toBeDefined();
    }

    console.error('All section formIds are valid.');
  });
});

describe.sequential('Multi-Section: Sales Order on BC28', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let pageContextId: string;
  const logger = createNullLogger();

  beforeAll(async () => {
    const bc28Config: BCConfig = {
      baseUrl: 'http://cronus28/BC',
      username: 'sshadows',
      password: '1234',
      tenantId: 'default',
      clientVersionString: '28.0.0.0',
      serverMajor: 28,
      timeoutMs: 120000,
    };
    const auth = new NTLMAuthProvider({
      baseUrl: bc28Config.baseUrl,
      username: bc28Config.username,
      password: bc28Config.password,
      tenantId: bc28Config.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, bc28Config, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(bc28Config.clientVersionString);
    const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, bc28Config.tenantId);

    const result = await sessionFactory.create();
    session = unwrap(result);

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
  });

  afterAll(async () => {
    if (pageContextId) {
      await pageService.closePage(pageContextId);
    }
    session?.close();
  });

  it('opens Sales Order page 42 on BC28 with multi-section', async () => {
    const result = await pageService.openPage('42');
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const ctx = result.value;
    pageContextId = ctx.pageContextId;

    console.error('BC28 - Sections:', Array.from(ctx.sections.keys()));
    console.error('BC28 - PageType:', ctx.pageType);
    console.error('BC28 - Forms:', ctx.forms.size);

    expect(ctx.sections.has('header')).toBe(true);

    const linesSection = Array.from(ctx.sections.values()).find(s => s.kind === 'lines');
    if (linesSection) {
      console.error('BC28 - Lines section found:', linesSection.sectionId);
      expect(linesSection.repeaterControlPath).toBeTruthy();

      // Read lines
      const rowsResult = dataService.readRows(pageContextId, linesSection.sectionId);
      if (isOk(rowsResult)) {
        console.error('BC28 - Line rows:', rowsResult.value.length);
        if (rowsResult.value.length > 0) {
          const cells = rowsResult.value[0]!.cells;
          const keys = Object.keys(cells).slice(0, 10);
          console.error('BC28 - Line columns:', keys);
        }
      }
    } else {
      console.error('BC28 - No lines section (same issue would need investigation)');
    }

    // Verify cross-version: sections structure is same as BC27
    expect(ctx.pageType).toBe('Document');
    expect(ctx.forms.size).toBeGreaterThan(1);
  });

  it('writes to a line cell on BC28', async () => {
    if (!pageContextId) return;
    const ctx = pageService.getPageContext(pageContextId);
    if (!ctx) return;

    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];
    if (!linesSectionId) { console.error('BC28 - No lines section'); return; }

    const rowsResult = dataService.readRows(pageContextId, linesSectionId);
    if (!isOk(rowsResult) || rowsResult.value.length === 0) { console.error('BC28 - No rows'); return; }

    const writeResult = await dataService.writeField(
      pageContextId, 'Line Discount %', '3',
      { sectionId: linesSectionId, rowIndex: 0 },
    );
    console.error('BC28 - Line write result:', isOk(writeResult) ? 'SUCCESS' : writeResult.error.message);
    expect(isOk(writeResult)).toBe(true);

    // Restore
    await dataService.writeField(
      pageContextId, 'Line Discount %', '0',
      { sectionId: linesSectionId, rowIndex: 0 },
    );
    console.error('BC28 - Restored');
  });
});
