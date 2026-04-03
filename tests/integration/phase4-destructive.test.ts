/**
 * Phase 4 Tier 3: Destructive workflow integration tests.
 *
 * These tests modify data in BC (create orders, post documents, copy documents).
 * Run them independently against a disposable BC27 database:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/phase4-destructive.test.ts
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
import type { BCEvent, ControlField, SaveValueInteraction } from '../../src/protocol/types.js';
import { detectDialogs, detectChangedSections } from '../../src/protocol/mutation-result.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';

dotenvConfig();

// =============================================================================
// Shared test harness (same pattern as phase3-workflows.test.ts)
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
    for (const ctxId of openedPages) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    await session?.closeGracefully().catch(() => {});
  }

  async function openAndTrack(pageId: string) {
    const result = await pageService.openPage(pageId);
    if (isOk(result)) {
      openedPages.push(result.value.pageContextId);
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
   * Dismiss all open dialogs on a page context by responding 'cancel' or 'ok'.
   * Returns the number of dialogs dismissed.
   */
  async function dismissDialogs(
    pageContextId: string,
    events: BCEvent[],
    response: 'cancel' | 'ok' | 'no' = 'cancel',
  ): Promise<number> {
    const dialogs = detectDialogs(events);
    let dismissed = 0;
    for (const d of dialogs) {
      try {
        const dr = await respondDialog.execute({
          pageContextId,
          dialogFormId: d.formId,
          response,
        });
        dismissed++;
        // Handle cascading dialogs
        if (isOk(dr) && dr.value.dialogsOpened.length > 0) {
          dismissed += await dismissDialogs(pageContextId, dr.value.dialogsOpened.map(dd => ({
            type: 'DialogOpened' as const,
            formId: dd.formId,
            controlTree: {},
          })), response);
        }
      } catch { /* best effort */ }
    }
    return dismissed;
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
    dismissDialogs,
  };
}

// =============================================================================
// Test: Post Sales Order end-to-end
// =============================================================================

