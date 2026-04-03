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
        const cellsWithValues = Object.entries(firstRow.cells)
          .filter(([, v]) => v.stringValue)
          .slice(0, 10);
        console.error('First row cells with values:', JSON.stringify(
          Object.fromEntries(cellsWithValues.map(([k, v]) => [k, v.stringValue])),
          null, 2,
        ));
      }
    }
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
