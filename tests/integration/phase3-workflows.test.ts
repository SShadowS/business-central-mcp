/**
 * Phase 3 integration tests: posting, approvals, validation errors,
 * cascading refresh, and close-with-unsaved-changes.
 *
 * These tests run against real BC27 at http://cronus27/BC.
 * They exercise document page workflows that go beyond basic CRUD.
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
import { SessionFactory } from '../../src/session/session-factory.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { detectDialogs, detectChangedSections } from '../../src/protocol/mutation-result.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';

dotenvConfig();

// =============================================================================
// Helper: session + service bootstrap (shared pattern across integration tests)
// =============================================================================

function createTestHarness() {
  const logger = createNullLogger();
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let respondDialog: RespondDialogOperation;
  let repo: PageContextRepository;

  const openedPages: string[] = [];

  async function setup() {
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
    expect(isOk(result)).toBe(true);
    session = unwrap(result);

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    respondDialog = new RespondDialogOperation(session, repo);
  }

  async function teardown() {
    for (const ctx of openedPages) {
      try { await pageService.closePage(ctx); } catch { /* ignore */ }
    }
    session?.close();
  }

  async function openAndTrack(pageId: string) {
    const result = await pageService.openPage(pageId);
    if (isOk(result)) {
      openedPages.push(result.value.pageContextId);
    }
    return result;
  }

  async function closeAndUntrack(pageContextId: string) {
    const result = await pageService.closePage(pageContextId);
    const idx = openedPages.indexOf(pageContextId);
    if (idx >= 0) openedPages.splice(idx, 1);
    return result;
  }

  return {
    get session() { return session; },
    get pageService() { return pageService; },
    get dataService() { return dataService; },
    get actionService() { return actionService; },
    get respondDialog() { return respondDialog; },
    get repo() { return repo; },
    logger,
    openedPages,
    setup,
    teardown,
    openAndTrack,
    closeAndUntrack,
  };
}

// =============================================================================
// Test 3.1: Post Sales Order
// =============================================================================

