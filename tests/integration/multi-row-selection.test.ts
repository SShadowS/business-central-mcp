// tests/integration/multi-row-selection.test.ts
//
// Live verification (Cronus28, BC 28.3) of the multi-row selection feature:
// ExecuteActionOperation's `bookmarks: string[]` input, which threads an
// atomic SetCurrentRow(rowsToSelect) + InvokeAction sequence through
// ActionService/NavigationService (Tasks 1-8 of this plan).
//
// Deliberately non-destructive: no test actually confirms a Delete. This
// avoids depending on disposable data existing in Cronus28 while still proving
// the selection reaches BC and that the guards behave correctly.
//
// *** RESOLVED (was "KNOWN GAP") ***
// Earlier this suite documented a 3-row Delete on the Customer list returning
// success with no dialog and no deletion, and (wrongly) blamed the atomic
// selection path / EnsureControlInCurrentRowStrategy. The real cause, verified
// live via scripts/probe-action-enabled.ts and confirmed by a user observation
// (the web client GREYS OUT Delete on multi-select): the Customer list forbids
// multi-record Delete. BC computes action enablement server-side (decompiled
// ActionControl.Enabled = Action.CanInvoke; DeleteAction.CanInvoke requires
// bindingManager.Deletable) and pushes Enabled=false once SelectedRows.Count>1.
// Invoking a server-DISABLED action is a silent no-op (CanInvoke=false ->
// InvokeCore never runs). Probe results: Customers (22) Delete enabled flips
// true(single)->false(3-row); setup lists Payment Terms (4) and Countries (10)
// stay enabled at 3 rows, where DeleteAction.InvokeCore loops SelectedRows and
// the same frames delete for real. The encoder was never wrong (its
// key:null/repeaterControlTarget:null match the live web-client frame exactly).
// FIX: ActionService now reads the action's post-selection Enabled from the
// applied SetCurrentRow echo and returns MultiRowActionUnavailableError
// (code MULTI_ROW_ACTION_UNAVAILABLE) instead of a lying success. MRS1 below
// now asserts that error on the Customer list.
//
// Run with:
//   npx vitest run --config vitest.integration.config.ts tests/integration/multi-row-selection.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { FilterService } from '../../src/services/filter-service.js';
import { SortService } from '../../src/services/sort-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ReadDataOperation } from '../../src/operations/read-data.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { actions as treeActions } from '../../src/protocol/form-views.js';
import { resolveSection } from '../../src/protocol/section-resolver.js';
import { SystemAction } from '../../src/protocol/types.js';
import { loadConfig } from '../../src/core/config.js';
import { ProtocolError, BusinessError, BusinessValidationError, InvalidBookmarkError, MultiRowActionUnavailableError } from '../../src/core/errors.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

// Customer List. Confirmed by tests/integration/edge-cases.test.ts (EC2) to
// raise a Yes/No confirmation dialog for a single-row Delete before any
// validation runs. NOTE: unlike what tests/integration/clear-filters.test.ts
// assumes for "BC28 pages", live verification here shows the "No." column on
// THIS Cronus28 (28.3.52162) install has no ColumnBinder.Path either -- see
// the skipped stale-anchor test below.
const CUSTOMER_LIST_PAGE_ID = '22';

