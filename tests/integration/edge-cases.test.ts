/**
 * Edge case and stress tests for BC MCP Server v2.
 *
 * Goal: discover protocol gaps and edge-case failures, not fix them.
 * Each test is self-contained with try/catch so one failure doesn't block the rest.
 * Tests run sequentially sharing a single BCSession.
 *
 * Test ordering: safe read-only tests first, risky mutating tests last.
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
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';

dotenvConfig();

describe('Edge Case & Stress Tests', () => {
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
  // SAFE READ-ONLY TESTS (run first)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // EC4: Pagination -- row count and virtualization
  // ---------------------------------------------------------------------------
  it('EC4: Pagination -- check initial row count and totalRowCount', async () => {
    console.error('\n--- EC4: Pagination / Row Virtualization ---');
    if (!await ensureSession('EC4')) return;

    console.error('[EC4] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[EC4] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = derivePageState(unwrap(openResult));

    if (!state.repeater) {
      console.error('[EC4] No repeater -- SKIPPED');
      await closeAndUntrack(state.pageContextId);
      return;
    }

    const initialRows = state.repeater.rows.length;
    const totalRowCount = state.repeater.totalRowCount;
    console.error(`[EC4] Initial rows loaded: ${initialRows}`);
    console.error(`[EC4] Total row count (from BC): ${totalRowCount}`);
    console.error(`[EC4] Columns: ${state.repeater.columns.length}`);

    if (totalRowCount > initialRows) {
      console.error(`[EC4] BC reports more rows (${totalRowCount}) than loaded (${initialRows})`);
      console.error('[EC4] This means BC uses row virtualization / lazy loading');
      console.error('[EC4] GAP CHECK: Do we have a way to request more rows (scroll)?');
    } else if (totalRowCount === 0) {
      console.error('[EC4] totalRowCount=0 -- BC may not report total, or data not available');
    } else {
      console.error(`[EC4] All rows loaded (initial=${initialRows}, total=${totalRowCount})`);
    }

    if (initialRows > 0) {
      console.error(`[EC4] First row: ${JSON.stringify(state.repeater.rows[0]!.cells)}`);
      console.error(`[EC4] Last row: ${JSON.stringify(state.repeater.rows[initialRows - 1]!.cells)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[EC4] DONE');
    logHealth('EC4');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // EC6: Concurrent page state -- open same page twice
  // ---------------------------------------------------------------------------
  it('EC6: Concurrent page state -- open Customer List twice', async () => {
    console.error('\n--- EC6: Concurrent Page State ---');
    if (!await ensureSession('EC6')) return;

    console.error('[EC6] Opening Customer List (page 22) -- instance 1...');
    const r1 = await openAndTrack('22');
    if (isErr(r1)) {
      console.error(`[EC6] Instance 1 FAILED: ${r1.error.message}`);
      return;
    }
    const state1 = derivePageState(unwrap(r1));
    console.error(`[EC6] Instance 1: pageContextId=${state1.pageContextId}, rows=${state1.repeater?.rows.length ?? 0}`);

    console.error('[EC6] Opening Customer List (page 22) -- instance 2...');
    const r2 = await openAndTrack('22');
    if (isErr(r2)) {
      console.error(`[EC6] Instance 2 FAILED: ${r2.error.message}`);
      console.error('[EC6] FINDING: Cannot open same page twice in same session');
      await closeAndUntrack(state1.pageContextId);
      return;
    }
    const state2 = derivePageState(unwrap(r2));
    console.error(`[EC6] Instance 2: pageContextId=${state2.pageContextId}, rows=${state2.repeater?.rows.length ?? 0}`);

    console.error(`[EC6] pageContextId 1: ${state1.pageContextId}`);
    console.error(`[EC6] pageContextId 2: ${state2.pageContextId}`);
    expect(state1.pageContextId).not.toBe(state2.pageContextId);
    console.error('[EC6] VERIFIED: Different pageContextIds');

    const rows1 = dataService.readRows(state1.pageContextId);
    const rows2 = dataService.readRows(state2.pageContextId);
    if (isOk(rows1)) console.error(`[EC6] Instance 1 rows: ${rows1.value.length}`);
    if (isOk(rows2)) console.error(`[EC6] Instance 2 rows: ${rows2.value.length}`);

    console.error('[EC6] Closing both instances...');
    await closeAndUntrack(state2.pageContextId);
    await closeAndUntrack(state1.pageContextId);
    console.error('[EC6] DONE');
    logHealth('EC6');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC9: Search then open result
  // ---------------------------------------------------------------------------
  it('EC9: Search pages then open a result', async () => {
    console.error('\n--- EC9: Search Then Open ---');
    if (!await ensureSession('EC9')) return;

    console.error('[EC9] Searching for "customer"...');
    try {
      const searchResult = await searchService.search('customer');
      if (isErr(searchResult)) {
        console.error(`[EC9] Search FAILED: ${searchResult.error.message}`);
        return;
      }
      const results = unwrap(searchResult);
      console.error(`[EC9] Search returned ${results.length} results`);

      for (const r of results.slice(0, 10)) {
        console.error(`[EC9]   name="${r.name}", pageId="${r.pageId}", type="${r.type}"`);
      }

      const openable = results.find(r => r.pageId && /^\d+$/.test(r.pageId));
      if (openable) {
        console.error(`[EC9] Opening search result: "${openable.name}" (page ${openable.pageId})...`);
        const openResult = await openAndTrack(openable.pageId);
        if (isOk(openResult)) {
          const state = derivePageState(unwrap(openResult));
          console.error(`[EC9] Opened successfully: pageType=${state.pageType}, fields=${state.controlTree.length}`);
          console.error(`[EC9] repeater: ${state.repeater ? `${state.repeater.rows.length} rows` : 'NONE'}`);
          await closeAndUntrack(state.pageContextId);
          console.error('[EC9] VERIFIED: Search -> Open works end-to-end');
        } else {
          console.error(`[EC9] Open FAILED: ${openResult.error.message}`);
        }
      } else {
        console.error('[EC9] No openable result with numeric pageId found');
      }
    } catch (e: unknown) {
      console.error(`[EC9] THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    console.error('[EC9] DONE');
    logHealth('EC9');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC10: Rapid open/close cycle
  // ---------------------------------------------------------------------------
  it('EC10: Rapid open/close cycle -- session resilience under churn', async () => {
    console.error('\n--- EC10: Rapid Open/Close Cycle ---');
    if (!await ensureSession('EC10')) return;

    const cycles = [
      { pageId: '22', name: 'Customer List' },
      { pageId: '21', name: 'Customer Card' },
      { pageId: '22', name: 'Customer List (again)' },
    ];

    let successCount = 0;
    for (const cycle of cycles) {
      console.error(`[EC10] Cycle: Open ${cycle.name} (page ${cycle.pageId})...`);
      try {
        const openResult = await openAndTrack(cycle.pageId);
        if (isOk(openResult)) {
          const state = derivePageState(unwrap(openResult));
          console.error(`[EC10]   Opened: ${state.pageContextId}, type=${state.pageType}`);
          console.error(`[EC10]   Closing immediately...`);
          await closeAndUntrack(state.pageContextId);
          console.error(`[EC10]   Closed OK`);
          successCount++;
        } else {
          console.error(`[EC10]   Open FAILED: ${openResult.error.message}`);
          if (isSessionDeadErr(openResult)) {
            console.error('[EC10]   SESSION DIED during rapid cycle');
            break;
          }
        }
      } catch (e: unknown) {
        console.error(`[EC10]   THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.error(`[EC10] Completed ${successCount}/${cycles.length} cycles`);

    if (session?.isAlive && !sessionDead) {
      console.error('[EC10] Final verification: opening page 22...');
      try {
        const finalResult = await openAndTrack('22');
        if (isOk(finalResult)) {
          const state = derivePageState(unwrap(finalResult));
          console.error(`[EC10] Final open OK: ${state.repeater?.rows.length ?? 0} rows`);
          expect(state.repeater).toBeTruthy();
          expect(state.repeater!.rows.length).toBeGreaterThan(0);
          await closeAndUntrack(state.pageContextId);
          console.error('[EC10] VERIFIED: Session survived rapid open/close');
        } else {
          console.error(`[EC10] Final open FAILED: ${finalResult.error.message}`);
        }
      } catch (e: unknown) {
        console.error(`[EC10] Final THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.error('[EC10] Session dead after rapid cycles -- PROTOCOL GAP');
    }

    console.error('[EC10] DONE');
    logHealth('EC10');
  }, 60_000);

  // ===========================================================================
  // DRILL-DOWN TESTS (medium risk)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // EC3: Sales Order subpage (line items)
  // ---------------------------------------------------------------------------
  it('EC3: Sales Order subpage -- check line items on document page', async () => {
    console.error('\n--- EC3: Sales Order Subpage/Line Items ---');
    if (!await ensureSession('EC3')) return;

    console.error('[EC3] Opening Sales Order List (page 43)...');
    const listResult = await openAndTrack('43');
    if (isErr(listResult)) {
      console.error(`[EC3] Open list FAILED: ${listResult.error.message}`);
      return;
    }
    const listState = derivePageState(unwrap(listResult));
    console.error(`[EC3] List pageType=${listState.pageType}, rows=${listState.repeater?.rows.length ?? 0}`);

    if (!listState.repeater || listState.repeater.rows.length === 0) {
      console.error('[EC3] No sales orders found -- SKIPPED');
      await closeAndUntrack(listState.pageContextId);
      return;
    }

    const bookmark = listState.repeater.rows[0]!.bookmark;
    console.error(`[EC3] Drilling down to first order, bookmark: "${bookmark}"`);

    let orderCtx: string | undefined;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isErr(drillResult)) {
        console.error(`[EC3] Drill-down FAILED: ${drillResult.error.message}`);
        console.error(`[EC3] Details: ${JSON.stringify(drillResult.error.details)}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const { targetPageContext } = unwrap(drillResult);
      const targetPageState = derivePageState(targetPageContext);
      orderCtx = targetPageState.pageContextId;
      openedPages.push(orderCtx);

      console.error(`[EC3] Order page opened: ${orderCtx}`);
      console.error(`[EC3] pageType=${targetPageState.pageType}`);
      console.error(`[EC3] controlTree fields: ${targetPageState.controlTree.length}`);
      console.error(`[EC3] repeater: ${targetPageState.repeater ? `${targetPageState.repeater.rows.length} rows, ${targetPageState.repeater.columns.length} columns` : 'NONE'}`);
      console.error(`[EC3] childForms: ${targetPageState.childForms.length}`);
      console.error(`[EC3] actions: ${targetPageState.actions.length}`);

      for (const child of targetPageState.childForms) {
        console.error(`[EC3] ChildForm: formId=${child.formId}, type=${child.type ?? 'unknown'}`);
      }

      if (targetPageState.repeater) {
        console.error(`[EC3] Line columns: ${targetPageState.repeater.columns.map(c => c.caption).join(', ')}`);
        for (const row of targetPageState.repeater.rows.slice(0, 5)) {
          console.error(`[EC3] Line row: bookmark=${row.bookmark}, cells=${JSON.stringify(row.cells).substring(0, 300)}`);
        }
      } else {
        console.error('[EC3] WARNING: No repeater on Sales Order page -- subpage lines not parsed');
        console.error('[EC3] This may be a PROTOCOL GAP -- document pages should expose line items');
      }

      const headerFields = ['No.', 'Sell-to Customer No.', 'Sell-to Customer Name', 'Status', 'Posting Date'];
      for (const name of headerFields) {
        const fResult = dataService.readField(orderCtx, name);
        if (isOk(fResult) && fResult.value) {
          console.error(`[EC3] Header "${name}": "${fResult.value.stringValue ?? ''}" [editable=${fResult.value.editable}]`);
        } else {
          console.error(`[EC3] Header "${name}": not found`);
        }
      }

      await closeAndUntrack(orderCtx);
      orderCtx = undefined;
    } catch (e: unknown) {
      console.error(`[EC3] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (orderCtx) try { await closeAndUntrack(orderCtx); } catch { /* ignore */ }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[EC3] DONE');
    logHealth('EC3');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC7: Action on Card page
  // ---------------------------------------------------------------------------
  it('EC7: Action on Card page -- execute Statistics or other safe action', async () => {
    console.error('\n--- EC7: Card Page Action ---');
    if (!await ensureSession('EC7')) return;

    console.error('[EC7] Opening Customer List (page 22)...');
    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[EC7] Open list FAILED: ${listResult.error.message}`);
      return;
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();

    const bookmark = listState.repeater!.rows[0]!.bookmark;
    let cardCtx: string | undefined;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isErr(drillResult)) {
        console.error(`[EC7] Drill-down FAILED: ${drillResult.error.message}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const { targetPageContext } = unwrap(drillResult);
      const targetPageState = derivePageState(targetPageContext);
      cardCtx = targetPageState.pageContextId;
      openedPages.push(cardCtx);

      const cardActions = targetPageState.actions.filter(a => a.visible && a.enabled);
      console.error(`[EC7] Card actions (${cardActions.length}):`);
      for (const a of cardActions.slice(0, 25)) {
        console.error(`[EC7]   caption="${a.caption}", systemAction=${a.systemAction}, path=${a.controlPath}`);
      }

      const safeActions = ['Statistics', 'Ledger Entries', 'Ledger E&ntries', 'Co&mments', 'Comments'];
      let executedAction = false;
      for (const actionName of safeActions) {
        const exists = cardActions.find(a => a.caption.toLowerCase() === actionName.toLowerCase());
        if (exists) {
          console.error(`[EC7] Executing "${actionName}" on card...`);
          try {
            const actionResult = await actionService.executeAction(cardCtx, actionName);
            if (isOk(actionResult)) {
              const ar = unwrap(actionResult);
              console.error(`[EC7] "${actionName}" OK: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);
              console.error(`[EC7] Event types: ${ar.events.map(e => e.type).join(', ')}`);
              if (ar.dialog) {
                console.error(`[EC7] Dialog formId: ${ar.dialog.formId}`);
                console.error('[EC7] FINDING: Action opened a dialog on card page');
              }
              const formCreated = ar.events.find(e => e.type === 'FormCreated');
              if (formCreated) {
                console.error('[EC7] FINDING: Action opened a new form/page');
              }
            } else {
              console.error(`[EC7] "${actionName}" FAILED: ${actionResult.error.message}`);
            }
          } catch (e: unknown) {
            console.error(`[EC7] "${actionName}" THREW: ${e instanceof Error ? e.message : String(e)}`);
          }
          executedAction = true;
          break;
        }
      }

      if (!executedAction) {
        console.error('[EC7] None of the safe actions found. Trying SystemAction.Refresh (30)...');
        try {
          const refreshResult = await actionService.executeSystemAction(cardCtx, SystemAction.Refresh);
          if (isOk(refreshResult)) {
            console.error(`[EC7] Refresh OK: events=${refreshResult.value.events.length}`);
          } else {
            console.error(`[EC7] Refresh FAILED: ${refreshResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[EC7] Refresh THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await closeAndUntrack(cardCtx);
      cardCtx = undefined;
    } catch (e: unknown) {
      console.error(`[EC7] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[EC7] DONE');
    logHealth('EC7');
  }, 60_000);

  // ===========================================================================
  // RISKY MUTATING TESTS (run last -- these can kill the session)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // EC1: Write field then read it back (round-trip verification via drill-down)
  // ---------------------------------------------------------------------------
  it('EC1: Write field then read back -- round-trip on Customer Card via drill-down', async () => {
    console.error('\n--- EC1: Write/Read Round-Trip ---');
    if (!await ensureSession('EC1')) return;

    console.error('[EC1] Opening Customer List (page 22)...');
    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[EC1] Open list FAILED: ${listResult.error.message}`);
      return;
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();
    expect(listState.repeater!.rows.length).toBeGreaterThan(0);

    const bookmark = listState.repeater!.rows[0]!.bookmark;
    console.error(`[EC1] Drilling down on bookmark: "${bookmark}"`);

    let cardCtx: string | undefined;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isErr(drillResult)) {
        console.error(`[EC1] Drill-down FAILED: ${drillResult.error.message}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const { targetPageContext } = unwrap(drillResult);
      const targetPageState = derivePageState(targetPageContext);
      cardCtx = targetPageState.pageContextId;
      openedPages.push(cardCtx);
      console.error(`[EC1] Drilled to card: ${cardCtx}, pageType=${targetPageState.pageType}`);

      // Read Phone No. field
      const readBefore = dataService.readField(cardCtx, 'Phone No.');
      if (isErr(readBefore)) {
        console.error(`[EC1] readField "Phone No." FAILED: ${readBefore.error.message}`);
        await closeAndUntrack(cardCtx);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const originalValue = readBefore.value?.stringValue ?? '';
      console.error(`[EC1] Original "Phone No." = "${originalValue}"`);

      // Write new value
      const testValue = '555-1234-TEST';
      console.error(`[EC1] Writing "Phone No." = "${testValue}"...`);
      const writeResult = await dataService.writeField(cardCtx, 'Phone No.', testValue);
      if (isErr(writeResult)) {
        console.error(`[EC1] Write FAILED: ${writeResult.error.message}`);
        console.error(`[EC1] Details: ${JSON.stringify(writeResult.error.details)}`);
      } else {
        console.error(`[EC1] Write result: success=${writeResult.value.success}, newValue="${writeResult.value.newValue}"`);

        // Read back
        const readAfter = dataService.readField(cardCtx, 'Phone No.');
        if (isOk(readAfter) && readAfter.value) {
          const readBackValue = readAfter.value.stringValue ?? '';
          console.error(`[EC1] Read back "Phone No." = "${readBackValue}"`);
          if (readBackValue === testValue) {
            console.error('[EC1] ROUND-TRIP VERIFIED: write then read matches');
          } else {
            console.error(`[EC1] ROUND-TRIP MISMATCH: expected "${testValue}", got "${readBackValue}"`);
            console.error('[EC1] GAP: writeField reports success but read-back does not reflect new value');
            console.error('[EC1] Possible causes: state projection not updating stringValue from SaveValue response');
          }
        } else {
          console.error('[EC1] Read-back FAILED');
        }

        // Restore original value
        console.error(`[EC1] Restoring original value: "${originalValue}"`);
        const restoreResult = await dataService.writeField(cardCtx, 'Phone No.', originalValue);
        if (isOk(restoreResult)) {
          console.error(`[EC1] Restored OK: "${restoreResult.value.newValue}"`);
        } else {
          console.error(`[EC1] Restore FAILED: ${restoreResult.error.message}`);
        }
      }

      await closeAndUntrack(cardCtx);
      cardCtx = undefined;
    } catch (e: unknown) {
      console.error(`[EC1] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[EC1] DONE');
    logHealth('EC1');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC5: Field types -- write different BC types
  // ---------------------------------------------------------------------------
  it('EC5: Field types -- attempt writing boolean, date, option fields', async () => {
    console.error('\n--- EC5: Field Types ---');
    if (!await ensureSession('EC5')) return;

    console.error('[EC5] Opening Customer List (page 22)...');
    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[EC5] Open list FAILED: ${listResult.error.message}`);
      return;
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();

    const bookmark = listState.repeater!.rows[0]!.bookmark;
    let cardCtx: string | undefined;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isErr(drillResult)) {
        console.error(`[EC5] Drill-down FAILED: ${drillResult.error.message}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const { targetPageContext } = unwrap(drillResult);
      cardCtx = targetPageContext.pageContextId;
      openedPages.push(cardCtx);

      const fieldsResult = dataService.getFields(cardCtx);
      if (isErr(fieldsResult)) {
        console.error(`[EC5] getFields FAILED: ${fieldsResult.error.message}`);
        await closeAndUntrack(cardCtx);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const fields = unwrap(fieldsResult);

      // Log field type distribution
      const typeMap = new Map<string, number>();
      for (const f of fields) {
        const count = typeMap.get(f.type) ?? 0;
        typeMap.set(f.type, count + 1);
      }
      console.error(`[EC5] Field type distribution:`);
      for (const [type, count] of typeMap) {
        console.error(`[EC5]   ${type}: ${count} fields`);
      }

      const editableFields = fields.filter(f => f.editable && f.caption);
      console.error(`[EC5] Editable fields (${editableFields.length}):`);
      for (const f of editableFields.slice(0, 20)) {
        console.error(`[EC5]   "${f.caption}" type=${f.type} value="${f.stringValue ?? ''}" [${f.controlPath}]`);
      }

      // Try writing to a boolean field
      const booleanField = editableFields.find(f =>
        f.type.toLowerCase().includes('bool') || f.type.toLowerCase().includes('check')
      );
      if (booleanField) {
        const originalBool = booleanField.stringValue ?? '';
        const newBool = originalBool === 'true' ? 'false' : 'true';
        console.error(`[EC5] BOOLEAN: Trying "${booleanField.caption}" = "${newBool}" (was "${originalBool}")`);
        try {
          const boolResult = await dataService.writeField(cardCtx, booleanField.caption, newBool);
          if (isOk(boolResult)) {
            console.error(`[EC5] BOOLEAN write OK: newValue="${boolResult.value.newValue}"`);
            await dataService.writeField(cardCtx, booleanField.caption, originalBool);
            console.error('[EC5] BOOLEAN restored');
          } else {
            console.error(`[EC5] BOOLEAN write FAILED: ${boolResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[EC5] BOOLEAN write THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.error('[EC5] No boolean/checkbox field found among editable fields');
      }

      // Try writing to a date field
      const dateField = editableFields.find(f => f.type.toLowerCase().includes('date'));
      if (dateField) {
        const originalDate = dateField.stringValue ?? '';
        const testDate = '01/15/2025';
        console.error(`[EC5] DATE: Trying "${dateField.caption}" = "${testDate}" (was "${originalDate}")`);
        try {
          const dateResult = await dataService.writeField(cardCtx, dateField.caption, testDate);
          if (isOk(dateResult)) {
            console.error(`[EC5] DATE write OK: newValue="${dateResult.value.newValue}"`);
            if (originalDate) {
              await dataService.writeField(cardCtx, dateField.caption, originalDate);
              console.error('[EC5] DATE restored');
            }
          } else {
            console.error(`[EC5] DATE write FAILED: ${dateResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[EC5] DATE write THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.error('[EC5] No date field found among editable fields');
      }

      // Try writing to an option/selection field
      const optionField = editableFields.find(f =>
        f.type.toLowerCase().includes('option') ||
        f.type.toLowerCase().includes('enum') ||
        f.type.toLowerCase().includes('select')
      );
      if (optionField) {
        const originalOption = optionField.stringValue ?? '';
        console.error(`[EC5] OPTION: Found "${optionField.caption}" type=${optionField.type} value="${originalOption}"`);
        console.error(`[EC5] OPTION: Trying to write "1" (generic option index)`);
        try {
          const optionResult = await dataService.writeField(cardCtx, optionField.caption, '1');
          if (isOk(optionResult)) {
            console.error(`[EC5] OPTION write OK: newValue="${optionResult.value.newValue}"`);
            await dataService.writeField(cardCtx, optionField.caption, originalOption);
            console.error('[EC5] OPTION restored');
          } else {
            console.error(`[EC5] OPTION write FAILED: ${optionResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[EC5] OPTION write THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.error('[EC5] No option/enum field found among editable fields');
      }

      await closeAndUntrack(cardCtx);
      cardCtx = undefined;
    } catch (e: unknown) {
      console.error(`[EC5] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[EC5] DONE');
    logHealth('EC5');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC8: Filter with wildcard (RISKY -- can kill session with ArgumentOutOfRange)
  // ---------------------------------------------------------------------------
  it('EC8: Filter with wildcard -- Name = "*a*"', async () => {
    console.error('\n--- EC8: Filter with Wildcard ---');
    if (!await ensureSession('EC8')) return;

    console.error('[EC8] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[EC8] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = derivePageState(unwrap(openResult));

    const unfilteredCount = state.repeater?.rows.length ?? 0;
    console.error(`[EC8] Unfiltered rows: ${unfilteredCount}`);

    console.error('[EC8] Applying filter: Name = "*a*" (wildcard)...');
    try {
      const filterResult = await filterService.applyFilter(state.pageContextId, 'Name', '*a*');
      if (isOk(filterResult)) {
        const filtered = derivePageState(unwrap(filterResult));
        const filteredCount = filtered.repeater?.rows.length ?? 0;
        console.error(`[EC8] Filtered rows: ${filteredCount} (was ${unfilteredCount})`);

        if (filtered.repeater) {
          for (const row of filtered.repeater.rows.slice(0, 5)) {
            console.error(`[EC8]   Row: ${JSON.stringify(row.cells).substring(0, 200)}`);
          }
        }

        if (filteredCount < unfilteredCount) {
          console.error('[EC8] WILDCARD FILTER WORKS: got fewer rows than unfiltered');
        } else if (filteredCount === unfilteredCount) {
          console.error('[EC8] NOTE: Same row count -- all customers may match *a*');
        }
      } else {
        console.error(`[EC8] Filter FAILED: ${filterResult.error.message}`);
        console.error(`[EC8] Details: ${JSON.stringify(filterResult.error.details)}`);
        console.error('[EC8] GAP: Wildcard filter on "Name" column causes ArgumentOutOfRangeException');
        console.error('[EC8] Possible cause: Filter(AddLine) controlPath or filterColumnId mismatch for text columns');
      }
    } catch (e: unknown) {
      console.error(`[EC8] Filter THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Only try clearing if session is alive
    if (session?.isAlive) {
      console.error('[EC8] Clearing filters...');
      try {
        const clearResult = await filterService.clearFilters(state.pageContextId);
        if (isOk(clearResult)) {
          console.error(`[EC8] Cleared OK: rows=${clearResult.value.repeater?.rows.length ?? 0}`);
        } else {
          console.error(`[EC8] Clear FAILED: ${clearResult.error.message}`);
        }
      } catch (e: unknown) {
        console.error(`[EC8] Clear THREW: ${e instanceof Error ? e.message : String(e)}`);
      }

      await closeAndUntrack(state.pageContextId);
    } else {
      console.error('[EC8] Session died from filter -- cannot close page');
      sessionDead = true;
    }

    console.error('[EC8] DONE');
    logHealth('EC8');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC2: Execute Delete then Cancel dialog (LAST -- kills session on failure)
  // ---------------------------------------------------------------------------
  it('EC2: Execute Delete action then Cancel the confirmation dialog', async () => {
    console.error('\n--- EC2: Delete + Cancel Dialog ---');
    if (!await ensureSession('EC2')) return;

    console.error('[EC2] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[EC2] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = derivePageState(unwrap(openResult));

    expect(state.repeater).toBeTruthy();
    const rowCountBefore = state.repeater!.rows.length;
    console.error(`[EC2] Rows before: ${rowCountBefore}`);

    const bookmark = state.repeater!.rows[0]!.bookmark;
    console.error(`[EC2] Selecting row bookmark: "${bookmark}"`);
    try {
      const selectResult = await navigationService.selectRow(state.pageContextId, bookmark);
      if (isErr(selectResult)) {
        console.error(`[EC2] SelectRow FAILED: ${selectResult.error.message}`);
      } else {
        console.error('[EC2] Row selected OK');
      }
    } catch (e: unknown) {
      console.error(`[EC2] SelectRow THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    console.error('[EC2] Executing SystemAction.Delete (20)...');
    try {
      const deleteResult = await actionService.executeSystemAction(state.pageContextId, SystemAction.Delete);
      if (isOk(deleteResult)) {
        const ar = unwrap(deleteResult);
        console.error(`[EC2] Delete action returned: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);
        console.error(`[EC2] Event types: ${ar.events.map(e => e.type).join(', ')}`);

        if (ar.dialog) {
          console.error(`[EC2] Dialog formId: ${ar.dialog.formId}`);
          console.error(`[EC2] Dialog controlTree: ${JSON.stringify(ar.dialog.controlTree).substring(0, 500)}`);

          console.error('[EC2] Sending Cancel (SystemAction.No = 390) to dialog...');
          try {
            const cancelResult = await actionService.executeSystemAction(state.pageContextId, SystemAction.No);
            if (isOk(cancelResult)) {
              console.error(`[EC2] Cancel succeeded: events=${cancelResult.value.events.length}`);
            } else {
              console.error(`[EC2] Cancel FAILED: ${cancelResult.error.message}`);
            }
          } catch (e: unknown) {
            console.error(`[EC2] Cancel THREW: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          console.error('[EC2] WARNING: No dialog returned from Delete -- might have deleted directly!');
          console.error('[EC2] This is a PROTOCOL GAP if BC usually shows a confirmation dialog');
        }

        const rowsResult = dataService.readRows(state.pageContextId);
        if (isOk(rowsResult)) {
          const rowCountAfter = rowsResult.value.length;
          console.error(`[EC2] Rows after: ${rowCountAfter} (was ${rowCountBefore})`);
          if (rowCountAfter === rowCountBefore) {
            console.error('[EC2] VERIFIED: Record was NOT deleted (Cancel worked)');
          } else {
            console.error(`[EC2] WARNING: Row count changed! ${rowCountBefore} -> ${rowCountAfter}`);
          }
        } else {
          console.error(`[EC2] readRows FAILED: ${rowsResult.error.message}`);
        }
      } else {
        console.error(`[EC2] Delete FAILED: ${deleteResult.error.message}`);
        console.error(`[EC2] Details: ${JSON.stringify(deleteResult.error.details)}`);
        console.error('[EC2] GAP: executeSystemAction(Delete) throws ArgumentOutOfRangeException');
        console.error('[EC2] Possible cause: controlPath resolution fails after selectRow changes layout');
      }
    } catch (e: unknown) {
      console.error(`[EC2] Delete THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[EC2] DONE');
    logHealth('EC2');
  }, 60_000);
});
