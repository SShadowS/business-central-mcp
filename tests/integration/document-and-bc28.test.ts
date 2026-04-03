/**
 * Document page workflows (Sales Order, Purchase Order) and BC28 cross-version tests.
 *
 * Part 1: Document pages have header + subpage (line items) -- structurally different.
 * Part 2: Run key workflows against BC28 to find protocol compatibility gaps.
 *
 * Goal: discover protocol gaps, not fix them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { StateProjection } from '../../src/protocol/state-projection.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { SearchService } from '../../src/services/search-service.js';
import type { BCConfig } from '../../src/core/config.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';

dotenvConfig();

// =============================================================================
// Part 1: Document Page Workflows (BC27)
// =============================================================================

describe('Document Page Workflows (BC27)', () => {
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
      try { await pageService.closePage(pageCtx); } catch { /* ignore */ }
    }
    session?.close();
  });

  function rebuildServices(): void {
    const projection = new StateProjection();
    const repo = new PageContextRepository(projection);
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
    try { session?.close(); } catch { /* ignore */ }

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
    const result = await pageService.closePage(pageContextId);
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

  // ---------------------------------------------------------------------------
  // D1: Open Sales Order List (43) and drill down
  // ---------------------------------------------------------------------------
  it('D1: Open Sales Order List (43) and drill down', async () => {
    console.error('\n--- D1: Sales Order List -> Drill Down ---');
    if (!await ensureSession('D1')) return;

    console.error('[D1] Opening Sales Order List (page 43)...');
    const openResult = await openAndTrack('43');
    if (isErr(openResult)) {
      console.error(`[D1] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = unwrap(openResult);

    console.error(`[D1] pageType=${state.pageType}, formId=${state.formId}`);
    console.error(`[D1] controlTree: ${state.controlTree.length} fields`);
    console.error(`[D1] childForms: ${state.childForms.length}`);
    console.error(`[D1] actions: ${state.actions.length} total, ${state.actions.filter(a => a.visible && a.enabled).length} visible+enabled`);
    console.error(`[D1] filterControlPath: ${state.filterControlPath ?? 'NONE'}`);

    if (state.repeater) {
      console.error(`[D1] Repeater controlPath: "${state.repeater.controlPath}"`);
      console.error(`[D1] Repeater: ${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns`);
      console.error(`[D1] Repeater columns: ${state.repeater.columns.map(c => `"${c.caption}"`).join(', ')}`);
      if (state.repeater.rows.length > 0) {
        console.error(`[D1] First row bookmark: "${state.repeater.rows[0]!.bookmark}"`);
        console.error(`[D1] First row cells (keys): ${Object.keys(state.repeater.rows[0]!.cells).join(', ')}`);

        // Drill down to first Sales Order
        const bookmark = state.repeater.rows[0]!.bookmark;
        console.error(`[D1] Drilling down to first Sales Order...`);
        try {
          const drillResult = await navigationService.drillDown(state.pageContextId, bookmark);
          if (isOk(drillResult)) {
            const { targetPageState } = unwrap(drillResult);
            openedPages.push(targetPageState.pageContextId);
            console.error(`[D1] Drill down SUCCESS! target pageContextId=${targetPageState.pageContextId}`);
            console.error(`[D1] target pageType=${targetPageState.pageType}, formId=${targetPageState.formId}`);
            console.error(`[D1] target fields: ${targetPageState.controlTree.length}`);
            console.error(`[D1] target childForms: ${targetPageState.childForms.length}`);
            console.error(`[D1] target openFormIds: ${targetPageState.openFormIds.length}`);

            // Check key document fields
            const keyFieldNames = ['Sell-to Customer No.', 'Status', 'Order Date', 'No.', 'Sell-to Customer Name'];
            for (const fieldName of keyFieldNames) {
              const fieldResult = dataService.readField(targetPageState.pageContextId, fieldName);
              if (isOk(fieldResult)) {
                const f = unwrap(fieldResult);
                console.error(`[D1]   "${fieldName}": "${f?.stringValue ?? '(empty)'}" [editable=${f?.editable}]`);
              } else {
                console.error(`[D1]   "${fieldName}": FAILED -- ${fieldResult.error.message}`);
              }
            }

            // Log all fields with values for discovery
            const fieldsResult = dataService.getFields(targetPageState.pageContextId);
            if (isOk(fieldsResult)) {
              const fields = unwrap(fieldsResult);
              const withValues = fields.filter(f => f.stringValue);
              console.error(`[D1] Total fields with values: ${withValues.length}`);
              for (const f of withValues.slice(0, 15)) {
                console.error(`[D1]   "${f.caption}": "${f.stringValue}"`);
              }
            }

            // Close drilled-down page
            await closeAndUntrack(targetPageState.pageContextId);
          } else {
            console.error(`[D1] Drill down FAILED: ${drillResult.error.message}`);
            console.error(`[D1] Details: ${JSON.stringify(drillResult.error.details)}`);
          }
        } catch (e: unknown) {
          console.error(`[D1] Drill down THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.error('[D1] No sales orders found in CRONUS -- this is expected if demo data has no orders');
      }
    } else {
      console.error('[D1] No repeater found -- Sales Order List may use a different layout');
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[D1] DONE');
    logHealth('D1');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // D2: Read Sales Order lines (subpage)
  // ---------------------------------------------------------------------------
  it('D2: Read Sales Order lines (subpage / childForms)', async () => {
    console.error('\n--- D2: Sales Order Lines (Subpage) ---');
    if (!await ensureSession('D2')) return;

    // Open Sales Order directly (page 42 = Card/Document)
    console.error('[D2] Opening Sales Order Card (page 42)...');
    const openResult = await openAndTrack('42');
    if (isErr(openResult)) {
      console.error(`[D2] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = unwrap(openResult);

    console.error(`[D2] pageType=${state.pageType}, formId=${state.formId}`);
    console.error(`[D2] controlTree: ${state.controlTree.length} fields`);
    console.error(`[D2] childForms: ${state.childForms.length}`);
    console.error(`[D2] openFormIds: ${state.openFormIds.join(', ')}`);

    // Log child form info
    for (let i = 0; i < state.childForms.length; i++) {
      const cf = state.childForms[i]!;
      console.error(`[D2] childForm[${i}]: formId="${cf.formId}", caption="${cf.caption}"`);
    }

    // Log header fields
    const fieldsResult = dataService.getFields(state.pageContextId);
    if (isOk(fieldsResult)) {
      const fields = unwrap(fieldsResult);
      const withValues = fields.filter(f => f.stringValue);
      console.error(`[D2] Header fields with values: ${withValues.length}`);
      for (const f of withValues.slice(0, 10)) {
        console.error(`[D2]   "${f.caption}": "${f.stringValue}"`);
      }
    }

    // Check if repeater has line data (some document pages embed lines in the repeater)
    if (state.repeater) {
      console.error(`[D2] Repeater present: ${state.repeater.rows.length} rows, ${state.repeater.columns.length} columns`);
      console.error(`[D2] Repeater columns: ${state.repeater.columns.map(c => c.caption).join(', ')}`);
      for (const row of state.repeater.rows.slice(0, 5)) {
        console.error(`[D2]   Line: ${JSON.stringify(row.cells)}`);
      }
    } else {
      console.error('[D2] No repeater on main page -- lines may be in child forms only');
    }

    // Try reading rows (cached data)
    const rowsResult = dataService.readRows(state.pageContextId);
    if (isOk(rowsResult)) {
      console.error(`[D2] readRows returned ${rowsResult.value.length} rows`);
    } else {
      console.error(`[D2] readRows FAILED: ${rowsResult.error.message}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[D2] DONE');
    logHealth('D2');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // D3: Item List (31) -- filter and drill down
  // ---------------------------------------------------------------------------
  it('D3: Item List (31) -- filter and drill down', async () => {
    console.error('\n--- D3: Item List Filter + Drill Down ---');
    if (!await ensureSession('D3')) return;

    console.error('[D3] Opening Item List (page 31)...');
    const openResult = await openAndTrack('31');
    if (isErr(openResult)) {
      console.error(`[D3] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = unwrap(openResult);

    console.error(`[D3] pageType=${state.pageType}, fields=${state.controlTree.length}`);
    if (state.repeater) {
      console.error(`[D3] Unfiltered rows: ${state.repeater.rows.length}`);
      console.error(`[D3] Columns: ${state.repeater.columns.map(c => `"${c.caption}"`).join(', ')}`);
    }

    // Apply filter: No. = "1000..2000"
    console.error('[D3] Applying filter: No. = "1000..2000"...');
    try {
      const filterResult = await filterService.applyFilter(state.pageContextId, 'No.', '1000..2000');
      if (isOk(filterResult)) {
        const filtered = unwrap(filterResult);
        const rowCount = filtered.repeater?.rows.length ?? 0;
        console.error(`[D3] Filter success! Rows after filter: ${rowCount}`);
        if (filtered.repeater && filtered.repeater.rows.length > 0) {
          for (const row of filtered.repeater.rows.slice(0, 5)) {
            console.error(`[D3]   Filtered row: ${JSON.stringify(row.cells)}`);
          }

          // Drill down to first filtered item
          const bookmark = filtered.repeater.rows[0]!.bookmark;
          console.error(`[D3] Drilling down to first filtered item (bookmark="${bookmark}")...`);
          try {
            const drillResult = await navigationService.drillDown(state.pageContextId, bookmark);
            if (isOk(drillResult)) {
              const { targetPageState } = unwrap(drillResult);
              openedPages.push(targetPageState.pageContextId);
              console.error(`[D3] Drill down SUCCESS! pageType=${targetPageState.pageType}`);

              // Read fields from Item Card
              const fieldsResult = dataService.getFields(targetPageState.pageContextId);
              if (isOk(fieldsResult)) {
                const fields = unwrap(fieldsResult);
                const withValues = fields.filter(f => f.stringValue);
                console.error(`[D3] Item Card fields with values: ${withValues.length}`);
                for (const f of withValues.slice(0, 10)) {
                  console.error(`[D3]   "${f.caption}": "${f.stringValue}"`);
                }
              }

              await closeAndUntrack(targetPageState.pageContextId);
            } else {
              console.error(`[D3] Drill down FAILED: ${drillResult.error.message}`);
            }
          } catch (e: unknown) {
            console.error(`[D3] Drill down THREW: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          console.error('[D3] No items in range 1000..2000');
        }
      } else {
        console.error(`[D3] Filter FAILED: ${filterResult.error.message}`);
        console.error(`[D3] Details: ${JSON.stringify(filterResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[D3] Filter THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[D3] DONE');
    logHealth('D3');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // D4: Write on Customer Card from drill-down
  // ---------------------------------------------------------------------------
  it('D4: Write on Customer Card from drill-down', async () => {
    console.error('\n--- D4: Write on Customer Card via Drill-Down ---');
    if (!await ensureSession('D4')) return;

    // Open Customer List
    console.error('[D4] Opening Customer List (page 22)...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[D4] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const listState = unwrap(openResult);

    if (!listState.repeater || listState.repeater.rows.length === 0) {
      console.error('[D4] No customers found -- SKIPPED');
      await closeAndUntrack(listState.pageContextId);
      return;
    }

    const bookmark = listState.repeater.rows[0]!.bookmark;
    console.error(`[D4] First customer bookmark: "${bookmark}"`);
    console.error(`[D4] First customer cells: ${JSON.stringify(listState.repeater.rows[0]!.cells)}`);

    // Drill down
    console.error('[D4] Drilling down to first customer...');
    let cardCtx: string | null = null;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isOk(drillResult)) {
        const { targetPageState } = unwrap(drillResult);
        cardCtx = targetPageState.pageContextId;
        openedPages.push(cardCtx);
        console.error(`[D4] Drill down SUCCESS! pageType=${targetPageState.pageType}`);

        // Read Phone No. field
        const phoneResult = dataService.readField(cardCtx, 'Phone No.');
        let originalValue = '';
        if (isOk(phoneResult)) {
          const f = unwrap(phoneResult);
          originalValue = f?.stringValue ?? '';
          console.error(`[D4] "Phone No." original value: "${originalValue}"`);
        } else {
          console.error(`[D4] readField "Phone No." FAILED: ${phoneResult.error.message}`);
          // Try to find phone field by listing all editable fields
          const fieldsResult = dataService.getFields(cardCtx);
          if (isOk(fieldsResult)) {
            const editable = unwrap(fieldsResult).filter(f => f.editable);
            console.error(`[D4] Editable fields: ${editable.map(f => `"${f.caption}"`).join(', ')}`);
          }
          await closeAndUntrack(cardCtx);
          await closeAndUntrack(listState.pageContextId);
          return;
        }

        // Write new value
        const testValue = 'TEST-555-1234';
        console.error(`[D4] Writing "Phone No." = "${testValue}"...`);
        try {
          const writeResult = await dataService.writeField(cardCtx, 'Phone No.', testValue);
          if (isOk(writeResult)) {
            console.error(`[D4] Write success: newValue="${writeResult.value.newValue}"`);

            // Read back to verify
            const readBackResult = dataService.readField(cardCtx, 'Phone No.');
            if (isOk(readBackResult)) {
              const readBack = unwrap(readBackResult);
              console.error(`[D4] Read back: "${readBack?.stringValue ?? '(empty)'}"`);
              if (readBack?.stringValue === testValue) {
                console.error('[D4] VERIFIED -- write + read-back matches');
              } else {
                console.error(`[D4] MISMATCH -- expected "${testValue}", got "${readBack?.stringValue}"`);
              }
            }
          } else {
            console.error(`[D4] Write FAILED: ${writeResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[D4] Write THREW: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Restore original value
        console.error(`[D4] Restoring "Phone No." = "${originalValue}"...`);
        try {
          const restoreResult = await dataService.writeField(cardCtx, 'Phone No.', originalValue);
          if (isOk(restoreResult)) {
            console.error(`[D4] Restore success: newValue="${restoreResult.value.newValue}"`);
          } else {
            console.error(`[D4] Restore FAILED: ${restoreResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[D4] Restore THREW: ${e instanceof Error ? e.message : String(e)}`);
        }

        await closeAndUntrack(cardCtx);
        cardCtx = null;
      } else {
        console.error(`[D4] Drill down FAILED: ${drillResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[D4] Drill down THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) {
        try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
      }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[D4] DONE');
    logHealth('D4');
  }, 60_000);
});

// =============================================================================
// Part 2: BC28 Cross-Version Tests
// =============================================================================

describe('BC28 Cross-Version Tests', () => {
  const BC28_CONFIG: BCConfig = {
    baseUrl: 'http://cronus28/BC',
    username: 'sshadows',
    password: '1234',
    tenantId: 'default',
    clientVersionString: '28.0.0.0',
    serverMajor: 28,
    timeoutMs: 120000,
  };

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
    const auth = new NTLMAuthProvider({
      baseUrl: BC28_CONFIG.baseUrl,
      username: BC28_CONFIG.username,
      password: BC28_CONFIG.password,
      tenantId: BC28_CONFIG.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, BC28_CONFIG, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(BC28_CONFIG.clientVersionString);
    sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, BC28_CONFIG.tenantId);

    const result = await sessionFactory.create();
    if (isErr(result)) {
      console.error(`[BC28] Session creation FAILED: ${result.error.message}`);
      console.error('[BC28] Is the Cronus28 container running? All BC28 tests will be skipped.');
      // Don't throw -- let individual tests skip gracefully
      sessionDead = true;
      return;
    }
    session = unwrap(result);
    rebuildServices();
    console.error('[BC28] Session created successfully');
  }, 30_000);

  afterAll(async () => {
    for (const pageCtx of openedPages) {
      try { await pageService?.closePage(pageCtx); } catch { /* ignore */ }
    }
    session?.close();
  });

  function rebuildServices(): void {
    const projection = new StateProjection();
    const repo = new PageContextRepository(projection);
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    filterService = new FilterService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    searchService = new SearchService(session, logger);
  }

  async function recreateSession(): Promise<boolean> {
    if (recreationFailed) return false;
    console.error('[BC28][SESSION] Recreating session...');
    try { session?.close(); } catch { /* ignore */ }

    let result = await sessionFactory.create();
    const delays = [2000, 4000, 8000];
    for (let i = 0; isErr(result) && i < delays.length; i++) {
      const delay = delays[i]!;
      console.error(`[BC28][SESSION] Attempt ${i + 1} failed, retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      result = await sessionFactory.create();
    }
    if (isErr(result)) {
      console.error(`[BC28][SESSION] Recreation failed: ${result.error.message}`);
      recreationFailed = true;
      return false;
    }
    session = unwrap(result);
    rebuildServices();
    sessionDead = false;
    console.error('[BC28][SESSION] Recreated successfully');
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
    const result = await pageService.closePage(pageContextId);
    const idx = openedPages.indexOf(pageContextId);
    if (idx >= 0) openedPages.splice(idx, 1);
    return result;
  }

  async function ensureSession(tag: string): Promise<boolean> {
    if (!sessionDead && session?.isAlive) return true;
    console.error(`[BC28][${tag}] Session dead, attempting recreation...`);
    const ok = await recreateSession();
    if (!ok) console.error(`[BC28][${tag}] SKIPPED -- could not recreate session`);
    return ok;
  }

  function logHealth(tag: string): void {
    if (session) {
      console.error(`[BC28][SESSION][${tag}] alive=${session.isAlive}, openForms=${session.openFormIds.size}`);
    }
  }

  // ---------------------------------------------------------------------------
  // B1: BC28 -- Open, drill-down, read fields
  // ---------------------------------------------------------------------------
  it('B1: BC28 -- Open Customer List, drill down, read fields', async () => {
    console.error('\n--- B1: BC28 Open + Drill Down + Read ---');
    if (!await ensureSession('B1')) {
      console.error('[B1] SKIPPED -- no BC28 session');
      return;
    }

    console.error('[B1] Opening Customer List (page 22) on BC28...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[B1] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const listState = unwrap(openResult);

    console.error(`[B1] pageType=${listState.pageType}, fields=${listState.controlTree.length}`);
    console.error(`[B1] childForms: ${listState.childForms.length}`);
    if (listState.repeater) {
      console.error(`[B1] Repeater: ${listState.repeater.rows.length} rows, ${listState.repeater.columns.length} columns`);
    } else {
      console.error('[B1] No repeater!');
    }

    if (!listState.repeater || listState.repeater.rows.length === 0) {
      console.error('[B1] No rows -- cannot drill down. SKIPPED');
      await closeAndUntrack(listState.pageContextId);
      return;
    }

    // Drill down
    const bookmark = listState.repeater.rows[0]!.bookmark;
    console.error(`[B1] Drilling down (bookmark="${bookmark}")...`);
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isOk(drillResult)) {
        const { targetPageState } = unwrap(drillResult);
        openedPages.push(targetPageState.pageContextId);
        console.error(`[B1] Drill down SUCCESS! pageType=${targetPageState.pageType}`);
        console.error(`[B1] target fields: ${targetPageState.controlTree.length}`);

        // Read key fields
        const fieldsResult = dataService.getFields(targetPageState.pageContextId);
        if (isOk(fieldsResult)) {
          const fields = unwrap(fieldsResult);
          const withValues = fields.filter(f => f.stringValue);
          console.error(`[B1] Fields with values: ${withValues.length}`);
          for (const f of withValues.slice(0, 10)) {
            console.error(`[B1]   "${f.caption}": "${f.stringValue}"`);
          }
          expect(withValues.length).toBeGreaterThan(0);
        } else {
          console.error(`[B1] getFields FAILED: ${fieldsResult.error.message}`);
        }

        await closeAndUntrack(targetPageState.pageContextId);
      } else {
        console.error(`[B1] Drill down FAILED: ${drillResult.error.message}`);
        console.error(`[B1] Details: ${JSON.stringify(drillResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[B1] Drill down THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[B1] DONE');
    logHealth('B1');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // B2: BC28 -- Filter
  // ---------------------------------------------------------------------------
  it('B2: BC28 -- Filter Customer List', async () => {
    console.error('\n--- B2: BC28 Filter ---');
    if (!await ensureSession('B2')) {
      console.error('[B2] SKIPPED -- no BC28 session');
      return;
    }

    console.error('[B2] Opening Customer List (page 22) on BC28...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[B2] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = unwrap(openResult);

    console.error(`[B2] filterControlPath: ${state.filterControlPath ?? 'NONE'}`);
    if (state.repeater) {
      console.error(`[B2] Unfiltered rows: ${state.repeater.rows.length}`);
      console.error(`[B2] Columns: ${state.repeater.columns.map(c => `"${c.caption}"(${c.columnBinderPath ?? 'no-binder'})`).join(', ')}`);
    }

    // Apply filter
    console.error('[B2] Applying filter: No. = "10000"...');
    try {
      const filterResult = await filterService.applyFilter(state.pageContextId, 'No.', '10000');
      if (isOk(filterResult)) {
        const filtered = unwrap(filterResult);
        const rowCount = filtered.repeater?.rows.length ?? 0;
        console.error(`[B2] Filter success! Rows after filter: ${rowCount}`);
        if (filtered.repeater && filtered.repeater.rows.length > 0) {
          console.error(`[B2] Filtered row: ${JSON.stringify(filtered.repeater.rows[0]!.cells)}`);
        }
      } else {
        console.error(`[B2] Filter FAILED: ${filterResult.error.message}`);
        console.error(`[B2] Details: ${JSON.stringify(filterResult.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[B2] Filter THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    await closeAndUntrack(state.pageContextId);
    console.error('[B2] DONE');
    logHealth('B2');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // B3: BC28 -- Search
  // ---------------------------------------------------------------------------
  it('B3: BC28 -- Search for "customer"', async () => {
    console.error('\n--- B3: BC28 Search ---');
    if (!await ensureSession('B3')) {
      console.error('[B3] SKIPPED -- no BC28 session');
      return;
    }

    console.error('[B3] Searching for "customer" on BC28...');
    try {
      const result = await searchService.search('customer');
      if (isOk(result)) {
        const results = unwrap(result);
        console.error(`[B3] Search returned ${results.length} results`);
        for (const r of results.slice(0, 10)) {
          console.error(`[B3]   name="${r.name}", pageId="${r.pageId}", type="${r.type}"`);
        }
        expect(results.length).toBeGreaterThan(0);
      } else {
        console.error(`[B3] Search FAILED: ${result.error.message}`);
        console.error(`[B3] Details: ${JSON.stringify(result.error.details)}`);
      }
    } catch (e: unknown) {
      console.error(`[B3] Search THREW: ${e instanceof Error ? e.message : String(e)}`);
    }

    console.error('[B3] DONE');
    logHealth('B3');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // B4: BC28 -- Write + read back
  // ---------------------------------------------------------------------------
  it('B4: BC28 -- Write Phone No. + read back on Customer Card', async () => {
    console.error('\n--- B4: BC28 Write + Read Back ---');
    if (!await ensureSession('B4')) {
      console.error('[B4] SKIPPED -- no BC28 session');
      return;
    }

    // Open Customer List, drill down to first customer
    console.error('[B4] Opening Customer List (page 22) on BC28...');
    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[B4] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const listState = unwrap(openResult);

    if (!listState.repeater || listState.repeater.rows.length === 0) {
      console.error('[B4] No customers -- SKIPPED');
      await closeAndUntrack(listState.pageContextId);
      return;
    }

    const bookmark = listState.repeater.rows[0]!.bookmark;
    console.error(`[B4] Drilling down (bookmark="${bookmark}")...`);

    let cardCtx: string | null = null;
    try {
      const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
      if (isOk(drillResult)) {
        const { targetPageState } = unwrap(drillResult);
        cardCtx = targetPageState.pageContextId;
        openedPages.push(cardCtx);
        console.error(`[B4] Drill down SUCCESS!`);

        // Read Phone No.
        const phoneResult = dataService.readField(cardCtx, 'Phone No.');
        let originalValue = '';
        if (isOk(phoneResult)) {
          const f = unwrap(phoneResult);
          originalValue = f?.stringValue ?? '';
          console.error(`[B4] "Phone No." original: "${originalValue}"`);
        } else {
          console.error(`[B4] readField FAILED: ${phoneResult.error.message}`);
          await closeAndUntrack(cardCtx);
          await closeAndUntrack(listState.pageContextId);
          return;
        }

        // Write
        const testValue = 'BC28-TEST';
        console.error(`[B4] Writing "Phone No." = "${testValue}"...`);
        try {
          const writeResult = await dataService.writeField(cardCtx, 'Phone No.', testValue);
          if (isOk(writeResult)) {
            console.error(`[B4] Write success: newValue="${writeResult.value.newValue}"`);

            // Read back
            const readBackResult = dataService.readField(cardCtx, 'Phone No.');
            if (isOk(readBackResult)) {
              const readBack = unwrap(readBackResult);
              console.error(`[B4] Read back: "${readBack?.stringValue ?? '(empty)'}"`);
              if (readBack?.stringValue === testValue) {
                console.error('[B4] VERIFIED -- write + read-back matches on BC28');
              } else {
                console.error(`[B4] MISMATCH -- expected "${testValue}", got "${readBack?.stringValue}"`);
              }
            }
          } else {
            console.error(`[B4] Write FAILED: ${writeResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[B4] Write THREW: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Restore
        console.error(`[B4] Restoring "Phone No." = "${originalValue}"...`);
        try {
          const restoreResult = await dataService.writeField(cardCtx, 'Phone No.', originalValue);
          if (isOk(restoreResult)) {
            console.error(`[B4] Restore success`);
          } else {
            console.error(`[B4] Restore FAILED: ${restoreResult.error.message}`);
          }
        } catch (e: unknown) {
          console.error(`[B4] Restore THREW: ${e instanceof Error ? e.message : String(e)}`);
        }

        await closeAndUntrack(cardCtx);
        cardCtx = null;
      } else {
        console.error(`[B4] Drill down FAILED: ${drillResult.error.message}`);
      }
    } catch (e: unknown) {
      console.error(`[B4] THREW: ${e instanceof Error ? e.message : String(e)}`);
      if (cardCtx) {
        try { await closeAndUntrack(cardCtx); } catch { /* ignore */ }
      }
    }

    await closeAndUntrack(listState.pageContextId);
    console.error('[B4] DONE');
    logHealth('B4');
  }, 60_000);
});
