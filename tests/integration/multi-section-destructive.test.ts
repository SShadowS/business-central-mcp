import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { SystemAction } from '../../src/protocol/types.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { repeaters as treeRepeaters } from '../../src/protocol/form-views.js';
import { bookmarkTableId } from '../../src/protocol/form-state.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';
import { restoreField } from './helpers/restore.js';

/*
 * DESTRUCTIVE: writes line cells and a header field on the first Sales Order, and
 * adds then deletes lines on it. Each value write is restored to its original in
 * finally and the restore must echo (helpers/restore.ts). Run with permission via
 *   npx vitest run --config vitest.destructive.config.ts tests/integration/multi-section-destructive.test.ts
 * Read-only multi-section coverage lives in drilldown-lines.test.ts and
 * advanced-workflows A1 / document-and-bc28 D2.
 */

/**
 * page 42 opens in view mode, where BC ignores every SaveValue and bc_write_data
 * refuses it. Writes run on their own context of the same order, in Edit, so the
 * shared view-mode context keeps the New/Delete cases away from the real lines.
 */
async function openOrderInEdit(pageService: PageService, actionService: ActionService, bookmark: string | undefined): Promise<string> {
  expect(bookmark).toBeTruthy();
  const opened = unwrap(await pageService.openPage('42', { bookmark }));
  unwrap(await actionService.executeSystemAction(opened.pageContextId, SystemAction.Edit));
  return opened.pageContextId;
}

const rootBookmarkOf = (repo: PageContextRepository, pcId: string): string | undefined => {
  const page = repo.get(pcId)!;
  return page.forms.get(page.rootFormId)!.root.properties.bookmark;
};

/** Edit appends empty DraftRecord rows: never write one, a validated draft row inserts a line. */
const realLines = <T extends { bookmark: string }>(rows: readonly T[]): T[] => rows.filter(r => !r.bookmark.startsWith('DraftRecord'));

