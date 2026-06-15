/**
 * Integration test: verify the wire shape of field-level validation errors from live BC28.
 *
 * When SaveValue is rejected by BC validation, the server sends PropertyChanged events
 * carrying ValidationResults arrays. This test confirms:
 *   1. Which mechanism BC uses to deliver validation errors
 *   2. The exact JSON shape of those events
 *   3. That extractValidationErrors() correctly decodes them
 *
 * Strategy:
 *   Use a Customer Card (page 21) in edit mode. Since CustomerCard needs
 *   an explicit "Edit" action to enter edit mode, we:
 *   1. Open Customer List (page 22)
 *   2. DrillDown on the first row to open Customer Card (page 21) in view mode
 *   3. Invoke Edit=40 to switch to edit mode
 *   4. Write "notadate!!" to a date field (Credit Limit Date or Payment Terms etc.)
 *      OR write "abc" to a numeric field (Credit Limit (LCY))
 *   5. Capture and assert the validation error
 *
 *   Alternatively (if the above doesn't work):
 *   6. Try writing a nonexistent lookup value to a code field (e.g. "Gen. Bus. Posting Group"
 *      = "ZZNOTEXIST") which triggers a relation-not-found validation error.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/validation-errors.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { extractValidationErrors, detectDialogs } from '../../src/protocol/mutation-result.js';
import type { BCEvent, PropertyChangedEvent, SaveValueInteraction, MessageToShowEvent, InvokeActionInteraction } from '../../src/protocol/types.js';
import { SystemAction } from '../../src/protocol/types.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';

/** Dump events that carry validation-relevant content. */
function dumpEvents(tag: string, events: BCEvent[]): void {
  for (const event of events) {
    console.error(`${tag} event.type=${event.type}`);
    if (event.type === 'PropertyChanged') {
      const pe = event as PropertyChangedEvent;
      const keys = Object.keys(pe.changes);
      console.error(`${tag}   controlPath=${pe.controlPath} changes.keys=[${keys.join(', ')}]`);
      for (const key of keys) {
        const val = pe.changes[key];
        if (typeof val !== 'string' || key.toLowerCase().includes('valid') || key.toLowerCase().includes('error')) {
          console.error(`${tag}   ${key} = ${JSON.stringify(val)}`);
        }
      }
    }
    if (event.type === 'MessageToShow') {
      console.error(`${tag}   ${JSON.stringify(event)}`);
    }
    if (event.type === 'DialogOpened') {
      console.error(`${tag}   formId=${'formId' in event ? (event as { formId: string }).formId : '?'}`);
    }
  }
}

/** Invoke SaveValue and return all raw events. */
async function tryWrite(session: BCSession, formId: string, controlPath: string, value: string): Promise<BCEvent[]> {
  const interaction: SaveValueInteraction = {
    type: 'SaveValue',
    formId,
    controlPath,
    newValue: value,
  };
  const result = await session.invoke(
    interaction,
    (event) =>
      event.type === 'InvokeCompleted' ||
      event.type === 'PropertyChanged' ||
      event.type === 'MessageToShow' ||
      event.type === 'DialogOpened',
  );
  if (isOk(result)) return result.value;
  console.error(`[tryWrite] Error: ${result.error.message}`);
  return [];
}

/** Classify validation feedback across all three possible mechanisms. */
function classify(events: BCEvent[]): {
  validationErrors: ReturnType<typeof extractValidationErrors>;
  messageEvents: BCEvent[];
  dialogEvents: BCEvent[];
  allKeys: string[];
} {
  const allKeys: string[] = [];
  for (const event of events) {
    if (event.type === 'PropertyChanged') {
      for (const key of Object.keys((event as PropertyChangedEvent).changes)) {
        if (!allKeys.includes(key)) allKeys.push(key);
      }
    }
  }
  return {
    validationErrors: extractValidationErrors(events),
    messageEvents: events.filter(e => e.type === 'MessageToShow'),
    dialogEvents: events.filter(e => e.type === 'DialogOpened'),
    allKeys: allKeys.sort(),
  };
}