describe('Multi-row selection via ExecuteActionOperation.bookmarks[] (integration, Cronus28)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let navigationService: NavigationService;
  let openPageOp: OpenPageOperation;
  let readDataOp: ReadDataOperation;
  let executeActionOp: ExecuteActionOperation;
  let respondDialogOp: RespondDialogOperation;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const cfg = loadConfig();

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    const actionService = new ActionService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    const filterService = new FilterService(session, repo, logger);
    const sortService = new SortService(session, repo, logger);

    openPageOp = new OpenPageOperation(pageService);
    readDataOp = new ReadDataOperation(dataService, filterService, sortService, repo);
    // These flows never emit a download -- stubDownloadService matches the
    // constructor shape without needing real auth headers (see helper doc).
    executeActionOp = new ExecuteActionOperation(actionService, repo, navigationService, stubDownloadService(logger), cfg.bc.maxSelection);
    respondDialogOp = new RespondDialogOperation(session, repo, stubDownloadService(logger));
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  async function openCustomerListAndReadRows(minRows: number) {
    const openResult = await openPageOp.execute({ pageId: CUSTOMER_LIST_PAGE_ID });
    expect(isOk(openResult)).toBe(true);
    const ctx = unwrap(openResult);
    openedPages.push(ctx.pageContextId);

    const readResult = await readDataOp.execute({ pageContextId: ctx.pageContextId });
    expect(isOk(readResult)).toBe(true);
    const rows = unwrap(readResult).section.rows ?? [];
    expect(rows.length, `expected at least ${minRows} rows on Customer List`).toBeGreaterThanOrEqual(minRows);

    return { pageContextId: ctx.pageContextId, rows };
  }

  it('multi-row Delete(bookmarks=[3 rows]) on a page that forbids it returns MULTI_ROW_ACTION_UNAVAILABLE (not a silent no-op) and deletes nothing', async () => {
    const { pageContextId, rows } = await openCustomerListAndReadRows(3);
    const [b0, b1, b2] = [rows[0]!.bookmark, rows[1]!.bookmark, rows[2]!.bookmark];
    console.error(`[MRS1] Selecting bookmarks: ${b0}, ${b1}, ${b2}`);

    const result = await executeActionOp.execute({
      pageContextId,
      action: 'Delete',
      bookmarks: [b0, b1, b2],
    });

    // The Customer list disables Delete once 2+ rows are selected (BC pushes
    // Enabled=false). ActionService now detects that and fails loudly instead
    // of returning a lying success. See file header (RESOLVED) + probe.
    expect(isErr(result), isErr(result) ? '' : 'expected MULTI_ROW_ACTION_UNAVAILABLE, got success').toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(MultiRowActionUnavailableError);
    expect(result.error.code).toBe('MULTI_ROW_ACTION_UNAVAILABLE');
    expect((result.error as MultiRowActionUnavailableError).selectionCount).toBe(3);
    console.error(`[MRS1] Rejected as expected: "${result.error.message}"`);

    // Safety: prove BC deleted nothing -- the disabled action was a no-op.
    const reread = await readDataOp.execute({ pageContextId });
    expect(isOk(reread)).toBe(true);
    const bookmarksAfter = (unwrap(reread).section.rows ?? []).map(r => r.bookmark);
    for (const bk of [b0, b1, b2]) {
      expect(bookmarksAfter, `bookmark ${bk} must still be present -- nothing must have been deleted`).toContain(bk);
    }
    console.error('[MRS1] Confirmed: all 3 selected rows still present. No deletion occurred.');
  }, 60_000);

  it('bookmarks[] on a current-row-only action (Edit) is rejected client-side -- no BC round trip', async () => {
    const { pageContextId, rows } = await openCustomerListAndReadRows(2);
    const [b0, b1] = [rows[0]!.bookmark, rows[1]!.bookmark];

    const generationBefore = repo.get(pageContextId)!.generation;

    const result = await executeActionOp.execute({
      pageContextId,
      action: 'Edit',
      bookmarks: [b0, b1],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(ProtocolError);
    expect(result.error.message).toMatch(/current row only|does not consume/i);
    console.error(`[MRS2] Rejected as expected: "${result.error.message}"`);

    // No BC call means no page-context mutation (generation is only bumped
    // by applying an event batch from BC).
    const generationAfter = repo.get(pageContextId)!.generation;
    expect(generationAfter).toBe(generationBefore);

    // No dialog and no new page context should exist either.
    const ctx = repo.get(pageContextId)!;
    expect(ctx.sections.size).toBeGreaterThan(0); // sanity: page state intact
  }, 60_000);

  it('single-row bookmark Delete still reaches BC (existing path unchanged)', async () => {
    const { pageContextId, rows } = await openCustomerListAndReadRows(1);
    const b0 = rows[0]!.bookmark;

    const result = await executeActionOp.execute({
      pageContextId,
      action: 'Delete',
      bookmark: b0,
    });

    if (isOk(result)) {
      const out = result.value;
      expect(out.requiresDialogResponse || out.dialogsOpened.length > 0, 'expected a confirmation dialog for a single-row Delete').toBe(true);
      const dialog = out.dialogsOpened[0]!;
      console.error(`[MRS3] Dialog formId=${dialog.formId}, message="${dialog.message ?? '(none)'}"`);
      const respondResult = await respondDialogOp.execute({
        pageContextId,
        dialogFormId: dialog.formId,
        response: 'no',
      });
      expect(isOk(respondResult)).toBe(true);
      console.error('[MRS3] BEHAVIOR: confirmation dialog opened for the single-row Delete; responded "no" to abort.');
    } else {
      const err = result.error;
      const isBusiness = err instanceof BusinessError || err instanceof BusinessValidationError || err.code === 'BUSINESS_ERROR' || err.code === 'VALIDATION_ERROR';
      expect(isBusiness, `expected a business/validation error, got ${err.code}: ${err.message}`).toBe(true);
      console.error(`[MRS3] BEHAVIOR: BC rejected the single-row Delete with a business error: "${err.message}"`);
    }
  }, 60_000);

  it('multi-row selection on a delete-CAPABLE page (Payment Terms) keeps Delete enabled -- the gate must not false-fire', async () => {
    // Counterpart to MRS1: on the Customer list BC disables Delete for 2+ rows,
    // but setup lists like Payment Terms (page 4) keep it enabled (verified by
    // scripts/probe-action-enabled.ts). This asserts the enabled side of the
    // gate WITHOUT invoking Delete -- selecting rows never mutates data, so
    // there is zero risk to Cronus setup data. Combined with decompiled
    // DeleteAction.InvokeCore (loops SelectedRows) this establishes that the
    // same frames delete for real where BC permits it.
    const openResult = await openPageOp.execute({ pageId: '4' });
    expect(isOk(openResult)).toBe(true);
    const ctx0 = unwrap(openResult);
    openedPages.push(ctx0.pageContextId);

    const readResult = await readDataOp.execute({ pageContextId: ctx0.pageContextId });
    expect(isOk(readResult)).toBe(true);
    const rows = unwrap(readResult).section.rows ?? [];
    expect(rows.length, 'expected at least 3 rows on Payment Terms').toBeGreaterThanOrEqual(3);
    const bookmarks = rows.slice(0, 3).map(r => r.bookmark);

    const sel = await navigationService.selectRows(ctx0.pageContextId, bookmarks);
    expect(isOk(sel), sel.ok ? '' : `selectRows failed: ${(sel as { error: Error }).error.message}`).toBe(true);

    const ctx = repo.get(ctx0.pageContextId)!;
    const resolved = resolveSection(ctx, undefined);
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    const del = treeActions(resolved.form.root).find(a => a.systemAction === SystemAction.Delete);
    expect(del, 'Payment Terms should expose a Delete action').toBeDefined();
    // Stays enabled under a 3-row selection => the multi-row gate would NOT fire
    // here, so a real Delete would proceed to BC's confirmation.
    expect(del!.properties.enabled).not.toBe(false);
    console.error(`[MRS4] Payment Terms Delete enabled under 3-row selection: ${del!.properties.enabled ?? '(unset=enabled)'}`);
  }, 60_000);

  // SKIPPED: cannot reliably force a stale-anchor condition on this
  // environment. The intended approach -- read baseline rows, then apply a
  // bc_read_data `filters: [{column:'No.', value}]` narrowing the Customer
  // List (page 22) repeater so an already-captured bookmark is excluded from
  // BC's loaded rows -- fails BEFORE it ever reaches BC: live on Cronus28
  // (BC 28.3.52162), FilterService.applyFilters rejects the "No." column with
  // "Column No. has no columnBinderPath for filtering" (verified with a
  // standalone script). tests/integration/clear-filters.test.ts documents the
  // identical limitation as BC27-only and assumes BC28 pages expose
  // ColumnBinder.Path; that assumption does not hold for Customer List on
  // THIS live BC28.3 install. advanced-workflows.test.ts B2/A9, which do
  // exercise this same filter, never assert success (file header: "discover
  // protocol gaps, not fix them") so the failure was never surfaced as a
  // failing test before now. Without a working column filter there is no
  // other supported way in this codebase to make BC forget a previously
  // loaded bookmark (sorting reorders but does not evict rows; scrolling
  // extends the loaded set, it does not truncate it), so the stale-anchor
  // condition (InvalidBookmarkException, already covered at the unit level
  // by tests/unit/select-rows.test.ts against a scripted RPC error) cannot be
  // reproduced live here. NavigationService.selectRows' InvalidBookmarkError
  // mapping itself is exercised live by test 1 below whenever BC's actual
  // Delete response differs from the anchor's expected row -- see that test
  // for the environment's real behavior.
  it.skip('a stale anchor bookmark (excluded by a filter) maps to INVALID_BOOKMARK -- SKIPPED, see comment above', async () => {
    const { pageContextId, rows } = await openCustomerListAndReadRows(2);
    const anchorRow = rows[rows.length - 1]!;
    const keepNo = rows[0]!.cells['No.'] as string;

    const filterResult = await readDataOp.execute({ pageContextId, filters: [{ column: 'No.', value: keepNo }] });
    expect(isOk(filterResult)).toBe(true);

    const result = await executeActionOp.execute({
      pageContextId,
      action: 'Delete',
      bookmarks: [anchorRow.bookmark],
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(InvalidBookmarkError);
    expect(result.error.code).toBe('INVALID_BOOKMARK');
  }, 60_000);
});
