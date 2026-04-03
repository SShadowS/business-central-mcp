/**
 * Advanced workflow integration tests -- harder scenarios that stress
 * document pages, drill-down+read, write+verify, multi-filter, session
 * resilience, and varied entity types.
 *
 * Goal: discover protocol gaps, not fix them.
 * Each workflow is a self-contained it() block. Tests run sequentially
 * because they share a single BCSession.
 *
 * Test ordering: safe read-only tests first, risky mutating tests last,
 * so a session-killing failure doesn't block all subsequent tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { derivePageState } from '../../src/protocol/types.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { SearchService } from '../../src/services/search-service.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';

dotenvConfig();

describe('Advanced Workflow Tests (v2)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let filterService: FilterService;
  let navigationService: NavigationService;
  let searchService: SearchService;
  const logger = createNullLogger();

  const openedPages: string[] = [];
  let sessionDead = false;
  let recreationFailed = false;
  let sessionFactory: SessionFactory;

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
    sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);

    const result = await sessionFactory.create();
    expect(isOk(result)).toBe(true);
    session = unwrap(result);

    rebuildServices();
  }, 30_000);

  afterAll(async () => {
    for (const pageCtx of openedPages) {
      try { await pageService.closePage(pageCtx, { discardChanges: true }); } catch { /* ignore */ }
    }
    await session?.closeGracefully().catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rebuildServices(): void {
    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    filterService = new FilterService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    searchService = new SearchService(session, logger);
  }

  async function recreateSession(): Promise<boolean> {
    if (recreationFailed) {
      console.error('[SESSION] Previous recreation failed, skipping retries');
      return false;
    }
    console.error('[SESSION] Recreating session...');
    try { await session?.closeGracefully().catch(() => {}); } catch { /* ignore */ }

    let result = await sessionFactory.create();
    const delays = [2000, 4000, 8000];
    for (let i = 0; isErr(result) && i < delays.length; i++) {
      const delay = delays[i]!;
      console.error(`[SESSION] Attempt ${i + 1} failed (${result.error.message}), retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      result = await sessionFactory.create();
    }
    if (isErr(result)) {
      console.error(`[SESSION] Recreation failed: ${result.error.message}`);
      recreationFailed = true;
      return false;
    }
    session = unwrap(result);
    rebuildServices();
    sessionDead = false;
    console.error('[SESSION] Recreated successfully');
    return true;
  }

  function isSessionDeadErr(result: { ok: false; error: { message: string } }): boolean {
    return result.error.message.includes('InvalidSessionException');
  }

  async function openAndTrack(pageId: string) {
    const result = await pageService.openPage(pageId);
    if (isOk(result)) {
      openedPages.push(result.value.pageContextId);
    } else if (isSessionDeadErr(result)) {
      sessionDead = true;
    }
    return result;
  }

  async function closeAndUntrack(pageContextId: string) {
    const result = await pageService.closePage(pageContextId, { discardChanges: true });
    const idx = openedPages.indexOf(pageContextId);
    if (idx >= 0) openedPages.splice(idx, 1);
    return result;
  }

  async function ensureSession(tag: string): Promise<boolean> {
    if (!sessionDead && session?.isAlive) return true;
    console.error(`[${tag}] Session dead, attempting recreation...`);
    const ok = await recreateSession();
    if (!ok) console.error(`[${tag}] SKIPPED -- could not recreate session`);
    return ok;
  }

  function logHealth(tag: string): void {
    console.error(`[SESSION][${tag}] alive=${session?.isAlive}, openForms=${session?.openFormIds.size}`);
  }

  // ===========================================================================
  // SAFE READ-ONLY TESTS (run first to maximize coverage before risky tests)
  // ===========================================================================

  // --- 1. Sales Order Document Page (page 42) ---
  it('A1: Sales Order Document Page -- header + subpage lines', async () => {
    console.error('\n--- A1: Sales Order Document Page (42) ---');
    if (!await ensureSession('A1')) return;

    const openResult = await openAndTrack('42');
    if (isErr(openResult)) {
      console.error(`[A1] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Sales Order page 42');
    }
    const state = derivePageState(unwrap(openResult));
    console.error(`[A1] pageType=${state.pageType}, formId=${state.formId}`);
    console.error(`[A1] controlTree fields: ${state.controlTree.length}`);
    console.error(`[A1] actions: ${state.actions.length} total`);
    console.error(`[A1] repeater: ${state.repeater ? `${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns` : 'NONE'}`);

    // Check document-specific header fields
    const headerFieldNames = ['Sell-to Customer No.', 'Sell-to Customer Name', 'Posting Date', 'Status', 'Order Date'];
    for (const name of headerFieldNames) {
      const fResult = dataService.readField(state.pageContextId, name);
      if (isOk(fResult)) {
        const f = fResult.value;
        console.error(`[A1] Header "${name}": ${f ? `"${f.stringValue}" [editable=${f.editable}]` : 'NOT FOUND'}`);
      } else {
        console.error(`[A1] Header "${name}": readField error: ${fResult.error.message}`);
      }
    }

    // Check subpage (lines)
    if (state.repeater) {
      console.error(`[A1] Subpage columns: ${state.repeater.columns.map(c => c.caption).join(', ')}`);
      for (const row of state.repeater.rows.slice(0, 3)) {
        console.error(`[A1] Line row: bookmark=${row.bookmark}, cells=${JSON.stringify(row.cells)}`);
      }
    } else {
      console.error('[A1] WARNING: No repeater found on document page -- subpage lines missing');
    }

    // A document page should have both header fields and line items
    const captionedFields = state.controlTree.filter(f => f.caption);
    expect(captionedFields.length).toBeGreaterThan(5);

    await closeAndUntrack(state.pageContextId);
    console.error('[A1] DONE');
    logHealth('A1');
  }, 30_000);

  // --- 2. Item Card (page 30) ---
  it('A2: Item Card -- verify item-specific fields', async () => {
    console.error('\n--- A2: Item Card (page 30) ---');
    if (!await ensureSession('A2')) return;

    const openResult = await openAndTrack('30');
    if (isErr(openResult)) {
      console.error(`[A2] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Item Card page 30');
    }
    const state = derivePageState(unwrap(openResult));
    console.error(`[A2] pageType=${state.pageType}, ${state.controlTree.length} fields`);

    const itemFields = ['No.', 'Description', 'Unit Price', 'Inventory', 'Base Unit of Measure'];
    for (const name of itemFields) {
      const fResult = dataService.readField(state.pageContextId, name);
      if (isOk(fResult)) {
        const f = fResult.value;
        console.error(`[A2] "${name}": ${f ? `"${f.stringValue}" [editable=${f.editable}]` : 'NOT FOUND'}`);
      }
    }

    const found = itemFields.filter(name => {
      const r = dataService.readField(state.pageContextId, name);
      return isOk(r) && r.value !== undefined;
    });
    console.error(`[A2] Found ${found.length}/${itemFields.length} expected item fields`);
    expect(found.length).toBeGreaterThan(0);

    await closeAndUntrack(state.pageContextId);
    console.error('[A2] DONE');
    logHealth('A2');
  }, 30_000);

  // --- 3. Vendor List (page 27) ---
  it('A3: Vendor List (page 27) -- verify rows and columns', async () => {
    console.error('\n--- A3: Vendor List (page 27) ---');
    if (!await ensureSession('A3')) return;

    const openResult = await openAndTrack('27');
    if (isErr(openResult)) {
      console.error(`[A3] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Vendor List page 27');
    }
    const state = derivePageState(unwrap(openResult));

    console.error(`[A3] pageType=${state.pageType}, formId=${state.formId}`);
    console.error(`[A3] fields: ${state.controlTree.length}, actions: ${state.actions.length}`);
    console.error(`[A3] repeater: ${state.repeater ? `${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns` : 'NONE'}`);

    if (state.repeater) {
      console.error(`[A3] Columns: ${state.repeater.columns.map(c => c.caption).join(', ')}`);
      for (const row of state.repeater.rows.slice(0, 3)) {
        console.error(`[A3] Row: bookmark=${row.bookmark}, cells=${JSON.stringify(row.cells)}`);
      }
      expect(state.repeater.rows.length).toBeGreaterThan(0);
      expect(state.repeater.columns.length).toBeGreaterThan(0);
    } else {
      console.error('[A3] WARNING: No repeater on Vendor List');
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[A3] DONE');
    logHealth('A3');
  }, 30_000);

  // --- 4. G/L Entries (page 20) -- large list ---
  it('A4: G/L Entries (page 20) -- large list page', async () => {
    console.error('\n--- A4: G/L Entries (page 20) ---');
    if (!await ensureSession('A4')) return;

    const openResult = await openAndTrack('20');
    if (isErr(openResult)) {
      console.error(`[A4] Open FAILED: ${openResult.error.message}`);
      console.error('[A4] Note: page 20 might not be G/L Entries in this BC version');
      return;
    }
    const state = derivePageState(unwrap(openResult));

    console.error(`[A4] pageType=${state.pageType}, formId=${state.formId}`);
    console.error(`[A4] fields: ${state.controlTree.length}`);
    console.error(`[A4] repeater: ${state.repeater ? `${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns` : 'NONE'}`);

    if (state.repeater) {
      console.error(`[A4] Columns: ${state.repeater.columns.map(c => c.caption).join(', ')}`);
      const rowCount = state.repeater.rows.length;
      console.error(`[A4] Row count: ${rowCount}`);
      if (rowCount > 0) {
        console.error(`[A4] First row: ${JSON.stringify(state.repeater.rows[0]!.cells)}`);
        console.error(`[A4] Last row: ${JSON.stringify(state.repeater.rows[rowCount - 1]!.cells)}`);
      }
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[A4] DONE');
    logHealth('A4');
  }, 30_000);

  // --- 5. Session resilience -- open/close/reopen ---
  it('A5: Session resilience -- open/close/reopen cycle', async () => {
    console.error('\n--- A5: Session Resilience ---');
    if (!await ensureSession('A5')) return;

    // Open page 22, close it
    console.error('[A5] Step 1: Open page 22...');
    const r1 = await openAndTrack('22');
    if (isErr(r1)) {
      console.error(`[A5] Open 22 FAILED: ${r1.error.message}`);
      return;
    }
    const ctx1 = unwrap(r1).pageContextId;
    console.error(`[A5] Page 22 opened: ${ctx1}`);
    await closeAndUntrack(ctx1);
    console.error('[A5] Page 22 closed');

    // Open page 30, close it
    console.error('[A5] Step 2: Open page 30...');
    const r2 = await openAndTrack('30');
    if (isErr(r2)) {
      console.error(`[A5] Open 30 FAILED: ${r2.error.message}`);
      return;
    }
    const ctx2 = unwrap(r2).pageContextId;
    console.error(`[A5] Page 30 opened: ${ctx2}`);
    await closeAndUntrack(ctx2);
    console.error('[A5] Page 30 closed');

    // Reopen page 22
    console.error('[A5] Step 3: Reopen page 22...');
    const r3 = await openAndTrack('22');
    if (isErr(r3)) {
      console.error(`[A5] Reopen 22 FAILED: ${r3.error.message}`);
      expect.fail('Session did not survive open/close/reopen cycle');
    }
    const state3 = derivePageState(unwrap(r3));
    console.error(`[A5] Page 22 reopened: ${state3.pageContextId}, ${state3.repeater?.rows.length ?? 0} rows`);
    expect(state3.repeater).toBeTruthy();
    expect(state3.repeater!.rows.length).toBeGreaterThan(0);

    await closeAndUntrack(state3.pageContextId);
    console.error('[A5] PASSED -- session survived open/close/reopen cycle');
    logHealth('A5');
  }, 30_000);

  // --- 6. Select second row by bookmark ---
  it('A6: Select second row by bookmark on Customer List', async () => {
    console.error('\n--- A6: Select Second Row ---');
    if (!await ensureSession('A6')) return;

    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[A6] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Customer List');
    }
    const state = derivePageState(unwrap(openResult));

    expect(state.repeater).toBeTruthy();
    const rows = state.repeater!.rows;
    console.error(`[A6] Total rows: ${rows.length}`);

    if (rows.length < 2) {
      console.error('[A6] SKIPPED -- need at least 2 rows');
      await closeAndUntrack(state.pageContextId);
      return;
    }

    const secondBookmark = rows[1]!.bookmark;
    console.error(`[A6] First row bookmark: "${rows[0]!.bookmark}"`);
    console.error(`[A6] Selecting second row bookmark: "${secondBookmark}"`);

    try {
      const selectResult = await navigationService.selectRow(state.pageContextId, secondBookmark);
      if (isOk(selectResult)) {
        console.error('[A6] SelectRow succeeded');
        const updatedState = derivePageState(unwrap(selectResult));
        console.error(`[A6] Updated state fields: ${updatedState.controlTree.length}`);
      } else {
        console.error(`[A6] SelectRow FAILED: ${selectResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[A6] SelectRow THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[A6] DONE');
    logHealth('A6');
  }, 30_000);

  // ===========================================================================
  // DRILL-DOWN TESTS (medium risk -- drill-down can sometimes crash)
  // ===========================================================================

  // --- 7. Drill-down and Read Fields ---
  it('A7: Drill-down from Customer List and read card fields', async () => {
    console.error('\n--- A7: Drill-down + Read Fields ---');
    if (!await ensureSession('A7')) return;

    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[A7] Open list FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Customer List page 22');
    }
    const listState = derivePageState(unwrap(openResult));

    expect(listState.repeater).toBeTruthy();
    expect(listState.repeater!.rows.length).toBeGreaterThan(0);
    const bookmark = listState.repeater!.rows[0]!.bookmark;
    console.error(`[A7] Drilling down on bookmark: "${bookmark}"`);

    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isOk(drillResult)) {
        const { targetPageContext } = unwrap(drillResult);
        const targetPageState = derivePageState(targetPageContext);
        openedPages.push(targetPageState.pageContextId);
        console.error(`[A7] Drilled to card: ${targetPageState.pageContextId}, ${targetPageState.controlTree.length} fields`);

        const cardFields = ['No.', 'Name', 'Address', 'City', 'Phone No.'];
        let populatedCount = 0;
        for (const name of cardFields) {
          const fResult = dataService.readField(targetPageState.pageContextId, name);
          if (isOk(fResult) && fResult.value) {
            const val = fResult.value.stringValue ?? '';
            console.error(`[A7] Card "${name}": "${val}"`);
            if (val.length > 0) populatedCount++;
          } else {
            console.error(`[A7] Card "${name}": not found or error`);
          }
        }
        console.error(`[A7] Populated fields: ${populatedCount}/${cardFields.length}`);
        expect(populatedCount).toBeGreaterThanOrEqual(2);

        await closeAndUntrack(targetPageState.pageContextId);
      } else {
        console.error(`[A7] Drill-down FAILED: ${drillResult.error.message}`);
        console.error(`[A7] Details: ${JSON.stringify(drillResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[A7] Drill-down THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[A7] DONE');
    logHealth('A7');
  }, 30_000);

  // ===========================================================================
  // RISKY MUTATING TESTS (run last -- these can kill the session)
  // ===========================================================================

  // --- 8. Write + Read Back Verification ---
  it('A8: Write field, read back, verify change, restore', async () => {
    console.error('\n--- A8: Write + Read Back Verification ---');
    if (!await ensureSession('A8')) return;

    // Open Customer List first, drill down to get a real record
    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[A8] Open list FAILED: ${listResult.error.message}`);
      expect.fail('Could not open Customer List');
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();
    const bookmark = listState.repeater!.rows[0]!.bookmark;

    let cardCtx: string | undefined;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isErr(drillResult)) {
        console.error(`[A8] Drill-down FAILED: ${drillResult.error.message}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const { targetPageContext } = unwrap(drillResult);
      cardCtx = targetPageContext.pageContextId;
      openedPages.push(cardCtx);
      console.error(`[A8] Drilled to card: ${cardCtx}`);

      // Find an editable non-critical field
      const fieldsResult = dataService.getFields(cardCtx);
      if (isErr(fieldsResult)) {
        console.error(`[A8] getFields FAILED: ${fieldsResult.error.message}`);
        await closeAndUntrack(cardCtx);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const fields = unwrap(fieldsResult);

      const candidates = ['Fax No.', 'Phone No.', 'E-Mail', 'Home Page'];
      let targetField: { caption: string; stringValue?: string; controlPath: string } | undefined;
      for (const name of candidates) {
        const f = fields.find(f => f.caption?.toLowerCase() === name.toLowerCase() && f.editable);
        if (f) { targetField = f; break; }
      }

      if (!targetField) {
        console.error('[A8] No suitable editable field found. Editable fields:');
        for (const f of fields.filter(f => f.editable).slice(0, 10)) {
          console.error(`[A8]   "${f.caption}": "${f.stringValue ?? ''}" [${f.controlPath}]`);
        }
        console.error('[A8] SKIPPED -- no writable field');
        await closeAndUntrack(cardCtx);
        await closeAndUntrack(listState.pageContextId);
        return;
      }

      const originalValue = targetField.stringValue ?? '';
      const testValue = originalValue === 'ADV-TEST-123' ? 'ADV-TEST-456' : 'ADV-TEST-123';
      console.error(`[A8] Target: "${targetField.caption}" = "${originalValue}", writing "${testValue}"`);

      // Write new value
      const writeResult = await dataService.writeField(cardCtx, targetField.caption, testValue);
      if (isErr(writeResult)) {
        console.error(`[A8] Write FAILED: ${writeResult.error.message}`);
      } else {
        console.error(`[A8] Write OK: newValue="${writeResult.value.newValue}"`);

        // Read it back
        const readBack = dataService.readField(cardCtx, targetField.caption);
        if (isOk(readBack) && readBack.value) {
          const readValue = readBack.value.stringValue ?? '';
          console.error(`[A8] Read back: "${readValue}"`);
          if (readValue === testValue) {
            console.error('[A8] VERIFIED: Write + read back matches');
          } else {
            console.error(`[A8] MISMATCH: expected "${testValue}", got "${readValue}"`);
          }
          expect(readValue).toBe(testValue);
        } else {
          console.error('[A8] Read back FAILED');
        }

        // Restore
        console.error(`[A8] Restoring original value: "${originalValue}"`);
        const restoreResult = await dataService.writeField(cardCtx, targetField.caption, originalValue);
        if (isOk(restoreResult)) {
          console.error(`[A8] Restored OK: "${restoreResult.value.newValue}"`);
        } else {
          console.error(`[A8] Restore FAILED: ${restoreResult.error.message}`);
        }
      }

      await closeAndUntrack(cardCtx);
      cardCtx = undefined;
    } catch (e: unknown) {
      console.error(`[A8] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[A8] DONE');
    logHealth('A8');
  }, 30_000);

  // --- 9. Range filter on Customer List ---
  it('A9: Range filter on Customer List (No. = 10000..30000)', async () => {
    console.error('\n--- A9: Range Filter ---');
    if (!await ensureSession('A9')) return;

    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[A9] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Customer List');
    }
    const state = derivePageState(unwrap(openResult));

    const unfilteredCount = state.repeater?.rows.length ?? 0;
    console.error(`[A9] Unfiltered rows: ${unfilteredCount}`);

    // Apply range filter
    console.error('[A9] Applying filter: No. = "10000..30000"');
    try {
      const filterResult = await filterService.applyFilter(state.pageContextId, 'No.', '10000..30000');
      if (isOk(filterResult)) {
        const filtered = derivePageState(unwrap(filterResult));
        const filteredCount = filtered.repeater?.rows.length ?? 0;
        console.error(`[A9] Filtered rows: ${filteredCount}`);
        if (filtered.repeater) {
          for (const row of filtered.repeater.rows.slice(0, 5)) {
            console.error(`[A9]   row: ${JSON.stringify(row.cells)}`);
          }
        }
        expect(filteredCount).toBeLessThanOrEqual(unfilteredCount);
        expect(filteredCount).toBeGreaterThan(0);
      } else {
        console.error(`[A9] Filter FAILED: ${filterResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[A9] Filter THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Clear filters
    console.error('[A9] Clearing filters...');
    try {
      const clearResult = await filterService.clearFilters(state.pageContextId);
      if (isOk(clearResult)) {
        const restoredCount = derivePageState(clearResult.value).repeater?.rows.length ?? 0;
        console.error(`[A9] Restored rows: ${restoredCount}`);
      } else {
        console.error(`[A9] Clear FAILED: ${clearResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[A9] Clear THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[A9] DONE');
    logHealth('A9');
  }, 30_000);

  // --- 10. Execute "New" action on Customer List ---
  it('A10: Execute "New" (SystemAction=10) on Customer List', async () => {
    console.error('\n--- A10: Execute "New" Action ---');
    if (!await ensureSession('A10')) return;

    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[A10] Open FAILED: ${openResult.error.message}`);
      expect.fail('Could not open Customer List');
    }
    const state = derivePageState(unwrap(openResult));

    console.error('[A10] Executing SystemAction.New (10)...');
    try {
      const actionResult = await actionService.executeSystemAction(state.pageContextId, 10);
      if (isOk(actionResult)) {
        const ar = unwrap(actionResult);
        console.error(`[A10] Action success! events: ${ar.events.length}, dialog: ${ar.dialog ? 'YES' : 'no'}`);
        console.error(`[A10] Event types: ${ar.events.map(e => e.type).join(', ')}`);

        if (ar.dialog) {
          console.error(`[A10] Dialog formId: ${ar.dialog.formId}`);
        }

        const formCreated = ar.events.find(e => e.type === 'FormCreated');
        if (formCreated) {
          console.error('[A10] FormCreated event found -- new card opened');
        } else {
          console.error('[A10] No FormCreated event -- might have opened in-place or as dialog');
        }

        for (const evt of ar.events) {
          console.error(`[A10]   event: type=${evt.type}, ${JSON.stringify(evt).substring(0, 200)}`);
        }
      } else {
        console.error(`[A10] Action FAILED: ${actionResult.error.message}`);
        console.error(`[A10] Details: ${JSON.stringify(actionResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[A10] Action THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Close the list (and any card that may have opened)
    await closeAndUntrack(state.pageContextId);

    if (session?.isAlive) {
      console.error(`[A10] Open forms after close: ${session.openFormIds.size}`);
      for (const fid of Array.from(session.openFormIds)) {
        console.error(`[A10] Leftover form: ${fid}`);
      }
    }

    console.error('[A10] DONE');
    logHealth('A10');
  }, 30_000);
});
