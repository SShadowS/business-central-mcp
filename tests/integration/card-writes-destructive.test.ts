/**
 * DESTRUCTIVE integration tests: write-and-restore cases on a real Customer Card.
 *
 * Moved out of the normal tier (advanced-workflows A8, document-and-bc28 D4/B4,
 * edge-cases EC1/EC5/EC2, workflow-smoke W5) because they write the first customer
 * (CRONUS 10000) and rely on a restore. A card saves its dirty record on CloseForm
 * (decompiled SaveOnNavigationPattern.FormClosing -> Save(SaveDraftAction.SaveDirty)),
 * so a skipped or silently ignored restore leaves the test value in the record.
 * Every restore now runs in finally and asserts BC echoed it (helpers/restore.ts).
 *
 * Destructive tier only: run with permission via
 *   npx vitest run --config vitest.destructive.config.ts tests/integration/card-writes-destructive.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { derivePageState } from '../../src/protocol/types.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { restoreField } from './helpers/restore.js';
import { stubDownloadService } from './helpers/download-service.js';

describe('Customer Card writes (DESTRUCTIVE, writes customer 10000)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let navigationService: NavigationService;
  let respondDialog: RespondDialogOperation;
  const logger = createNullLogger();

  const openedPages: string[] = [];
  let sessionDead = false;
  let recreationFailed = false;
  let lease: PooledLease;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    rebuildServices();
  }, 30_000);

  afterAll(async () => {
    for (const pageCtx of openedPages) {
      try { await pageService.closePage(pageCtx, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rebuildServices(): void {
    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
    respondDialog = new RespondDialogOperation(session, repo, stubDownloadService(logger));
  }

  async function recreateSession(): Promise<boolean> {
    if (recreationFailed) {
      console.error('[SESSION] Previous recreation failed, skipping retries');
      return false;
    }
    console.error('[SESSION] Recreating session via pool...');
    try {
      await integrationPool.checkIn(lease, { poisoned: true });
      lease = await integrationPool.checkOut();
      session = lease.session;
      rebuildServices();
      sessionDead = false;
      console.error('[SESSION] Recreated successfully');
      return true;
    } catch (e) {
      console.error(`[SESSION] Recreation failed: ${e instanceof Error ? e.message : String(e)}`);
      recreationFailed = true;
      return false;
    }
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

  // ---------------------------------------------------------------------------
  // A8 (from advanced-workflows): Write + Read Back Verification
  // ---------------------------------------------------------------------------
  it('A8: Write field, read back, verify change, restore', async () => {
    console.error('\n--- A8: Write + Read Back Verification ---');
    if (!await ensureSession('A8')) return;

    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[A8] Open list FAILED: ${listResult.error.message}`);
      expect.fail('Could not open Customer List');
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();
    const bookmark = listState.repeater!.rows[0]!.bookmark;

    const drillResult = await navigationService.drillDown(listState.pageContextId, bookmark);
    if (isErr(drillResult)) {
      console.error(`[A8] Drill-down FAILED: ${drillResult.error.message}`);
      await closeAndUntrack(listState.pageContextId);
      return;
    }
    const cardCtx = unwrap(drillResult).targetPageContext.pageContextId;
    openedPages.push(cardCtx);
    console.error(`[A8] Drilled to card: ${cardCtx}`);

    try {
      const fields = unwrap(dataService.getFields(cardCtx));
      const candidates = ['Fax No.', 'Phone No.', 'E-Mail', 'Home Page'];
      let targetField: { caption: string; stringValue?: string; controlPath: string } | undefined;
      for (const name of candidates) {
        const f = fields.find(f => f.caption?.toLowerCase() === name.toLowerCase() && f.editable);
        if (f) { targetField = f; break; }
      }
      if (!targetField) {
        console.error('[A8] SKIPPED -- no writable field');
        return;
      }

      const originalValue = targetField.stringValue ?? '';
      const testValue = originalValue === 'ADV-TEST-123' ? 'ADV-TEST-456' : 'ADV-TEST-123';
      console.error(`[A8] Target: "${targetField.caption}" = "${originalValue}", writing "${testValue}"`);

      const writeResult = await dataService.writeField(cardCtx, targetField.caption, testValue);
      if (isErr(writeResult)) {
        console.error(`[A8] Write FAILED: ${writeResult.error.message}`);
        return;
      }
      try {
        console.error(`[A8] Write OK: newValue="${writeResult.value.newValue}"`);
        const readBack = dataService.readField(cardCtx, targetField.caption);
        expect(isOk(readBack) && readBack.value?.stringValue).toBe(testValue);
      } finally {
        await restoreField(dataService, cardCtx, targetField.caption, originalValue);
        console.error(`[A8] Restored "${targetField.caption}" = "${originalValue}"`);
      }
    } finally {
      await closeAndUntrack(cardCtx);
      await closeAndUntrack(listState.pageContextId);
      logHealth('A8');
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // D4 / B4 / EC1 (from document-and-bc28, edge-cases): Phone No. round-trip via drill-down
  // ---------------------------------------------------------------------------
  for (const [tag, testValue] of [['D4', 'TEST-555-1234'], ['B4', 'BC28-TEST'], ['EC1', '555-1234-TEST']] as const) {
    it(`${tag}: Write Phone No. + read back on Customer Card via drill-down`, async () => {
      console.error(`\n--- ${tag}: Write + Read Back Phone No. ---`);
      if (!await ensureSession(tag)) return;

      const openResult = await openAndTrack('22');
      if (isErr(openResult)) {
        console.error(`[${tag}] Open FAILED: ${openResult.error.message}`);
        return;
      }
      const listState = derivePageState(unwrap(openResult));
      if (!listState.repeater || listState.repeater.rows.length === 0) {
        console.error(`[${tag}] No customers -- SKIPPED`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }

      const drillResult = await navigationService.drillDown(listState.pageContextId, listState.repeater.rows[0]!.bookmark);
      if (isErr(drillResult)) {
        console.error(`[${tag}] Drill down FAILED: ${drillResult.error.message}`);
        await closeAndUntrack(listState.pageContextId);
        return;
      }
      const cardCtx = unwrap(drillResult).targetPageContext.pageContextId;
      openedPages.push(cardCtx);

      try {
        const phone = unwrap(dataService.readField(cardCtx, 'Phone No.'));
        const originalValue = phone?.stringValue ?? '';
        console.error(`[${tag}] "Phone No." original: "${originalValue}"`);

        const writeResult = await dataService.writeField(cardCtx, 'Phone No.', testValue);
        if (isErr(writeResult)) {
          console.error(`[${tag}] Write FAILED: ${writeResult.error.message}`);
          return;
        }
        try {
          const readBack = unwrap(dataService.readField(cardCtx, 'Phone No.'));
          console.error(`[${tag}] Read back: "${readBack?.stringValue ?? '(empty)'}" (wrote "${testValue}")`);
        } finally {
          await restoreField(dataService, cardCtx, 'Phone No.', originalValue);
          console.error(`[${tag}] Restored "Phone No." = "${originalValue}"`);
        }
      } finally {
        await closeAndUntrack(cardCtx);
        await closeAndUntrack(listState.pageContextId);
        logHealth(tag);
      }
    }, 60_000);
  }

  // ---------------------------------------------------------------------------
  // EC5 (from edge-cases): write boolean, date, option fields
  // ---------------------------------------------------------------------------
  it('EC5: Field types -- attempt writing boolean, date, option fields', async () => {
    console.error('\n--- EC5: Field Types ---');
    if (!await ensureSession('EC5')) return;

    const listResult = await openAndTrack('22');
    if (isErr(listResult)) {
      console.error(`[EC5] Open list FAILED: ${listResult.error.message}`);
      return;
    }
    const listState = derivePageState(unwrap(listResult));
    expect(listState.repeater).toBeTruthy();

    const drillResult = await navigationService.drillDown(listState.pageContextId, listState.repeater!.rows[0]!.bookmark);
    if (isErr(drillResult)) {
      console.error(`[EC5] Drill-down FAILED: ${drillResult.error.message}`);
      await closeAndUntrack(listState.pageContextId);
      return;
    }
    const cardCtx = unwrap(drillResult).targetPageContext.pageContextId;
    openedPages.push(cardCtx);

    /** Write `value`, then restore `original` in finally (always, blank included). */
    async function writeAndRestore(kind: string, caption: string, value: string, original: string): Promise<void> {
      console.error(`[EC5] ${kind}: Trying "${caption}" = "${value}" (was "${original}")`);
      const r = await dataService.writeField(cardCtx, caption, value);
      if (isErr(r)) {
        console.error(`[EC5] ${kind} write FAILED: ${r.error.message}`);
        return;
      }
      try {
        console.error(`[EC5] ${kind} write OK: newValue="${r.value.newValue}"`);
      } finally {
        await restoreField(dataService, cardCtx, caption, original);
        console.error(`[EC5] ${kind} restored`);
      }
    }

    try {
      const fields = unwrap(dataService.getFields(cardCtx));
      const editableFields = fields.filter(f => f.editable && f.caption);
      console.error(`[EC5] Editable fields (${editableFields.length})`);

      const booleanField = editableFields.find(f =>
        f.type.toLowerCase().includes('bool') || f.type.toLowerCase().includes('check'),
      );
      if (booleanField) {
        const originalBool = booleanField.stringValue ?? '';
        await writeAndRestore('BOOLEAN', booleanField.caption, originalBool === 'true' ? 'false' : 'true', originalBool);
      } else {
        console.error('[EC5] No boolean/checkbox field found among editable fields');
      }

      const dateField = editableFields.find(f => f.type.toLowerCase().includes('date'));
      if (dateField) {
        await writeAndRestore('DATE', dateField.caption, '01/15/2025', dateField.stringValue ?? '');
      } else {
        console.error('[EC5] No date field found among editable fields');
      }

      const optionField = editableFields.find(f =>
        f.type.toLowerCase().includes('option') ||
        f.type.toLowerCase().includes('enum') ||
        f.type.toLowerCase().includes('select'),
      );
      if (optionField) {
        await writeAndRestore('OPTION', optionField.caption, '1', optionField.stringValue ?? '');
      } else {
        console.error('[EC5] No option/enum field found among editable fields');
      }
    } finally {
      await closeAndUntrack(cardCtx);
      await closeAndUntrack(listState.pageContextId);
      logHealth('EC5');
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // W5 (from workflow-smoke): write then restore on Customer Card opened directly
  // ---------------------------------------------------------------------------
  it('Workflow 5: Write Field -- write then restore on Customer Card', async () => {
    console.error('\n--- Workflow 5: Write Field ---');
    if (!await ensureSession('W5')) return;

    const openResult = await openAndTrack('21');
    if (isErr(openResult)) { console.error(`[W5] Open FAILED: ${openResult.error.message}`); return; }
    const state = derivePageState(unwrap(openResult));

    try {
      const fields = unwrap(dataService.getFields(state.pageContextId));
      const candidateNames = ['Phone No.', 'E-Mail', 'Fax No.', 'Home Page'];
      let targetField: { caption: string; stringValue?: string; controlPath: string } | undefined;
      for (const name of candidateNames) {
        const f = fields.find(f => f.caption.toLowerCase() === name.toLowerCase() && f.editable);
        if (f) { targetField = f; break; }
      }
      if (!targetField) {
        console.error('[W5] SKIPPED -- no suitable editable field');
        return;
      }

      const originalValue = targetField.stringValue ?? '';
      const testValue = originalValue === 'SMOKE-TEST' ? 'SMOKE-TEST-2' : 'SMOKE-TEST';
      console.error(`[W5] Target field: "${targetField.caption}" = "${originalValue}", writing "${testValue}"`);

      const writeResult = await dataService.writeField(state.pageContextId, targetField.caption, testValue);
      if (isErr(writeResult)) {
        console.error(`[W5] Write FAILED: ${writeResult.error.message}`);
        return;
      }
      try {
        const wr = unwrap(writeResult);
        console.error(`[W5] Write success: field="${wr.fieldName}", newValue="${wr.newValue}", success=${wr.success}`);
      } finally {
        await restoreField(dataService, state.pageContextId, targetField.caption, originalValue);
        console.error(`[W5] Restored "${targetField.caption}" = "${originalValue}"`);
      }
    } finally {
      await closeAndUntrack(state.pageContextId);
      logHealth('W5');
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // EC2 (from edge-cases): Delete on a real customer, then decline the confirmation.
  // Destructive tier: if the confirm is not declined, BC deletes the record.
  // ---------------------------------------------------------------------------
  it('EC2: Execute Delete action then decline the confirmation dialog', async () => {
    console.error('\n--- EC2: Delete + decline confirmation ---');
    if (!await ensureSession('EC2')) return;

    const openResult = await openAndTrack('22');
    if (isErr(openResult)) {
      console.error(`[EC2] Open FAILED: ${openResult.error.message}`);
      return;
    }
    const state = derivePageState(unwrap(openResult));
    expect(state.repeater).toBeTruthy();
    const rowCountBefore = state.repeater!.rows.length;

    try {
      unwrap(await navigationService.selectRow(state.pageContextId, state.repeater!.rows[0]!.bookmark));

      const ar = unwrap(await actionService.executeSystemAction(state.pageContextId, SystemAction.Delete));
      console.error(`[EC2] Delete action returned: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);
      expect(ar.dialog, 'Delete must ask for confirmation before deleting').toBeDefined();

      // Answer the CONFIRM dialog itself. The old case sent SystemAction.No against the
      // list page's pageContextId, i.e. not at the dialog form.
      const no = await respondDialog.execute({ pageContextId: state.pageContextId, dialogFormId: ar.dialog!.formId, response: 'no' });
      expect(isOk(no), isOk(no) ? '' : `declining the Delete confirm failed: ${no.error.message}`).toBe(true);

      const rowCountAfter = unwrap(dataService.readRows(state.pageContextId)).length;
      console.error(`[EC2] Rows after: ${rowCountAfter} (was ${rowCountBefore})`);
      expect(rowCountAfter).toBe(rowCountBefore);
    } finally {
      await closeAndUntrack(state.pageContextId);
      logHealth('EC2');
    }
  }, 60_000);
});