describe.sequential('Multi-Section: Sales Order (page 42)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let respondDialog: RespondDialogOperation;
  let repo: PageContextRepository;
  let pageContextId: string;
  let ctx: PageContext;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    respondDialog = new RespondDialogOperation(session, repo, stubDownloadService(logger));
  });

  afterAll(async () => {
    if (pageContextId) {
      await pageService.closePage(pageContextId, { discardChanges: true });
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
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

    const editPc = await openOrderInEdit(pageService, actionService, rootBookmarkOf(repo, pageContextId));
    try {
      const rowsResult = dataService.readRows(editPc, 'lines');
      expect(isOk(rowsResult)).toBe(true);
      const realRows = isOk(rowsResult) ? realLines(rowsResult.value) : [];
      if (realRows.length === 0) {
        console.error('Skipping: no line rows');
        return;
      }

      const firstRow = realRows[0]!;
      const originalDiscount = firstRow.cells['Line Discount %'];
      console.error(`Line Discount % before write: ${originalDiscount}`);

      const writeResult = await dataService.writeField(
        editPc, 'Line Discount %', '5',
        { sectionId: 'lines', bookmark: firstRow.bookmark },
      );
      const restoreValue = String(originalDiscount ?? '0');
      try {
        console.error('Write result:', isOk(writeResult) ? writeResult.value : writeResult.error);
        expect(isOk(writeResult)).toBe(true);

        // The write succeeded -- verify the FieldWriteResult
        if (isOk(writeResult)) {
          expect(writeResult.value.success).toBe(true);
          expect(writeResult.value.fieldName).toBe('Line Discount %');
          // success alone also covers a write BC ignored; the echo proves it landed.
          expect(writeResult.value.echoed).toBe(true);
        }
      } finally {
        await restoreField(dataService, editPc, 'Line Discount %', restoreValue, { sectionId: 'lines', bookmark: firstRow.bookmark });
        console.error(`Line Discount % restored to: ${restoreValue}`);
      }

      // Moving the lines subpage's current row emits the PART's Bookmark on the
      // host's server: path without ServerFormHandle; it must not become the
      // header's record bookmark (bc_get_operation re-opens page 42 on it).
      const lastRow = realRows[realRows.length - 1]!;
      if (lastRow !== firstRow) {
        const moved = await dataService.writeField(editPc, 'Line Discount %', String(lastRow.cells['Line Discount %'] ?? '0'),
          { sectionId: 'lines', bookmark: lastRow.bookmark });
        expect(isOk(moved)).toBe(true);
      }
      const rootBookmark = rootBookmarkOf(repo, editPc);
      if (rootBookmark) expect(bookmarkTableId(rootBookmark)).toBe(36);
    } finally {
      await pageService.closePage(editPc, { discardChanges: true });
    }
  });

  it('drills down from a line cell (No. field)', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];
    if (!linesSectionId) { console.error('Skipping: no lines section'); return; }

    const rowsResult = dataService.readRows(pageContextId, linesSectionId);
    if (!isOk(rowsResult) || rowsResult.value.length === 0) { console.error('Skipping: no rows'); return; }

    const bookmark = rowsResult.value[0]!.bookmark;
    const linesSection = ctx.sections.get(linesSectionId)!;
    const linesForm = ctx.forms.get(linesSection.formId)!;
    const repeater = treeRepeaters(linesForm.root).values().next().value!;

    // Select the row first
    await session.invoke(
      { type: 'SetCurrentRow' as const, formId: linesSection.formId, controlPath: repeater.controlPath, key: bookmark },
      (event: any) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );

    // Find "No." column index
    const noCol = repeater.columns.find((c: any) => c.properties?.caption === 'No.');
    expect(noCol).toBeDefined();
    const colIdx = noCol!.controlPath.match(/co\[(\d+)\]/)![1];

    // DrillDown (SystemAction 120) on the cell
    const drillPath = `${repeater.controlPath}/cr/c[${colIdx}]`;
    const drillResult = await session.invoke(
      { type: 'InvokeAction' as const, formId: linesSection.formId, controlPath: drillPath, systemAction: 120 },
      (event: any) => event.type === 'InvokeCompleted' || event.type === 'FormCreated' || event.type === 'DialogOpened',
    );
    expect(isOk(drillResult)).toBe(true);
    if (!isOk(drillResult)) return;

    // DrillDown on a line item No. opens a dialog (Item Card as modal)
    const events = drillResult.value;
    const dialogOpened = events.find((e: any) => e.type === 'DialogOpened');
    const formCreated = events.find((e: any) => e.type === 'FormCreated');
    const opened = dialogOpened || formCreated;
    console.error('DrillDown opened:', opened?.type, 'formId:', (opened as any)?.formId);
    expect(opened).toBeDefined();

    // Close the opened dialog using bc_respond_dialog
    if (opened) {
      const closeResult = await respondDialog.execute({
        pageContextId,
        dialogFormId: (opened as any).formId,
        response: 'close',
      });
      expect(isOk(closeResult)).toBe(true);
      console.error('DrillDown dialog closed via bc_respond_dialog.');
    }
  });

  it('executes New + Delete on lines section (section-scoped action)', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];
    if (!linesSectionId) { console.error('Skipping: no lines section'); return; }

    const linesSection = ctx.sections.get(linesSectionId)!;
    const linesForm = ctx.forms.get(linesSection.formId)!;
    const repeater = treeRepeaters(linesForm.root).values().next().value!;
    const rowsBefore = (linesForm.rows.get(repeater.controlPath) ?? []).length;
    console.error('Lines before New:', rowsBefore);

    // New line: SystemAction 10 on repeater cr/c[0] with child formId
    const newResult = await session.invoke(
      { type: 'InvokeAction' as const, formId: linesSection.formId, controlPath: `${repeater.controlPath}/cr/c[0]`, systemAction: 10 },
      (event: any) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded' || event.type === 'BookmarkChanged',
    );
    expect(isOk(newResult)).toBe(true);
    console.error('New line result:', isOk(newResult) ? 'SUCCESS' : 'FAILED');

    // Delete the new line: SystemAction 20 (current row is the new line)
    const delResult = await session.invoke(
      { type: 'InvokeAction' as const, formId: linesSection.formId, controlPath: `${repeater.controlPath}/cr/c[0]`, systemAction: 20 },
      (event: any) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );
    expect(isOk(delResult)).toBe(true);
    console.error('Delete line result:', isOk(delResult) ? 'SUCCESS' : 'FAILED');
  });

  it('adds a new line via bc_execute_action(New) and sets item', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    // Execute "New" action on lines section
    const newResult = await actionService.executeAction(pageContextId, 'New', 'lines');
    console.error('New line result:', isOk(newResult) ? 'SUCCESS' : newResult.error.message);
    expect(isOk(newResult)).toBe(true);

    // Write Type = "Item" on the new line (current row)
    const typeResult = await dataService.writeField(
      pageContextId, 'Type', '2',  // 2 = Item in BC enum
      { sectionId: 'lines', rowIndex: 0 },  // new row is now at index 0 or last
    );
    console.error('Type write:', isOk(typeResult) ? 'SUCCESS' : typeResult.error.message);

    // Delete the new line to clean up
    const delResult = await actionService.executeAction(pageContextId, 'Delete', 'lines');
    console.error('Delete result:', isOk(delResult) ? 'SUCCESS' : delResult.error.message);
    expect(isOk(delResult)).toBe(true);
  });

  it('writes to a header field (External Document No.)', async () => {
    if (!ctx) { console.error('Skipping: no page context'); return; }

    // Write a header field; restore the ORIGINAL value (the old restore blanked it).
    const editPc = await openOrderInEdit(pageService, actionService, rootBookmarkOf(repo, pageContextId));
    try {
      const original = unwrap(dataService.readField(editPc, 'External Document No.'))?.stringValue ?? '';
      const probe = original === 'GATE4-TEST' ? 'GATE4-TEST2' : 'GATE4-TEST';
      const writeResult = await dataService.writeField(editPc, 'External Document No.', probe);
      try {
        console.error('Header write result:', isOk(writeResult) ? writeResult.value : writeResult.error);
        expect(isOk(writeResult)).toBe(true);

        if (isOk(writeResult)) {
          expect(writeResult.value.success).toBe(true);
          expect(writeResult.value.fieldName).toBe('External Document No.');
          expect(writeResult.value.echoed).toBe(true);
        }
      } finally {
        await restoreField(dataService, editPc, 'External Document No.', original);
        console.error(`Restored External Document No. to "${original}"`);
      }
    } finally {
      await pageService.closePage(editPc, { discardChanges: true });
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

describe.sequential('Multi-Section: Sales Order on BC28', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let pageContextId: string;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
  });

  afterAll(async () => {
    if (pageContextId) {
      await pageService.closePage(pageContextId, { discardChanges: true });
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
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

    // This describe only writes, so its own page goes to Edit (see openOrderInEdit).
    unwrap(await actionService.executeSystemAction(pageContextId, SystemAction.Edit));
    const rowsResult = dataService.readRows(pageContextId, linesSectionId);
    const realRows = isOk(rowsResult) ? realLines(rowsResult.value) : [];
    if (realRows.length === 0) { console.error('BC28 - No rows'); return; }
    const bookmark = realRows[0]!.bookmark;

    // Restore the ORIGINAL discount (the old restore wrote '0' regardless).
    const original = String(realRows[0]!.cells['Line Discount %'] ?? '0');
    const probe = original === '3' ? '4' : '3';
    const writeResult = await dataService.writeField(
      pageContextId, 'Line Discount %', probe,
      { sectionId: linesSectionId, bookmark },
    );
    try {
      console.error('BC28 - Line write result:', isOk(writeResult) ? 'SUCCESS' : writeResult.error.message);
      expect(isOk(writeResult)).toBe(true);
      if (isOk(writeResult)) expect(writeResult.value.echoed).toBe(true);
    } finally {
      await restoreField(dataService, pageContextId, 'Line Discount %', original, { sectionId: linesSectionId, bookmark });
      console.error(`BC28 - Restored to ${original}`);
    }
  });
});