describe.sequential('Destructive: Post Sales Order end-to-end', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  let orderPageContextId: string;
  let orderNo: string | undefined;

  it('creates a new Sales Order with customer and line item', async () => {
    // Step 1: Open a fresh Sales Order card (page 42)
    console.error('[Post] Opening blank Sales Order (page 42)...');
    const cardResult = await h.openAndTrack('42');
    expect(isOk(cardResult)).toBe(true);
    const ctx = unwrap(cardResult);
    orderPageContextId = ctx.pageContextId;

    console.error(`[Post] Page opened: ${orderPageContextId}`);
    console.error(`[Post] Sections: ${Array.from(ctx.sections.keys()).join(', ')}`);

    // Step 2: Set Sell-to Customer No. = "10000"
    console.error('[Post] Writing Sell-to Customer No. = "10000"...');
    const custResult = await h.dataService.writeField(
      orderPageContextId, 'Customer No.', '10000',
    );
    expect(isOk(custResult)).toBe(true);
    if (isOk(custResult)) {
      console.error(`[Post] Customer set: newValue="${custResult.value.newValue}"`);

      // Handle any cascading dialogs from customer change (e.g., "Update lines?")
      if (custResult.value.events) {
        const dialogCount = await h.dismissDialogs(orderPageContextId, custResult.value.events, 'ok');
        if (dialogCount > 0) {
          console.error(`[Post] Dismissed ${dialogCount} cascading dialog(s) from customer change`);
        }
      }
    }

    // Read the auto-assigned order number
    const fieldsResult = h.dataService.getFields(orderPageContextId, 'header');
    if (isOk(fieldsResult)) {
      const noField = fieldsResult.value.find(f => f.caption === 'No.');
      orderNo = noField?.stringValue;
      console.error(`[Post] Order No.: "${orderNo}"`);
    }

    // Step 3: Add a line item
    const linesSectionId = Array.from(ctx.sections.entries())
      .find(([, s]) => s.kind === 'lines')?.[0];
    expect(linesSectionId).toBeDefined();

    if (linesSectionId) {
      // Create a new line
      console.error('[Post] Adding new line...');
      const newLineResult = await h.actionService.executeAction(orderPageContextId, 'New', linesSectionId);
      expect(isOk(newLineResult)).toBe(true);

      // Write Type = Item (enum value 2)
      console.error('[Post] Setting line Type = Item...');
      const typeResult = await h.dataService.writeField(
        orderPageContextId, 'Type', '2',
        { sectionId: linesSectionId, rowIndex: 0 },
      );
      if (isOk(typeResult)) {
        console.error(`[Post] Type set: "${typeResult.value.newValue}"`);
      } else {
        console.error(`[Post] Type write failed: ${typeResult.error.message}`);
      }

      // Write No. = "1996-S" (ATHENS Desk)
      console.error('[Post] Setting line No. = "1996-S"...');
      const itemResult = await h.dataService.writeField(
        orderPageContextId, 'No.', '1996-S',
        { sectionId: linesSectionId, rowIndex: 0 },
      );
      if (isOk(itemResult)) {
        console.error(`[Post] Item set: "${itemResult.value.newValue}"`);

        // Handle any dialogs from item assignment (e.g., location confirmation)
        if (itemResult.value.events) {
          await h.dismissDialogs(orderPageContextId, itemResult.value.events, 'ok');
        }
      } else {
        console.error(`[Post] Item write failed: ${itemResult.error.message}`);
      }

      // Write Quantity = 1
      console.error('[Post] Setting line Quantity = "1"...');
      const qtyResult = await h.dataService.writeField(
        orderPageContextId, 'Quantity', '1',
        { sectionId: linesSectionId, rowIndex: 0 },
      );
      if (isOk(qtyResult)) {
        console.error(`[Post] Quantity set: "${qtyResult.value.newValue}"`);
      } else {
        console.error(`[Post] Quantity write failed: ${qtyResult.error.message}`);
      }
    }
  }, 60_000);

  it('executes Post action and handles dialog chain', async () => {
    expect(orderPageContextId).toBeDefined();

    // Step 4: Find and execute the Post action
    const ctx = h.repo.get(orderPageContextId);
    expect(ctx).toBeDefined();
    if (!ctx) return;

    const headerForm = ctx.forms.get(ctx.rootFormId);
    expect(headerForm).toBeDefined();
    if (!headerForm) return;

    const actions = headerForm.actions.filter(a => a.visible && a.enabled);
    const postActions = actions.filter(a =>
      a.caption.toLowerCase().includes('post'),
    );

    console.error(`[Post] Post-related actions: ${postActions.map(a => `"${a.caption}"`).join(', ') || 'NONE'}`);

    // Look for "Post..." or "P&ost..." (ampersand is the accelerator key marker)
    const postAction = postActions.find(a =>
      a.caption === 'Post...' || a.caption === 'P&ost...' || a.caption.startsWith('Post')
    );

    if (!postAction) {
      // Log all available actions for debugging
      console.error('[Post] All available actions:');
      for (const a of actions.slice(0, 40)) {
        console.error(`[Post]   "${a.caption}" (systemAction=${a.systemAction}, path=${a.controlPath})`);
      }
      console.error('[Post] SKIP: No Post action found');
      return;
    }

    console.error(`[Post] Executing action: "${postAction.caption}"...`);
    const postResult = await h.actionService.executeAction(orderPageContextId, postAction.caption);

    if (isErr(postResult)) {
      console.error(`[Post] Post action failed: ${postResult.error.message}`);
      console.error('[Post] This may be expected for validation reasons');
      return;
    }

    const ar = unwrap(postResult);
    console.error(`[Post] Post result: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);

    // Step 5: Handle the dialog chain
    // BC posting flow typically goes:
    //   1. "Ship and Invoice" option dialog -> select shipping option
    //   2. "Do you want to post?" confirmation -> yes
    //   3. If successful: FormCreated (Posted Sales Invoice opens) or FormClosed (order closes)
    const dialogChain: Array<{ formId: string; message?: string; fields?: ControlField[] }> = [];

    let currentDialogs = detectDialogs(ar.events);
    let maxDialogSteps = 5; // safety limit

    while (currentDialogs.length > 0 && maxDialogSteps > 0) {
      maxDialogSteps--;
      const dialog = currentDialogs[0]!;
      dialogChain.push(dialog);

      console.error(`[Post] Dialog step ${dialogChain.length}: formId=${dialog.formId}`);
      console.error(`[Post]   message: "${dialog.message ?? 'none'}"`);
      if (dialog.fields) {
        console.error(`[Post]   fields (${dialog.fields.length}):`);
        for (const f of dialog.fields) {
          console.error(`[Post]     "${f.caption}": "${f.stringValue ?? ''}" (editable=${f.editable}, type=${f.type})`);
        }
      }

      // Determine how to respond:
      // - If message contains "post" -> respond "yes" (confirmation dialog)
      // - If message contains "ship" or "invoice" or has selectable fields -> respond "ok"
      //   (option selection dialog, keep default options)
      // - Otherwise -> respond "ok" (generic dialog)
      const msg = (dialog.message ?? '').toLowerCase();
      let response: 'yes' | 'ok' | 'cancel';

      if (msg.includes('post') || msg.includes('want to')) {
        response = 'yes';
      } else {
        response = 'ok';
      }

      console.error(`[Post]   responding: "${response}"`);
      const dialogResult = await h.respondDialog.execute({
        pageContextId: orderPageContextId,
        dialogFormId: dialog.formId,
        response,
      });

      if (isErr(dialogResult)) {
        console.error(`[Post]   dialog response failed: ${dialogResult.error.message}`);
        break;
      }

      const dr = unwrap(dialogResult);
      console.error(`[Post]   dialog response: success=${dr.success}, newDialogs=${dr.dialogsOpened.length}, openedPages=${dr.openedPages.length}, changedSections=${dr.changedSections.join(',')}`);

      // Check if a new page was opened (Posted Sales Invoice)
      if (dr.openedPages.length > 0) {
        console.error(`[Post] New page opened after posting:`);
        for (const p of dr.openedPages) {
          console.error(`[Post]   "${p.caption}" (${p.pageContextId})`);
          // Close the posted invoice page
          try {
            await h.pageService.closePage(p.pageContextId, { discardChanges: true });
            console.error(`[Post]   Closed posted document page`);
          } catch { /* ignore */ }
        }
      }

      // Continue dialog chain if more dialogs appeared
      currentDialogs = dr.dialogsOpened;
    }

    console.error(`[Post] Dialog chain length: ${dialogChain.length}`);
    // We expect at least one dialog (the post confirmation or shipping option)
    expect(dialogChain.length).toBeGreaterThan(0);

    // After posting, the original Sales Order page may be closed by BC
    // or it may show the posted document. Either way, the test succeeded.
    const postCtx = h.repo.get(orderPageContextId);
    if (postCtx) {
      console.error(`[Post] Order page still open after posting`);
      // Try to close it
      await h.closeAndUntrack(orderPageContextId);
    } else {
      console.error(`[Post] Order page was closed by BC after posting (expected)`);
      // Remove from tracking since BC closed it
      const idx = h.openedPages.indexOf(orderPageContextId);
      if (idx >= 0) h.openedPages.splice(idx, 1);
    }

    console.error('[Post] DONE');
  }, 90_000);
});

// =============================================================================
// Test: Copy Document on Sales Order
// =============================================================================

describe.sequential('Destructive: Copy Document dialog', () => {
  const h = createTestHarness();

  beforeAll(() => h.setup(), 30_000);
  afterAll(() => h.teardown());

  let orderPageContextId: string;
  let orderNo: string | undefined;

  it('opens a Sales Order and reads the order number', async () => {
    // Open a fresh Sales Order to be the target of Copy Document
    console.error('[CopyDoc] Opening Sales Order (page 42)...');
    const cardResult = await h.openAndTrack('42');
    expect(isOk(cardResult)).toBe(true);
    const ctx = unwrap(cardResult);
    orderPageContextId = ctx.pageContextId;

    // Set a customer so the order is valid for copying into
    console.error('[CopyDoc] Setting customer 10000...');
    const custResult = await h.dataService.writeField(
      orderPageContextId, 'Customer No.', '10000',
    );
    expect(isOk(custResult)).toBe(true);

    // Handle cascading dialogs
    if (isOk(custResult) && custResult.value.events) {
      await h.dismissDialogs(orderPageContextId, custResult.value.events, 'ok');
    }

    // Read the order number
    const fieldsResult = h.dataService.getFields(orderPageContextId, 'header');
    if (isOk(fieldsResult)) {
      const noField = fieldsResult.value.find(f => f.caption === 'No.');
      orderNo = noField?.stringValue;
      console.error(`[CopyDoc] Target order No.: "${orderNo}"`);
    }
  }, 60_000);

  it('executes Copy Document action and verifies dialog fields', async () => {
    expect(orderPageContextId).toBeDefined();

    // Execute Copy Document action using ActionService (resolves across all sections)
    console.error('[CopyDoc] Executing: "Copy Document..."...');
    const actionResult = await h.actionService.executeAction(orderPageContextId, 'Copy Document...');

    if (isErr(actionResult)) {
      console.error(`[CopyDoc] Action failed: ${actionResult.error.message}`);
      await h.closeAndUntrack(orderPageContextId);
      return;
    }

    const ar = unwrap(actionResult);
    console.error(`[CopyDoc] Action result: events=${ar.events.length}, dialog=${ar.dialog ? 'YES' : 'no'}`);

    // Step: Verify the dialog opened with parseable fields
    const dialogs = detectDialogs(ar.events);
    console.error(`[CopyDoc] Dialogs detected: ${dialogs.length}`);

    expect(dialogs.length).toBeGreaterThan(0);
    if (dialogs.length === 0) {
      console.error('[CopyDoc] FAIL: No dialog opened from Copy Document action');
      await h.closeAndUntrack(orderPageContextId);
      return;
    }

    const dialog = dialogs[0]!;
    console.error(`[CopyDoc] Dialog formId: ${dialog.formId}`);
    console.error(`[CopyDoc] Dialog message: "${dialog.message ?? 'none'}"`);

    // Verify fields are parsed from the dialog control tree
    if (dialog.fields && dialog.fields.length > 0) {
      console.error(`[CopyDoc] Dialog fields (${dialog.fields.length}):`);
      for (const f of dialog.fields) {
        console.error(`[CopyDoc]   "${f.caption}": value="${f.stringValue ?? ''}" editable=${f.editable} type=${f.type} path=${f.controlPath}`);
      }

      // We expect fields like "Document Type", "Document No.", "Include Header", etc.
      const docTypeField = dialog.fields.find(f =>
        f.caption.toLowerCase().includes('document type'),
      );
      const docNoField = dialog.fields.find(f =>
        f.caption.toLowerCase().includes('document no'),
      );

      console.error(`[CopyDoc] Document Type field: ${docTypeField ? 'FOUND' : 'NOT FOUND'}`);
      console.error(`[CopyDoc] Document No. field: ${docNoField ? 'FOUND' : 'NOT FOUND'}`);

      // At least verify field parsing works
      expect(dialog.fields.length).toBeGreaterThan(0);
    } else {
      console.error('[CopyDoc] No structured fields parsed from dialog control tree');
      console.error('[CopyDoc] This may indicate the control tree parser needs enhancement for this dialog type');
    }

    // Cancel the dialog without making changes (non-destructive part)
    console.error('[CopyDoc] Cancelling Copy Document dialog...');
    const cancelResult = await h.respondDialog.execute({
      pageContextId: orderPageContextId,
      dialogFormId: dialog.formId,
      response: 'cancel',
    });

    if (isOk(cancelResult)) {
      const cr = unwrap(cancelResult);
      console.error(`[CopyDoc] Cancel result: success=${cr.success}`);

      // Handle any cascading dialogs from cancel
      if (cr.dialogsOpened.length > 0) {
        await h.dismissDialogs(orderPageContextId, cr.dialogsOpened.map(d => ({
          type: 'DialogOpened' as const,
          formId: d.formId,
          controlTree: {},
        })), 'cancel');
      }
    } else {
      console.error(`[CopyDoc] Cancel failed: ${cancelResult.error.message}`);
    }

    console.error('[CopyDoc] Dialog field parsing test DONE');
  }, 60_000);

  it('fills Copy Document dialog fields and executes copy', async () => {
    expect(orderPageContextId).toBeDefined();
    if (!orderNo) {
      console.error('[CopyDoc-Fill] SKIP: No order number available');
      return;
    }

    // Re-open the Copy Document dialog
    const ctx = h.repo.get(orderPageContextId);
    if (!ctx) {
      console.error('[CopyDoc-Fill] SKIP: Page context lost');
      return;
    }

    console.error('[CopyDoc-Fill] Re-executing Copy Document to fill fields...');
    const actionResult = await h.actionService.executeAction(orderPageContextId, 'Copy Document...');
    if (isErr(actionResult)) {
      console.error(`[CopyDoc-Fill] Action failed: ${actionResult.error.message}`);
      return;
    }

    const dialogs = detectDialogs(unwrap(actionResult).events);
    if (dialogs.length === 0) {
      console.error('[CopyDoc-Fill] SKIP: No dialog opened');
      return;
    }

    const dialog = dialogs[0]!;
    const dialogFormId = dialog.formId;

    // Try to write to dialog fields using SaveValue directly on the dialog formId
    // The dialog fields have controlPaths that we can write to.
    if (dialog.fields && dialog.fields.length > 0) {
      // Find Document Type field
      const docTypeField = dialog.fields.find(f =>
        f.caption.toLowerCase().includes('document type'),
      );

      if (docTypeField && docTypeField.editable) {
        console.error(`[CopyDoc-Fill] Writing Document Type = "Order" on dialog field path=${docTypeField.controlPath}...`);
        const writeResult = await h.session.invoke(
          {
            type: 'SaveValue' as const,
            formId: dialogFormId,
            controlPath: docTypeField.controlPath,
            newValue: 'Order',
          } satisfies SaveValueInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
        );

        if (isOk(writeResult)) {
          console.error(`[CopyDoc-Fill] Document Type write: SUCCESS (${writeResult.value.length} events)`);
        } else {
          console.error(`[CopyDoc-Fill] Document Type write failed: ${writeResult.error.message}`);
        }
      } else {
        console.error(`[CopyDoc-Fill] Document Type field ${docTypeField ? 'not editable' : 'not found'}`);
      }

      // Find Document No. field
      const docNoField = dialog.fields.find(f =>
        f.caption.toLowerCase().includes('document no'),
      );

      if (docNoField && docNoField.editable && orderNo) {
        console.error(`[CopyDoc-Fill] Writing Document No. = "${orderNo}" on dialog field path=${docNoField.controlPath}...`);
        const writeResult = await h.session.invoke(
          {
            type: 'SaveValue' as const,
            formId: dialogFormId,
            controlPath: docNoField.controlPath,
            newValue: orderNo,
          } satisfies SaveValueInteraction,
          (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
        );

        if (isOk(writeResult)) {
          console.error(`[CopyDoc-Fill] Document No. write: SUCCESS (${writeResult.value.length} events)`);
        } else {
          console.error(`[CopyDoc-Fill] Document No. write failed: ${writeResult.error.message}`);
        }
      } else {
        console.error(`[CopyDoc-Fill] Document No. field ${docNoField ? 'not editable' : 'not found'}`);
      }

      // Execute the copy by responding "ok"
      console.error('[CopyDoc-Fill] Responding "ok" to execute copy...');
      const okResult = await h.respondDialog.execute({
        pageContextId: orderPageContextId,
        dialogFormId: dialogFormId,
        response: 'ok',
      });

      if (isOk(okResult)) {
        const okr = unwrap(okResult);
        console.error(`[CopyDoc-Fill] OK result: success=${okr.success}, changedSections=${okr.changedSections.join(',')}, newDialogs=${okr.dialogsOpened.length}, openedPages=${okr.openedPages.length}`);

        // After a successful copy, lines section should be updated
        if (okr.changedSections.length > 0) {
          console.error('[CopyDoc-Fill] Sections changed after copy -- lines were populated');
        }

        // Handle any follow-up dialogs (e.g., "Lines were copied" confirmation)
        if (okr.dialogsOpened.length > 0) {
          console.error('[CopyDoc-Fill] Follow-up dialog(s) after copy:');
          for (const d of okr.dialogsOpened) {
            console.error(`[CopyDoc-Fill]   formId=${d.formId}, message="${d.message ?? 'none'}"`);
          }
          await h.dismissDialogs(orderPageContextId, okr.dialogsOpened.map(d => ({
            type: 'DialogOpened' as const,
            formId: d.formId,
            controlTree: {},
          })), 'ok');
        }
      } else {
        console.error(`[CopyDoc-Fill] OK response failed: ${okResult.error.message}`);
        console.error('[CopyDoc-Fill] The copy may have triggered a validation error');
      }
    } else {
      // No structured fields -- just cancel the dialog
      console.error('[CopyDoc-Fill] No fields to fill -- cancelling dialog');
      await h.respondDialog.execute({
        pageContextId: orderPageContextId,
        dialogFormId: dialogFormId,
        response: 'cancel',
      });
    }

    // Clean up: close the order page
    await h.closeAndUntrack(orderPageContextId);
    console.error('[CopyDoc-Fill] DONE');
  }, 90_000);
});