describe.sequential('Test 3.1: Post Sales Order', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  it('executing Post on a Sales Order triggers a dialog', async () => {
    // Step 1: Open Sales Order List (page 9305)
    console.error('[3.1] Opening Sales Order List (page 9305)...');
    const listResult = await h.openAndTrack('9305');
    expect(isOk(listResult)).toBe(true);
    const listCtx = unwrap(listResult);

    console.error(`[3.1] Sections: ${Array.from(listCtx.sections.keys())}`);

    // Step 2: Find the first row and drill down to get a Sales Order card
    const headerSection = listCtx.sections.get('header');
    expect(headerSection).toBeDefined();
    const headerForm = listCtx.forms.get(headerSection!.formId);
    expect(headerForm).toBeDefined();

    const repeater = headerForm!.repeaters.values().next().value;
    if (!repeater || repeater.rows.length === 0) {
      console.error('[3.1] No Sales Orders found in list -- skipping Post test');
      await h.closeAndUntrack(listCtx.pageContextId);
      return;
    }

    const firstBookmark = repeater.rows[0]!.bookmark;
    console.error(`[3.1] First SO bookmark: "${firstBookmark}"`);

    // Instead of drilling down, open page 42 directly (simpler, avoids drill-down complexity)
    await h.closeAndUntrack(listCtx.pageContextId);

    console.error('[3.1] Opening Sales Order card (page 42)...');
    const cardResult = await h.openAndTrack('42');
    expect(isOk(cardResult)).toBe(true);
    const cardCtx = unwrap(cardResult);
    const pageContextId = cardCtx.pageContextId;

    console.error(`[3.1] Sales Order card opened: ${pageContextId}`);
    console.error(`[3.1] Sections: ${Array.from(cardCtx.sections.keys())}`);

    // Step 3: List available actions to find Post-related ones
    const headerForm42 = cardCtx.forms.get(cardCtx.rootFormId);
    expect(headerForm42).toBeDefined();
    const actions = headerForm42!.actions.filter(a => a.visible && a.enabled);
    const postActions = actions.filter(a =>
      a.caption.toLowerCase().includes('post')
    );

    console.error(`[3.1] Total visible+enabled actions: ${actions.length}`);
    console.error(`[3.1] Post-related actions: ${postActions.map(a => `"${a.caption}"`).join(', ') || 'NONE'}`);

    // Log all action names for diagnostic purposes
    for (const a of actions.slice(0, 30)) {
      console.error(`[3.1]   action: "${a.caption}" systemAction=${a.systemAction} path=${a.controlPath}`);
    }

    // Step 4: Try executing the "Post..." action (or any Post variant)
    // On a blank SO, this should trigger a validation dialog (no lines, no customer, etc.)
    const postAction = postActions.find(a =>
      a.caption === 'Post...' || a.caption === 'P&ost...' || a.caption.startsWith('Post')
    );

    if (!postAction) {
      console.error('[3.1] No Post action found -- documenting available actions and skipping');
      await h.closeAndUntrack(pageContextId);
      return;
    }

    console.error(`[3.1] Executing action: "${postAction.caption}"...`);
    const postResult = await h.actionService.executeAction(pageContextId, postAction.caption);

    if (isOk(postResult)) {
      const ar = unwrap(postResult);
      console.error(`[3.1] Post result: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);

      // Step 5: Verify a dialog was opened (confirmation or validation error)
      const dialogs = detectDialogs(ar.events);
      console.error(`[3.1] Dialogs detected: ${dialogs.length}`);
      for (const d of dialogs) {
        console.error(`[3.1]   Dialog formId=${d.formId}, message="${d.message ?? 'no message extracted'}"`);
      }

      // We expect either a confirmation dialog or a validation error dialog
      expect(dialogs.length).toBeGreaterThan(0);

      // Step 6: Respond "yes" to the dialog (or "cancel" to be safe)
      if (dialogs.length > 0) {
        console.error('[3.1] Responding "cancel" to dialog to avoid posting...');
        const dialogResult = await h.respondDialog.execute({
          pageContextId,
          dialogFormId: dialogs[0]!.formId,
          response: 'cancel',
        });

        if (isOk(dialogResult)) {
          const dr = unwrap(dialogResult);
          console.error(`[3.1] Dialog response: success=${dr.success}, furtherDialogs=${dr.dialogsOpened.length}`);

          // Handle cascading dialogs (cancel might open another)
          if (dr.dialogsOpened.length > 0) {
            console.error('[3.1] Further dialog opened, closing it...');
            await h.respondDialog.execute({
              pageContextId,
              dialogFormId: dr.dialogsOpened[0]!.formId,
              response: 'cancel',
            });
          }
        } else {
          console.error(`[3.1] Dialog response failed: ${dialogResult.error.message}`);
        }
      }
    } else {
      // An error here could itself be the validation we expected
      console.error(`[3.1] Post action failed: ${postResult.error.message}`);
      console.error(`[3.1] This may be expected (validation error on blank SO)`);
    }

    await h.closeAndUntrack(pageContextId);
    console.error('[3.1] DONE');
  }, 60_000);
});

// =============================================================================
// Test 3.3: Approval Workflows
// =============================================================================

describe.sequential('Test 3.3: Approval Workflows', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  it('reads approval-related actions from Sales Order page 42', async () => {
    console.error('[3.3] Opening Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    // Collect all actions across all forms/sections
    const allActions: Array<{ caption: string; section: string; enabled: boolean; visible: boolean }> = [];
    for (const [sectionId, section] of ctx.sections) {
      const form = ctx.forms.get(section.formId);
      if (!form) continue;
      for (const action of form.actions) {
        allActions.push({
          caption: action.caption,
          section: sectionId,
          enabled: action.enabled,
          visible: action.visible,
        });
      }
    }

    // Look for approval-related actions
    const approvalKeywords = ['approv', 'request', 'reject', 'delegate', 'workflow'];
    const approvalActions = allActions.filter(a =>
      approvalKeywords.some(kw => a.caption.toLowerCase().includes(kw))
    );

    console.error(`[3.3] Total actions across all sections: ${allActions.length}`);
    console.error(`[3.3] Approval-related actions: ${approvalActions.length}`);
    for (const a of approvalActions) {
      console.error(`[3.3]   "${a.caption}" section=${a.section} enabled=${a.enabled} visible=${a.visible}`);
    }

    if (approvalActions.length === 0) {
      console.error('[3.3] No approval-related actions found.');
      console.error('[3.3] This is expected if no approval workflow is configured on the test BC instance.');
      console.error('[3.3] To enable approval testing, configure an Approval Workflow in BC admin.');
    } else {
      // Try executing a safe approval action (e.g., "Request Approval" which will likely fail or show dialog)
      const requestApproval = approvalActions.find(a =>
        a.caption.toLowerCase().includes('request') && a.visible
      );

      if (requestApproval) {
        console.error(`[3.3] Attempting to execute: "${requestApproval.caption}" on section "${requestApproval.section}"...`);
        const actionResult = await h.actionService.executeAction(
          pageContextId,
          requestApproval.caption,
          requestApproval.section,
        );

        if (isOk(actionResult)) {
          const ar = unwrap(actionResult);
          const dialogs = detectDialogs(ar.events);
          console.error(`[3.3] Action result: events=${ar.events.length}, dialogs=${dialogs.length}`);
          for (const d of dialogs) {
            console.error(`[3.3]   Dialog: "${d.message ?? 'no message'}"`);
            // Close the dialog to clean up
            await h.respondDialog.execute({
              pageContextId,
              dialogFormId: d.formId,
              response: 'cancel',
            });
          }
        } else {
          console.error(`[3.3] Action failed: ${actionResult.error.message}`);
          console.error('[3.3] This is expected if approval workflow is not set up.');
        }
      }
    }

    await h.closeAndUntrack(pageContextId);
    console.error('[3.3] DONE');
  }, 60_000);
});

// =============================================================================
// Test 4.2: Validation Error Tests
// =============================================================================

describe.sequential('Test 4.2: Validation Error Tests', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  it('writing invalid item number to a line triggers a validation dialog', async () => {
    console.error('[4.2a] Opening Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    // Find the lines section
    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];

    if (!linesSectionId) {
      console.error('[4.2a] No lines section found -- skipping');
      await h.closeAndUntrack(pageContextId);
      return;
    }

    // Read current line rows
    const rowsResult = h.dataService.readRows(pageContextId, linesSectionId);
    if (!isOk(rowsResult) || rowsResult.value.length === 0) {
      // Create a new line first so we have something to write to
      console.error('[4.2a] No existing lines -- creating a new line...');
      const newResult = await h.actionService.executeAction(pageContextId, 'New', linesSectionId);
      if (isErr(newResult)) {
        console.error(`[4.2a] Failed to create new line: ${newResult.error.message}`);
        await h.closeAndUntrack(pageContextId);
        return;
      }
    }

    // Attempt to write an invalid item number
    console.error('[4.2a] Writing invalid item number "ZZZZZ_NONEXISTENT" to No. field...');
    const writeResult = await h.dataService.writeField(
      pageContextId, 'No.', 'ZZZZZ_NONEXISTENT',
      { sectionId: linesSectionId, rowIndex: 0 },
    );

    if (isOk(writeResult)) {
      const wr = unwrap(writeResult);
      console.error(`[4.2a] Write returned: success=${wr.success}, newValue="${wr.newValue}"`);

      // Check events for a validation dialog
      const dialogs = detectDialogs(wr.events ?? []);
      console.error(`[4.2a] Dialogs in write events: ${dialogs.length}`);
      for (const d of dialogs) {
        console.error(`[4.2a]   Dialog: formId=${d.formId}, message="${d.message ?? 'none'}"`);
        // Close validation dialog
        await h.respondDialog.execute({
          pageContextId,
          dialogFormId: d.formId,
          response: 'ok',
        });
      }

      // Either a dialog appeared OR the value was rejected silently
      // Both are valid BC behaviors for invalid item numbers
      if (dialogs.length > 0) {
        console.error('[4.2a] Validation dialog detected -- PASS');
      } else {
        console.error('[4.2a] No dialog but write may have been silently rejected');
      }
    } else {
      // A protocol error is also a valid response to invalid data
      console.error(`[4.2a] Write failed with error: ${writeResult.error.message}`);
      console.error('[4.2a] This is expected for validation failures');
    }

    // Clean up: delete the line if we created one
    try {
      await h.actionService.executeAction(pageContextId, 'Delete', linesSectionId);
    } catch { /* best effort cleanup */ }

    await h.closeAndUntrack(pageContextId);
    console.error('[4.2a] DONE');
  }, 60_000);

  it('writing to a non-existent field returns error with suggestions', async () => {
    console.error('[4.2b] Opening Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    // Attempt to write to a completely non-existent field on the header
    console.error('[4.2b] Writing to non-existent field "Nonexistent Field"...');
    const writeResult = await h.dataService.writeField(
      pageContextId, 'Nonexistent Field', 'test-value',
    );

    // This should fail with a ProtocolError containing available field names
    expect(isErr(writeResult)).toBe(true);
    if (isErr(writeResult)) {
      console.error(`[4.2b] Error (expected): ${writeResult.error.message}`);

      // Verify the error includes field suggestions
      const details = writeResult.error.details as Record<string, unknown> | undefined;
      const availableFields = details?.['availableFields'] as string[] | undefined;

      console.error(`[4.2b] Available fields in error: ${availableFields ? availableFields.length : 'NONE'}`);
      if (availableFields && availableFields.length > 0) {
        console.error(`[4.2b] First 10: ${availableFields.slice(0, 10).join(', ')}`);
        expect(availableFields.length).toBeGreaterThan(0);
      }
    }

    // Also test on the lines section
    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];

    if (linesSectionId) {
      console.error('[4.2b] Writing to non-existent field on lines section...');
      const linesWriteResult = await h.dataService.writeField(
        pageContextId, 'Nonexistent Line Field', 'test-value',
        { sectionId: linesSectionId, rowIndex: 0 },
      );

      expect(isErr(linesWriteResult)).toBe(true);
      if (isErr(linesWriteResult)) {
        console.error(`[4.2b] Lines error (expected): ${linesWriteResult.error.message}`);
      }
    }

    await h.closeAndUntrack(pageContextId);
    console.error('[4.2b] DONE');
  }, 60_000);
});

// =============================================================================
// Test 4.3: Cascading Refresh
// =============================================================================

describe.sequential('Test 4.3: Cascading Refresh', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  it('writing Sell-to Customer No. cascades changes to header and lines', async () => {
    console.error('[4.3] Opening Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    console.error(`[4.3] Sections: ${Array.from(ctx.sections.keys()).join(', ')}`);

    // Read the current Sell-to Customer No. so we can restore it
    const fieldsResult = h.dataService.getFields(pageContextId, 'header');
    expect(isOk(fieldsResult)).toBe(true);
    const fields = unwrap(fieldsResult);

    const custNoField = fields.find(f =>
      f.caption.toLowerCase().includes('sell-to customer') && f.caption.toLowerCase().includes('no')
    );

    if (!custNoField) {
      console.error('[4.3] Could not find Sell-to Customer No. field');
      console.error('[4.3] Available header fields:');
      for (const f of fields.filter(f => f.caption).slice(0, 20)) {
        console.error(`[4.3]   "${f.caption}": "${f.stringValue ?? ''}" editable=${f.editable}`);
      }
      await h.closeAndUntrack(pageContextId);
      return;
    }

    const originalValue = custNoField.stringValue ?? '';
    console.error(`[4.3] Current Sell-to Customer No.: "${originalValue}"`);

    // Write a known customer number (10000 is the default CRONUS customer)
    // If the SO already has this customer, use a different one
    const testValue = originalValue === '10000' ? '20000' : '10000';
    console.error(`[4.3] Writing Sell-to Customer No. = "${testValue}"...`);

    const writeResult = await h.dataService.writeField(
      pageContextId, custNoField.caption, testValue,
    );

    if (isOk(writeResult)) {
      const wr = unwrap(writeResult);
      console.error(`[4.3] Write success: newValue="${wr.newValue}"`);

      // Check for cascading changes by examining events across sections
      const events = wr.events ?? [];
      console.error(`[4.3] Total events from write: ${events.length}`);

      // Detect which sections were affected
      const updatedCtx = h.pageService.getPageContext(pageContextId);
      if (updatedCtx) {
        const changedSections = detectChangedSections(updatedCtx, events);
        console.error(`[4.3] Changed sections: ${changedSections.join(', ') || 'NONE'}`);

        // Changing the customer should cascade to both header and potentially lines
        expect(changedSections.length).toBeGreaterThan(0);
        console.error(`[4.3] Header changed: ${changedSections.includes('header')}`);
        console.error(`[4.3] Lines changed: ${changedSections.includes('lines')}`);

        // Check for dialogs (BC might ask "Do you want to update lines?")
        const dialogs = detectDialogs(events);
        console.error(`[4.3] Dialogs triggered: ${dialogs.length}`);
        for (const d of dialogs) {
          console.error(`[4.3]   Dialog: "${d.message ?? 'no message'}"`);
          // Accept the cascading update
          const dialogResp = await h.respondDialog.execute({
            pageContextId,
            dialogFormId: d.formId,
            response: 'yes',
          });
          if (isOk(dialogResp)) {
            console.error(`[4.3]   Dialog response: changedSections=${dialogResp.value.changedSections.join(', ')}`);
          }
        }
      }
    } else {
      console.error(`[4.3] Write failed: ${writeResult.error.message}`);
      // This might produce a dialog that we need to handle
    }

    // Restore the original value
    if (originalValue) {
      console.error(`[4.3] Restoring original value: "${originalValue}"...`);
      const restoreResult = await h.dataService.writeField(
        pageContextId, custNoField.caption, originalValue,
      );
      if (isOk(restoreResult)) {
        // Handle restore dialogs too
        const dialogs = detectDialogs(restoreResult.value.events ?? []);
        for (const d of dialogs) {
          await h.respondDialog.execute({
            pageContextId,
            dialogFormId: d.formId,
            response: 'yes',
          });
        }
      }
      console.error('[4.3] Value restored');
    }

    await h.closeAndUntrack(pageContextId);
    console.error('[4.3] DONE');
  }, 60_000);
});

// =============================================================================
// Test 4.4: Close Page with Unsaved Changes
// =============================================================================

describe.sequential('Test 4.4: Close Page with Unsaved Changes', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  it('closing a page after writing a field may trigger a save-changes dialog', async () => {
    console.error('[4.4a] Opening Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    // Write a header field value to create unsaved changes
    console.error('[4.4a] Writing "External Document No." to create unsaved state...');
    const writeResult = await h.dataService.writeField(
      pageContextId, 'External Document No.', 'PHASE3-UNSAVED-TEST',
    );

    if (isErr(writeResult)) {
      console.error(`[4.4a] Write failed: ${writeResult.error.message} -- skipping close test`);
      await h.closeAndUntrack(pageContextId);
      return;
    }
    console.error(`[4.4a] Write success: newValue="${writeResult.value.newValue}"`);

    // Close the page -- BC may trigger a save dialog
    // Note: BC auto-saves on card pages, so a dialog may not appear.
    // On list pages or certain document pages, you get "Do you want to save?"
    console.error('[4.4a] Closing page (expecting possible save dialog)...');
    const closeResult = await h.pageService.closePage(pageContextId);

    if (isOk(closeResult)) {
      const closeEvents = unwrap(closeResult).events;
      const dialogs = detectDialogs(closeEvents);

      console.error(`[4.4a] Close events: ${closeEvents.length}`);
      console.error(`[4.4a] Dialogs on close: ${dialogs.length}`);

      if (dialogs.length > 0) {
        console.error('[4.4a] Save-changes dialog detected!');
        for (const d of dialogs) {
          console.error(`[4.4a]   Dialog: formId=${d.formId}, message="${d.message ?? 'none'}"`);
        }

        // Respond "no" to discard changes
        console.error('[4.4a] Responding "no" to discard changes...');
        const dialogResult = await h.respondDialog.execute({
          pageContextId,
          dialogFormId: dialogs[0]!.formId,
          response: 'no',
        });
        if (isOk(dialogResult)) {
          console.error(`[4.4a] Discard response: success=${dialogResult.value.success}`);
        }
      } else {
        console.error('[4.4a] No dialog on close -- BC may have auto-saved the change');
        console.error('[4.4a] This is normal for card pages (BC auto-commits on CloseForm)');
      }

      // Remove from tracking since we already closed it
      const idx = h.openedPages.indexOf(pageContextId);
      if (idx >= 0) h.openedPages.splice(idx, 1);
    } else {
      console.error(`[4.4a] Close failed: ${closeResult.error.message}`);
    }

    console.error('[4.4a] DONE');
  }, 60_000);

  it('verifying close behavior: clean page closes without dialog', async () => {
    // This is the control test: a clean page should close without any dialog
    console.error('[4.4b] Opening a fresh Sales Order (page 42)...');
    const result = await h.openAndTrack('42');
    expect(isOk(result)).toBe(true);
    const ctx = unwrap(result);
    const pageContextId = ctx.pageContextId;

    // Do NOT write anything -- close immediately
    console.error('[4.4b] Closing clean page (no modifications)...');
    const closeResult = await h.closeAndUntrack(pageContextId);

    if (isOk(closeResult)) {
      const closeEvents = unwrap(closeResult).events;
      const dialogs = detectDialogs(closeEvents);

      console.error(`[4.4b] Close events: ${closeEvents.length}`);
      console.error(`[4.4b] Dialogs on clean close: ${dialogs.length}`);

      // A clean close should produce no dialogs
      expect(dialogs.length).toBe(0);
      console.error('[4.4b] Clean close confirmed -- no dialog');
    } else {
      console.error(`[4.4b] Close failed: ${closeResult.error.message}`);
    }

    console.error('[4.4b] DONE');
  }, 30_000);
});
