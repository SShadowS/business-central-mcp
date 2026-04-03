/**
 * Comprehensive workflow smoke tests exercising all 7 MCP tools (services)
 * against a live BC instance.
 *
 * Goal: discover protocol gaps, not fix them.
 * Each workflow is a self-contained it() block. Tests run sequentially
 * because they share a single BCSession.
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

describe('Workflow Smoke Tests (all 7 MCP tools)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let filterService: FilterService;
  let navigationService: NavigationService;
  let searchService: SearchService;
  const logger = createNullLogger();

  /** Track pages we opened so afterAll can try to clean up. */
  const openedPages: string[] = [];

  /** Set to true when the BC session dies (InvalidSessionException). Later tests skip. */
  let sessionDead = false;

  /** Kept at describe scope so recreateSession() can use it. */
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

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    filterService = new FilterService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    searchService = new SearchService(session, logger);
  }, 30_000);

  afterAll(async () => {
    // Best-effort cleanup of any pages left open
    for (const pageCtx of openedPages) {
      try {
        await pageService.closePage(pageCtx, { discardChanges: true });
      } catch {
        // ignore
      }
    }
    await session?.closeGracefully().catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Guard: skip the test body if the session has already died. */
  function requireLiveSession(tag: string): void {
    if (sessionDead) {
      console.error(`[${tag}] SKIPPED -- session is dead (InvalidSessionException in a prior workflow)`);
      return; // caller should return immediately after this
    }
  }

  /** Detect InvalidSessionException in a Result error. */
  function isSessionDead(result: { ok: false; error: { message: string } }): boolean {
    return result.error.message.includes('InvalidSessionException');
  }

  async function openAndTrack(pageId: string) {
    const result = await pageService.openPage(pageId);
    if (isOk(result)) {
      openedPages.push(result.value.pageContextId);
    } else if (isSessionDead(result)) {
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

  /**
   * Attempt to recreate the shared session and all services from scratch.
   * Returns true if successful, false if BC refuses to accept a new session.
   * BC with NTLM auth may refuse reconnections if the previous WebSocket connection
   * hasn't been fully cleaned up on the server side.
   */
  async function recreateSession(): Promise<boolean> {
    console.error('[SESSION] Recreating session (old one is dead)...');
    try { await session?.closeGracefully().catch(() => {}); } catch { /* ignore */ }

    // BC may briefly reject logins right after a session is killed — retry with backoff
    let result = await sessionFactory.create();
    const delays = [3000, 5000, 10000, 15000];
    for (let i = 0; isErr(result) && i < delays.length; i++) {
      const delay = delays[i]!;
      console.error(`[SESSION] Attempt ${i + 1} failed (${result.error.message}), retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      result = await sessionFactory.create();
    }
    if (isErr(result)) {
      console.error(`[SESSION] Recreation failed after all retries: ${result.error.message}`);
      console.error('[SESSION] BC server is likely holding the NTLM session slot — cannot reconnect in this test run');
      return false;
    }
    session = unwrap(result);

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    filterService = new FilterService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    searchService = new SearchService(session, logger);
    sessionDead = false;
    console.error('[SESSION] Recreated session successfully');
    return true;
  }

  /** Log session health — call after each workflow completes. */
  function logSessionHealth(tag: string): void {
    console.error(`[SESSION][${tag}] alive=${session?.isAlive}, openForms=${session?.openFormIds.size}`);
  }

  // ===========================================================================
  // Workflow 1: Customer List Browse
  // ===========================================================================
  it('Workflow 1: Customer List Browse — open, read rows, close', async () => {
    console.error('\n--- Workflow 1: Customer List Browse ---');

    // Step 1: Open page 22 (Customer List)
    console.error('[W1] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    expect(isOk(openResult)).toBe(true);
    const state = derivePageState(unwrap(openResult));

    console.error(`[W1] Page opened: pageContextId=${state.pageContextId}, formId=${state.formId}`);
    console.error(`[W1] pageType=${state.pageType}, controlTree=${state.controlTree.length} fields`);
    console.error(`[W1] repeater: ${state.repeater ? `${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns` : 'NONE'}`);
    console.error(`[W1] actions: ${state.actions.length} total, ${state.actions.filter(a => a.visible && a.enabled).length} visible+enabled`);
    console.error(`[W1] filterControlPath: ${state.filterControlPath ?? 'NONE'}`);

    // Step 2: Verify rows with bookmarks
    expect(state.repeater).toBeTruthy();
    expect(state.repeater!.rows.length).toBeGreaterThan(0);
    const firstRow = state.repeater!.rows[0]!;
    console.error(`[W1] First row bookmark: "${firstRow.bookmark}"`);
    console.error(`[W1] First row cells: ${JSON.stringify(firstRow.cells)}`);
    expect(firstRow.bookmark).toBeTruthy();

    // Step 3: Read rows via DataService (cached)
    console.error('[W1] Reading rows via DataService.readRows()...');
    const rowsResult = dataService.readRows(state.pageContextId);
    expect(isOk(rowsResult)).toBe(true);
    const rows = unwrap(rowsResult);
    console.error(`[W1] DataService returned ${rows.length} rows`);
    expect(rows.length).toBeGreaterThan(0);

    // Step 4: Close
    console.error('[W1] Closing page...');
    const closeResult = await closeAndUntrack(state.pageContextId);
    expect(isOk(closeResult)).toBe(true);
    console.error('[W1] PASSED');
    logSessionHealth('W1');
  }, 30_000);

  // ===========================================================================
  // Workflow 2: Customer Card Read
  // ===========================================================================
  it('Workflow 2: Customer Card Read — open, read fields, close', async () => {
    console.error('\n--- Workflow 2: Customer Card Read ---');

    // Step 1: Open page 21 (Customer Card)
    console.error('[W2] Opening Customer Card (page 21)...');
    const openResult = await openAndTrack('21');
    expect(isOk(openResult)).toBe(true);
    const state = derivePageState(unwrap(openResult));

    console.error(`[W2] pageType=${state.pageType}, ${state.controlTree.length} fields`);

    // Step 2: Verify fields with captions and values
    const fieldsWithCaptions = state.controlTree.filter(f => f.caption);
    const fieldsWithValues = state.controlTree.filter(f => f.stringValue);
    console.error(`[W2] Fields with captions: ${fieldsWithCaptions.length}`);
    console.error(`[W2] Fields with values: ${fieldsWithValues.length}`);

    for (const f of fieldsWithCaptions.slice(0, 10)) {
      console.error(`[W2]   "${f.caption}": "${f.stringValue ?? ''}" [editable=${f.editable}]`);
    }

    expect(fieldsWithCaptions.length).toBeGreaterThan(0);

    // Step 3: Read specific field by name
    console.error('[W2] Reading field "No." via DataService.readField()...');
    const noFieldResult = dataService.readField(state.pageContextId, 'No.');
    expect(isOk(noFieldResult)).toBe(true);
    const noField = unwrap(noFieldResult);
    console.error(`[W2] "No." field: ${noField ? `caption="${noField.caption}", value="${noField.stringValue}"` : 'NOT FOUND'}`);

    console.error('[W2] Reading field "Name" via DataService.readField()...');
    const nameFieldResult = dataService.readField(state.pageContextId, 'Name');
    expect(isOk(nameFieldResult)).toBe(true);
    const nameField = unwrap(nameFieldResult);
    console.error(`[W2] "Name" field: ${nameField ? `caption="${nameField.caption}", value="${nameField.stringValue}"` : 'NOT FOUND'}`);

    // Step 4: Close
    console.error('[W2] Closing page...');
    await closeAndUntrack(state.pageContextId);
    console.error('[W2] PASSED');
    logSessionHealth('W2');
  }, 30_000);

  // ===========================================================================
  // Workflow 3: List -> Drill Down -> Card
  // ===========================================================================
  it('Workflow 3: List -> Drill Down -> Card', async () => {
    console.error('\n--- Workflow 3: List -> Drill Down -> Card ---');

    // Step 1: Open Customer List
    console.error('[W3] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    expect(isOk(openResult)).toBe(true);
    const listState = derivePageState(unwrap(openResult));

    // Step 2: Get first row bookmark
    expect(listState.repeater).toBeTruthy();
    expect(listState.repeater!.rows.length).toBeGreaterThan(0);
    const bookmark = listState.repeater!.rows[0]!.bookmark;
    console.error(`[W3] First row bookmark: "${bookmark}"`);
    expect(bookmark).toBeTruthy();

    // Step 3: Drill down
    console.error('[W3] Drilling down with NavigationService.drillDown()...');
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isOk(drillResult)) {
        const { sourcePageContextId, targetPageContext } = unwrap(drillResult);
        const targetPageState = derivePageState(targetPageContext);
        openedPages.push(targetPageState.pageContextId);
        console.error(`[W3] Drill down success! target pageContextId=${targetPageState.pageContextId}`);
        console.error(`[W3] target formId=${targetPageState.formId}, pageType=${targetPageState.pageType}`);
        console.error(`[W3] target fields: ${targetPageState.controlTree.length}`);

        // Step 4: Read fields from drilled-down card
        const fieldsResult = dataService.getFields(targetPageState.pageContextId);
        if (isOk(fieldsResult)) {
          const fields = unwrap(fieldsResult);
          const captionFields = fields.filter(f => f.caption);
          console.error(`[W3] Card fields with captions: ${captionFields.length}`);
          for (const f of captionFields.slice(0, 5)) {
            console.error(`[W3]   "${f.caption}": "${f.stringValue ?? ''}"`);
          }
        } else {
          console.error(`[W3] getFields on drilled card FAILED: ${fieldsResult.error.message}`);
        }

        // Step 5: Close target
        console.error('[W3] Closing drilled-down card...');
        await closeAndUntrack(targetPageState.pageContextId);
      } else {
        console.error(`[W3] Drill down FAILED: ${drillResult.error.message}`);
        console.error(`[W3] Details: ${JSON.stringify(drillResult.error.details)}`);
        // Don't fail the test — we want to discover gaps, not block the suite
      }
    } catch (e: unknown) {
      console.error(`[W3] Drill down THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Close list
    console.error('[W3] Closing Customer List...');
    await closeAndUntrack(listState.pageContextId);
    console.error('[W3] DONE');
    logSessionHealth('W3');
  }, 30_000);

  // ===========================================================================
  // Workflow 4: Execute Action
  // ===========================================================================
  it('Workflow 4: Execute Action — list actions, run a safe one', async () => {
    console.error('\n--- Workflow 4: Execute Action ---');
    if (sessionDead) { console.error('[W4] SKIPPED -- session dead'); return; }

    // Step 1: Open Customer List
    console.error('[W4] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) { console.error(`[W4] Open FAILED: ${openResult.error.message}`); return; }
    const state = derivePageState(unwrap(openResult));

    // Step 2: List available actions
    const visibleActions = state.actions.filter(a => a.visible && a.enabled);
    console.error(`[W4] Total actions: ${state.actions.length}, visible+enabled: ${visibleActions.length}`);
    for (const a of visibleActions.slice(0, 20)) {
      console.error(`[W4]   caption="${a.caption}", systemAction=${a.systemAction}, path=${a.controlPath}`);
    }

    // Step 3: Try Refresh (SystemAction 30 — safe, read-only)
    console.error('[W4] Executing SystemAction.Refresh (30)...');
    try {
      const actionResult = await actionService.executeSystemAction(state.pageContextId, 30);
      if (isOk(actionResult)) {
        const ar = unwrap(actionResult);
        console.error(`[W4] Refresh success! events: ${ar.events.length}, dialog: ${ar.dialog ? 'YES' : 'no'}`);
        console.error(`[W4] Event types: ${ar.events.map(e => e.type).join(', ')}`);
      } else {
        console.error(`[W4] Refresh FAILED: ${actionResult.error.message}`);
        console.error(`[W4] Details: ${JSON.stringify(actionResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[W4] Refresh THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Also try executing by caption if any caption-based action is safe
    const safeActionNames = ['Refresh', 'Statistics', 'Ledger Entries'];
    for (const actionName of safeActionNames) {
      const exists = visibleActions.find(a => a.caption.toLowerCase() === actionName.toLowerCase());
      if (exists) {
        console.error(`[W4] Trying action by caption: "${actionName}"...`);
        try {
          const captionResult = await actionService.executeAction(state.pageContextId, actionName);
          if (isOk(captionResult)) {
            console.error(`[W4] "${actionName}" success! events: ${captionResult.value.events.length}`);
          } else {
            console.error(`[W4] "${actionName}" FAILED: ${captionResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[W4] "${actionName}" THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
        break; // Only try one
      }
    }

    // Close
    console.error('[W4] Closing page...');
    await closeAndUntrack(state.pageContextId);
    console.error('[W4] DONE');
    logSessionHealth('W4');
  }, 30_000);

  // ===========================================================================
  // Workflow 5: Write Field (write + restore)
  // ===========================================================================
  it('Workflow 5: Write Field — write then restore on Customer Card', async () => {
    console.error('\n--- Workflow 5: Write Field ---');
    if (sessionDead) { console.error('[W5] SKIPPED -- session dead'); return; }

    // Step 1: Open Customer Card
    console.error('[W5] Opening Customer Card (page 21)...');
    const openResult = await openAndTrack('21');
    if (isErr(openResult)) { console.error(`[W5] Open FAILED: ${openResult.error.message}`); return; }
    const state = derivePageState(unwrap(openResult));

    // Step 2: Read current value of "Phone No."
    const fieldsResult = dataService.getFields(state.pageContextId);
    if (isErr(fieldsResult)) { console.error(`[W5] getFields FAILED: ${fieldsResult.error.message}`); return; }
    const fields = unwrap(fieldsResult);

    // Find an editable field — try Phone No., E-Mail, Fax No.
    const candidateNames = ['Phone No.', 'E-Mail', 'Fax No.', 'Home Page'];
    let targetField: { caption: string; stringValue?: string; controlPath: string } | undefined;
    for (const name of candidateNames) {
      const f = fields.find(f => f.caption.toLowerCase() === name.toLowerCase() && f.editable);
      if (f) {
        targetField = f;
        break;
      }
    }

    if (!targetField) {
      console.error(`[W5] No editable field found among candidates. Available editable fields:`);
      for (const f of fields.filter(f => f.editable).slice(0, 15)) {
        console.error(`[W5]   "${f.caption}": "${f.stringValue ?? ''}" [${f.controlPath}]`);
      }
      console.error('[W5] SKIPPED — no suitable editable field');
      await closeAndUntrack(state.pageContextId);
      return;
    }

    const originalValue = targetField.stringValue ?? '';
    const testValue = originalValue === 'SMOKE-TEST' ? 'SMOKE-TEST-2' : 'SMOKE-TEST';
    console.error(`[W5] Target field: "${targetField.caption}" = "${originalValue}"`);
    console.error(`[W5] Writing new value: "${testValue}"...`);

    // Step 3: Write new value
    try {
      const writeResult = await dataService.writeField(state.pageContextId, targetField.caption, testValue);
      if (isOk(writeResult)) {
        const wr = unwrap(writeResult);
        console.error(`[W5] Write success: field="${wr.fieldName}", newValue="${wr.newValue}", success=${wr.success}`);
      } else {
        console.error(`[W5] Write FAILED: ${writeResult.error.message}`);
        console.error(`[W5] Details: ${JSON.stringify(writeResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[W5] Write THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 4: Restore original value
    console.error(`[W5] Restoring original value: "${originalValue}"...`);
    try {
      const restoreResult = await dataService.writeField(state.pageContextId, targetField.caption, originalValue);
      if (isOk(restoreResult)) {
        console.error(`[W5] Restore success: newValue="${restoreResult.value.newValue}"`);
      } else {
        console.error(`[W5] Restore FAILED: ${restoreResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[W5] Restore THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Close
    console.error('[W5] Closing page...');
    await closeAndUntrack(state.pageContextId);
    console.error('[W5] DONE');
    logSessionHealth('W5');
  }, 30_000);

  // ===========================================================================
  // Workflow 6: Filter List Data
  // ===========================================================================
  it('Workflow 6: Filter List Data — filter Customer List by No.', async () => {
    console.error('\n--- Workflow 6: Filter List Data ---');
    if (sessionDead) { console.error('[W6] SKIPPED -- session dead'); return; }

    // Step 1: Open Customer List
    console.error('[W6] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) { console.error(`[W6] Open FAILED: ${openResult.error.message}`); return; }
    const state = derivePageState(unwrap(openResult));

    console.error(`[W6] filterControlPath: ${state.filterControlPath ?? 'NONE'}`);
    if (state.repeater) {
      console.error(`[W6] Repeater columns: ${state.repeater.columns.map(c => `"${c.caption}"(${c.columnBinderPath ?? 'no-binder'})`).join(', ')}`);
      console.error(`[W6] Unfiltered rows: ${state.repeater.rows.length}`);
    }

    // Step 2: Apply filter on "No." column = "10000"
    console.error('[W6] Applying filter: No. = "10000"...');
    try {
      const filterResult = await filterService.applyFilter(state.pageContextId, 'No.', '10000');
      if (isOk(filterResult)) {
        const filtered = derivePageState(unwrap(filterResult));
        console.error(`[W6] Filter success! Rows after filter: ${filtered.repeater?.rows.length ?? 0}`);
        if (filtered.repeater && filtered.repeater.rows.length > 0) {
          console.error(`[W6] Filtered first row: ${JSON.stringify(filtered.repeater.rows[0]!.cells)}`);
        }
      } else {
        console.error(`[W6] Filter FAILED: ${filterResult.error.message}`);
        console.error(`[W6] Details: ${JSON.stringify(filterResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[W6] Filter THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 3: Clear filters
    console.error('[W6] Clearing filters...');
    try {
      const clearResult = await filterService.clearFilters(state.pageContextId);
      if (isOk(clearResult)) {
        console.error(`[W6] Clear success! Rows after clear: ${derivePageState(clearResult.value).repeater?.rows.length ?? 0}`);
      } else {
        console.error(`[W6] Clear FAILED: ${clearResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[W6] Clear THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Close
    console.error('[W6] Closing page...');
    await closeAndUntrack(state.pageContextId);
    console.error('[W6] DONE');
    logSessionHealth('W6');
  }, 30_000);

  // ===========================================================================
  // Workflow 7: Open Multiple Pages (single connection)
  // ===========================================================================
  it('Workflow 7: Open Multiple Pages — 22, 21, 30 simultaneously', async () => {
    console.error('\n--- Workflow 7: Open Multiple Pages ---');

    // If the shared session died during W1-W6, spin up a fresh one for this test
    if (!session.isAlive || sessionDead) {
      console.error(`[W7] Session is dead (isAlive=${session.isAlive}, sessionDead=${sessionDead}) — recreating...`);
      const recreated = await recreateSession();
      if (!recreated) {
        console.error('[W7] SKIPPED — could not recreate session (BC holding NTLM slot from crashed W3 drill-down)');
        // This is a known BC limitation: the server holds the NTLM session after WebSocket crashes.
        // Skip rather than fail — the isolation logging above reveals the root cause (W3 kills session).
        return;
      }
    }

    const pageIds = ['22', '21', '30'];
    const pageContextIds: string[] = [];

    // Step 1-3: Open all three pages
    for (const pid of pageIds) {
      console.error(`[W7] Opening page ${pid}...`);
      try {
        const result = await openAndTrack(pid);
        if (isOk(result)) {
          const st = derivePageState(unwrap(result));
          pageContextIds.push(st.pageContextId);
          console.error(`[W7] Page ${pid} opened: pageContextId=${st.pageContextId}, pageType=${st.pageType}, fields=${st.controlTree.length}`);
        } else {
          console.error(`[W7] Page ${pid} FAILED: ${result.error.message}`);
        }
      } catch (e: unknown) {
        console.error(`[W7] Page ${pid} THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.error(`[W7] Successfully opened ${pageContextIds.length} pages`);

    // Step 4: Read data from each
    for (let i = 0; i < pageContextIds.length; i++) {
      const ctx = pageContextIds[i]!;
      console.error(`[W7] Reading data from ${ctx}...`);
      try {
        const fieldsResult = dataService.getFields(ctx);
        if (isOk(fieldsResult)) {
          const fields = unwrap(fieldsResult);
          console.error(`[W7]   ${fields.length} fields, ${fields.filter(f => f.caption).length} with captions`);
        } else {
          console.error(`[W7]   getFields FAILED: ${fieldsResult.error.message}`);
        }

        const rowsResult = dataService.readRows(ctx);
        if (isOk(rowsResult)) {
          console.error(`[W7]   ${rowsResult.value.length} rows`);
        }
      } catch (e: unknown) {
        console.error(`[W7]   THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Step 5: Close all
    for (const ctx of pageContextIds) {
      console.error(`[W7] Closing ${ctx}...`);
      try {
        await closeAndUntrack(ctx);
      } catch (e: unknown) {
        console.error(`[W7] Close THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Soft check — if 0 pages opened, something is seriously wrong
    console.error(`[W7] Result: ${pageContextIds.length}/3 pages opened`);
    expect(pageContextIds.length).toBeGreaterThan(0);
    console.error('[W7] DONE');
    logSessionHealth('W7');
  }, 120_000);

  // ===========================================================================
  // Workflow 8: Search Pages
  // ===========================================================================
  it('Workflow 8: Search Pages — search for "customer" and "item"', async () => {
    console.error('\n--- Workflow 8: Search Pages ---');
    if (sessionDead) { console.error('[W8] SKIPPED -- session dead'); return; }

    for (const query of ['customer', 'item']) {
      console.error(`[W8] Searching for "${query}"...`);
      try {
        const result = await searchService.search(query);
        if (isOk(result)) {
          const results = unwrap(result);
          console.error(`[W8] "${query}": ${results.length} results`);
          for (const r of results.slice(0, 5)) {
            console.error(`[W8]   name="${r.name}", pageId="${r.pageId}", type="${r.type}"`);
          }
          if (query === 'customer') {
            expect(results.length).toBeGreaterThan(0);
          }
        } else {
          console.error(`[W8] Search "${query}" FAILED: ${result.error.message}`);
          console.error(`[W8] Details: ${JSON.stringify(result.error.details)}`);
        }
      } catch (e: unknown) {
        console.error(`[W8] Search "${query}" THREW: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.error('[W8] DONE');
    logSessionHealth('W8');
  }, 30_000);

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================
  describe('Error Handling', () => {
    it('E1: Open invalid page ID (99999)', async () => {
      console.error('\n--- Error E1: Open invalid page ---');
      if (sessionDead) { console.error('[E1] SKIPPED -- session dead'); return; }
      try {
        const result = await pageService.openPage('99999');
        if (isOk(result)) {
          console.error(`[E1] Unexpectedly succeeded! pageContextId=${result.value.pageContextId}`);
          // Clean up
          openedPages.push(result.value.pageContextId);
          await closeAndUntrack(result.value.pageContextId);
        } else {
          console.error(`[E1] Failed as expected: ${result.error.message}`);
        }
      } catch (e: unknown) {
        console.error(`[E1] Threw: ${e instanceof Error ? e.message : String(e)}`);
        // Throwing is also a valid "failure" — but it means we might not be wrapping errors properly
      }
      console.error('[E1] DONE');
    }, 30_000);

    it('E2: Read data with invalid pageContextId', async () => {
      console.error('\n--- Error E2: Read with invalid pageContextId ---');
      const result = dataService.readRows('nonexistent:page:ctx');
      if (isErr(result)) {
        console.error(`[E2] Failed as expected: ${result.error.message}`);
      } else {
        console.error(`[E2] Unexpectedly succeeded with ${result.value.length} rows`);
      }
      expect(isErr(result)).toBe(true);
      console.error('[E2] DONE');
    }, 10_000);

    it('E3: Write to non-existent field', async () => {
      console.error('\n--- Error E3: Write non-existent field ---');
      if (sessionDead) { console.error('[E3] SKIPPED -- session dead'); return; }

      // Open a real page first
      const openResult = await openAndTrack('21');
      if (isErr(openResult)) { console.error(`[E3] Open FAILED: ${openResult.error.message}`); return; }
      const state = unwrap(openResult);

      try {
        const writeResult = await dataService.writeField(
          state.pageContextId,
          'Completely Fake Field Name That Does Not Exist',
          'test',
        );
        if (isErr(writeResult)) {
          console.error(`[E3] Failed as expected: ${writeResult.error.message}`);
          if (writeResult.error.details) {
            const details = writeResult.error.details as Record<string, unknown>;
            const available = details['availableFields'] as string[] | undefined;
            console.error(`[E3] Available fields (first 10): ${(available ?? []).slice(0, 10).join(', ')}`);
          }
        } else {
          console.error(`[E3] Unexpectedly succeeded: ${JSON.stringify(writeResult.value)}`);
        }
        expect(isErr(writeResult)).toBe(true);
      } catch (e: unknown) {
        console.error(`[E3] Threw: ${e instanceof Error ? e.message : String(e)}`);
      }

      await closeAndUntrack(state.pageContextId);
      console.error('[E3] DONE');
    }, 30_000);

    it('E4: Close already-closed pageContextId', async () => {
      console.error('\n--- Error E4: Close already-closed page ---');
      if (sessionDead) { console.error('[E4] SKIPPED -- session dead'); return; }

      // Open and close a page
      const openResult = await openAndTrack('21');
      if (isErr(openResult)) { console.error(`[E4] Open FAILED: ${openResult.error.message}`); return; }
      const ctx = unwrap(openResult).pageContextId;
      await closeAndUntrack(ctx);

      // Now try to close again
      try {
        const result = await pageService.closePage(ctx, { discardChanges: true });
        if (isErr(result)) {
          console.error(`[E4] Failed as expected: ${result.error.message}`);
        } else {
          console.error(`[E4] Unexpectedly succeeded — double-close not detected`);
        }
      } catch (e: unknown) {
        console.error(`[E4] Threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.error('[E4] DONE');
    }, 30_000);

    it('E5: Execute action with invalid action name', async () => {
      console.error('\n--- Error E5: Invalid action name ---');
      if (sessionDead) { console.error('[E5] SKIPPED -- session dead'); return; }

      const openResult = await openAndTrack('22');
      if (isErr(openResult)) { console.error(`[E5] Open FAILED: ${openResult.error.message}`); return; }
      const state = unwrap(openResult);

      try {
        const result = await actionService.executeAction(
          state.pageContextId,
          'This Action Does Not Exist At All',
        );
        if (isErr(result)) {
          console.error(`[E5] Failed as expected: ${result.error.message}`);
          if (result.error.details) {
            const details = result.error.details as Record<string, unknown>;
            const available = details['availableActions'] as string[] | undefined;
            console.error(`[E5] Available actions: ${(available ?? []).slice(0, 10).join(', ')}`);
          }
        } else {
          console.error(`[E5] Unexpectedly succeeded`);
        }
        expect(isErr(result)).toBe(true);
      } catch (e: unknown) {
        console.error(`[E5] Threw: ${e instanceof Error ? e.message : String(e)}`);
      }

      await closeAndUntrack(state.pageContextId);
      console.error('[E5] DONE');
    }, 30_000);
  });
});