describe('Validation errors (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let respondDialog: RespondDialogOperation;
  let repo: PageContextRepository;
  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
    actionService = new ActionService(session, repo, logger);
    respondDialog = new RespondDialogOperation(session, repo);
  }, 30_000);

  afterAll(async () => {
    for (const ctxId of openedPages) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('triggers a validation error in edit mode and verifies wire shape', async () => {
    // ---- APPROACH A: Customer List -> DrillDown row -> enter Edit -> write bad value ----
    console.error('[ValErr] Opening Customer List (page 22)...');
    const listResult = await pageService.openPage('22');
    expect(isOk(listResult)).toBe(true);
    const listCtx = unwrap(listResult);
    openedPages.push(listCtx.pageContextId);

    // Get repeater rows from list.
    const rowsResult = dataService.readRows(listCtx.pageContextId);
    expect(isOk(rowsResult)).toBe(true);
    const rows = unwrap(rowsResult);
    console.error(`[ValErr] Customer List rows: ${rows.length}`);
    expect(rows.length).toBeGreaterThan(0);

    // DrillDown on first row to open Customer Card in view mode.
    console.error('[ValErr] DrillDown on first Customer row...');
    const firstBookmark = rows[0]!.bookmark;
    const drillResult = await actionService.executeSystemAction(listCtx.pageContextId, SystemAction.Edit);
    if (isErr(drillResult)) {
      console.error(`[ValErr] DrillDown failed: ${drillResult.error.message}`);
    } else {
      console.error(`[ValErr] DrillDown events: ${drillResult.value.events.length}`);
      for (const e of drillResult.value.events) {
        console.error(`[ValErr]   ${e.type}${'formId' in e ? ' formId=' + (e as {formId: string}).formId : ''}`);
      }
    }

    // Look for the new card page created by the DrillDown.
    // DrillDown on a list row creates a new pageContext registered by PageService.
    // Check recently-added pageContextIds from repo.
    const allCtxIds = [...repo['pages'].keys()];
    console.error(`[ValErr] All page context IDs: ${allCtxIds.join(', ')}`);

    // Alternatively, look for newly opened pages in the events.
    let cardPageCtxId: string | undefined;
    if (isOk(drillResult)) {
      // Check if a new FormCreated event opened a card form.
      const formCreated = drillResult.value.events.find(e => e.type === 'FormCreated');
      if (formCreated?.type === 'FormCreated') {
        // Find the page context that owns this formId.
        const owned = allCtxIds.find(id => {
          const c = repo.get(id);
          return c && c.rootFormId === formCreated.formId;
        });
        cardPageCtxId = owned;
        console.error(`[ValErr] Card formId=${formCreated.formId} -> pageContextId=${owned}`);
      }
    }

    if (!cardPageCtxId) {
      // No DrillDown opened a separate context. Try opening Customer Card (page 21) directly.
      console.error('[ValErr] DrillDown did not open a new context. Opening page 21 directly...');
      const cardResult = await pageService.openPage('21');
      if (isOk(cardResult)) {
        cardPageCtxId = cardResult.value.pageContextId;
        openedPages.push(cardPageCtxId);
        console.error(`[ValErr] Customer Card opened: ${cardPageCtxId} formId=${cardResult.value.rootFormId}`);
      }
    }

    expect(cardPageCtxId).toBeDefined();
    if (!cardPageCtxId) {
      console.error('[ValErr] Could not open Customer Card. Aborting.');
      return;
    }

    const cardCtx = repo.get(cardPageCtxId);
    expect(cardCtx).toBeDefined();
    if (!cardCtx) return;
    const cardFormId = cardCtx.rootFormId;
    console.error(`[ValErr] Card formId=${cardFormId}`);

    // Enter Edit mode via InvokeAction(Edit=40).
    console.error('[ValErr] Invoking Edit action on Customer Card...');
    const editResult = await session.invoke(
      {
        type: 'InvokeAction',
        formId: cardFormId,
        controlPath: 'server:c[0]',
        systemAction: SystemAction.Edit,
      } satisfies InvokeActionInteraction,
      (event) =>
        event.type === 'InvokeCompleted' ||
        event.type === 'PropertyChanged' ||
        event.type === 'FormCreated',
    );
    if (isErr(editResult)) {
      console.error(`[ValErr] Edit invoke error: ${editResult.error.message}`);
    } else {
      repo.applyToPage(cardPageCtxId, editResult.value);
      console.error(`[ValErr] Edit invoke events: ${editResult.value.length}`);
      for (const e of editResult.value) {
        console.error(`[ValErr]   ${e.type}`);
      }
    }

    // Re-read fields in edit mode.
    const fieldsResult = dataService.getFields(cardPageCtxId);
    const allFields = isOk(fieldsResult) ? unwrap(fieldsResult) : [];
    const editableFields = allFields.filter(f => f.editable && f.caption);
    console.error(`[ValErr] Editable fields after Edit: ${editableFields.length}`);
    for (const f of editableFields.slice(0, 20)) {
      console.error(`[ValErr]   "${f.caption}" [${f.type}] path=${f.controlPath}`);
    }

    // Collect all field paths to try (both editable and non-editable, to be thorough).
    const allFieldPaths = allFields.filter(f => f.caption);
    const dateFieldPaths = allFieldPaths.filter(f => f.type === 'dtc' || f.type === 'Date');
    const numericFieldPaths = allFieldPaths.filter(f =>
      f.type === 'dc' || f.type === 'i32c' || f.type === 'Decimal' || f.type === 'Integer',
    );
    const codeFieldPaths = editableFields.filter(f => f.type === 'sc' || f.type === 'sec');

    console.error(`[ValErr] Date fields: ${dateFieldPaths.length}, Numeric: ${numericFieldPaths.length}, Code (editable): ${codeFieldPaths.length}`);

    // Try all field types for validation errors.
    let gotValidation = false;
    let confirmedMechanism = '';
    let confirmedEvents: BCEvent[] = [];

    // Priority 1: numeric fields with alpha text.
    for (const field of numericFieldPaths) {
      const events = await tryWrite(session, cardFormId, field.controlPath, 'notanumber$$');
      const cl = classify(events);
      console.error(`[ValErr] numeric "${field.caption}": validationErrors=${cl.validationErrors.length} msg=${cl.messageEvents.length} dialog=${cl.dialogEvents.length} keys=[${cl.allKeys.join(',')}]`);
      if (cl.validationErrors.length > 0 || cl.messageEvents.length > 0 || cl.dialogEvents.length > 0) {
        gotValidation = true; confirmedEvents = events;
        confirmedMechanism = cl.validationErrors.length > 0 ? 'PropertyChanged.ValidationResults' : cl.messageEvents.length > 0 ? 'MessageToShow' : 'DialogOpened';
        dumpEvents(`[ValErr ${field.caption}]`, events);
        for (const d of cl.dialogEvents) {
          try { await respondDialog.execute({ pageContextId: cardPageCtxId!, dialogFormId: (d as {formId:string}).formId, response: 'ok' }); } catch { /* ignore */ }
        }
        break;
      }
    }

    // Priority 2: date fields.
    if (!gotValidation) {
      for (const field of dateFieldPaths) {
        const events = await tryWrite(session, cardFormId, field.controlPath, 'notadate!!');
        const cl = classify(events);
        console.error(`[ValErr] date "${field.caption}": validationErrors=${cl.validationErrors.length} msg=${cl.messageEvents.length} dialog=${cl.dialogEvents.length} keys=[${cl.allKeys.join(',')}]`);
        if (cl.validationErrors.length > 0 || cl.messageEvents.length > 0 || cl.dialogEvents.length > 0) {
          gotValidation = true; confirmedEvents = events;
          confirmedMechanism = cl.validationErrors.length > 0 ? 'PropertyChanged.ValidationResults' : cl.messageEvents.length > 0 ? 'MessageToShow' : 'DialogOpened';
          dumpEvents(`[ValErr ${field.caption}]`, events);
          for (const d of cl.dialogEvents) {
            try { await respondDialog.execute({ pageContextId: cardPageCtxId!, dialogFormId: (d as {formId:string}).formId, response: 'ok' }); } catch { /* ignore */ }
          }
          break;
        }
      }
    }

    // Priority 3: code/lookup fields with nonexistent value.
    if (!gotValidation) {
      for (const field of codeFieldPaths.slice(0, 5)) {
        const events = await tryWrite(session, cardFormId, field.controlPath, 'ZZNOTEXIST9999');
        const cl = classify(events);
        console.error(`[ValErr] code "${field.caption}": validationErrors=${cl.validationErrors.length} msg=${cl.messageEvents.length} dialog=${cl.dialogEvents.length} keys=[${cl.allKeys.join(',')}]`);
        if (cl.validationErrors.length > 0 || cl.messageEvents.length > 0 || cl.dialogEvents.length > 0) {
          gotValidation = true; confirmedEvents = events;
          confirmedMechanism = cl.validationErrors.length > 0 ? 'PropertyChanged.ValidationResults' : cl.messageEvents.length > 0 ? 'MessageToShow' : 'DialogOpened';
          dumpEvents(`[ValErr ${field.caption}]`, events);
          for (const d of cl.dialogEvents) {
            try { await respondDialog.execute({ pageContextId: cardPageCtxId!, dialogFormId: (d as {formId:string}).formId, response: 'ok' }); } catch { /* ignore */ }
          }
          break;
        }
      }
    }

    // Log all PropertyChanged keys we saw across all attempts.
    console.error(`[ValErr] gotValidation=${gotValidation} mechanism="${confirmedMechanism}"`);

    if (!gotValidation) {
      // Fallback: look at what writeField reports via dataService for a numeric field.
      // dataService.writeField does NOT suppress any events from the invoke -- let's try.
      const numField = numericFieldPaths[0];
      if (numField) {
        console.error(`[ValErr] Trying writeField on "${numField.caption}"...`);
        const wfResult = await dataService.writeField(cardPageCtxId, numField.caption, 'notanumber$$');
        console.error(`[ValErr] writeField result: ${isOk(wfResult) ? 'ok' : 'err'}`);
        if (isOk(wfResult)) {
          const wfEvents = wfResult.value.events ?? [];
          console.error(`[ValErr] writeField events: ${wfEvents.length}`);
          dumpEvents('[ValErr-WF]', wfEvents);
          const cl = classify(wfEvents);
          console.error(`[ValErr-WF] validationErrors=${cl.validationErrors.length} msg=${cl.messageEvents.length} dialog=${cl.dialogEvents.length} keys=[${cl.allKeys.join(',')}]`);
          if (cl.validationErrors.length > 0 || cl.messageEvents.length > 0 || cl.dialogEvents.length > 0) {
            gotValidation = true; confirmedEvents = wfEvents;
            confirmedMechanism = cl.validationErrors.length > 0 ? 'PropertyChanged.ValidationResults' : cl.messageEvents.length > 0 ? 'MessageToShow' : 'DialogOpened';
          }
        } else {
          console.error(`[ValErr] writeField error: ${wfResult.error.message}`);
        }
      }
    }

    if (!gotValidation) {
      console.error('[ValErr] COULD NOT trigger a BC validation error.');
      console.error('[ValErr] BC silently drops SaveValue on non-editable fields without any event.');
      console.error('[ValErr] The form may not have entered edit mode, or BC28 behavior differs from expectation.');
      // Summarize what we learned: BC does NOT send ValidationResults / MessageToShow for silent rejects.
      expect(gotValidation).toBe(true);
      return;
    }

    // Assert the wire shape.
    console.error(`[ValErr] CONFIRMED MECHANISM: ${confirmedMechanism}`);
    const { validationErrors, messageEvents, dialogEvents } = classify(confirmedEvents);

    if (confirmedMechanism === 'PropertyChanged.ValidationResults') {
      expect(validationErrors.length).toBeGreaterThanOrEqual(1);
      const first = validationErrors[0]!;
      console.error(`[ValErr] ValidationResultItem[0]: ${JSON.stringify(first, null, 2)}`);

      // Core shape assertions — matches src/protocol/types.ts ValidationResultItem
      expect(typeof first.Id).toBe('number');
      expect(typeof first.Description).toBe('string');
      expect(first.Description.length).toBeGreaterThan(0);
      expect(['Error', 'Warning', 'Info']).toContain(first.Severity);

      // OriginatingControl arrives as an object { controlPath, formId }, not a string.
      // This was a TYPE MISMATCH in the original interface (was declared as string).
      // Confirmed from live BC28 wire capture: 2026-06-15.
      if (first.OriginatingControl !== undefined) {
        expect(typeof first.OriginatingControl).toBe('object');
        expect(typeof first.OriginatingControl.controlPath).toBe('string');
        expect(typeof first.OriginatingControl.formId).toBe('string');
      }

      // extractValidationErrors de-duplicates by Id. With multiple PropertyChanged events
      // (root form, parent group, the field itself) all carrying the same error, the output
      // should still have exactly one item per unique Id.
      const idSet = new Set(validationErrors.map(e => e.Id));
      expect(idSet.size).toBe(validationErrors.length);
    } else if (confirmedMechanism === 'MessageToShow') {
      const first = messageEvents[0] as MessageToShowEvent;
      console.error(`[ValErr] MessageToShowEvent: ${JSON.stringify(first, null, 2)}`);
      expect(typeof first.text).toBe('string');
      expect(first.text.length).toBeGreaterThan(0);
      expect(['None', 'Warning', 'Info', 'Error', 'Fatal', 'Confirm', 'Permission']).toContain(first.messageType);
    } else {
      expect(dialogEvents.length).toBeGreaterThan(0);
    }

    expect(gotValidation).toBe(true);
  }, 120_000);
});
