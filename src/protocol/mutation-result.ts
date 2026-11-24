// src/protocol/mutation-result.ts
import { v4 as uuid } from 'uuid';
import { SystemAction, type BCEvent, type DialogOpenedEvent, type MessageToShowEvent, type PropertyChangedEvent, type ValidationResultItem } from './types.js';
import type { PageContext } from './page-context.js';
import type { PageContextRepository } from './page-context-repo.js';
import { buildFormTree } from './form-tree-builder.js';
import { fields as treeFields, actions as treeActions, fieldName } from './form-views.js';
import { toSectionField, type SectionField } from './section-dto.js';

/**
 * After a mutating invoke, check which sections received events by matching
 * event formIds to the section map. If the root formId was touched, all
 * sections are considered changed (root events cascade via cross-form routing).
 */
export function detectChangedSections(
  ctx: PageContext,
  events: BCEvent[],
): string[] {
  const changedFormIds = new Set<string>();
  for (const event of events) {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (formId) changedFormIds.add(formId);
  }

  const changedSections: string[] = [];
  for (const [sectionId, section] of ctx.sections) {
    if (changedFormIds.has(section.formId)) {
      changedSections.push(sectionId);
    }
  }

  // Root form events may cascade to lines via cross-form routing
  if (changedFormIds.has(ctx.rootFormId)) {
    for (const [sectionId] of ctx.sections) {
      if (!changedSections.includes(sectionId)) {
        changedSections.push(sectionId);
      }
    }
  }

  return changedSections;
}

/**
 * Extract field-level validation errors from PropertyChanged events.
 *
 * BC delivers validation errors inline: when SaveValue is rejected, one or
 * more PropertyChanged events carry `changes.ValidationResults` arrays on the
 * offending control, its parent group, and the root form. We de-duplicate by
 * Id and return only the distinct items, hoisting them to the top level so
 * callers don't need to scan every PropertyChanged.
 *
 * An empty ValidationResults array (error cleared) produces no items here.
 *
 * Reference: ValidationResultItemSerializer.Write() in decompiled
 * Microsoft.Dynamics.Framework.UI.Client (confirmed via live BC28 probe).
 */
export function extractValidationErrors(events: BCEvent[]): ValidationResultItem[] {
  const seen = new Set<number>();
  const out: ValidationResultItem[] = [];
  for (const event of events) {
    if (event.type !== 'PropertyChanged') continue;
    const raw = (event as PropertyChangedEvent).changes['ValidationResults'];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    for (const item of raw as ValidationResultItem[]) {
      if (typeof item?.Id === 'number' && !seen.has(item.Id)) {
        seen.add(item.Id);
        out.push(item);
      }
    }
  }
  return out;
}

/** A non-blocking AL `Message()` (or other session notification) BC raised during the call. */
export interface ShownMessage {
  readonly text: string;
  readonly type: MessageToShowEvent['messageType'];
}

/**
 * The `MessageToShow` events of a call, minus Error/Fatal (classifyBusinessError
 * turns those into a BusinessError). Without this an action that reports its
 * result through `Message()` looked like it did nothing (#49).
 */
export function collectMessages(events: BCEvent[]): ShownMessage[] {
  return events
    .filter((e): e is MessageToShowEvent => e.type === 'MessageToShow'
      && e.messageType !== 'Error' && e.messageType !== 'Fatal')
    .map(e => ({ text: e.text, type: e.messageType }));
}

/** What a dialog is, from its `MappingHint` (MessageForm kinds, NavRequestPage), else a modal page. */
export type DialogKind = 'confirm' | 'message' | 'error' | 'requestPage' | 'page';
/** A `bc_respond_dialog` response. */
export type DialogResponse = 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'print' | 'preview';

const KIND_BY_HINT: Record<string, DialogKind> = {
  ConfirmDialog: 'confirm',
  InfoDialog: 'message',
  ErrorDialog: 'error',
  RequestPage: 'requestPage',
};

/** The button SystemActions each response presses (inverse of respond-dialog's RESPONSE_MAP). */
const RESPONSE_BY_ACTION: ReadonlyMap<number, DialogResponse> = new Map([
  [SystemAction.Ok, 'ok'], [SystemAction.LookupOk, 'ok'],
  [SystemAction.Cancel, 'cancel'], [SystemAction.LookupCancel, 'cancel'],
  [SystemAction.Yes, 'yes'], [SystemAction.No, 'no'], [SystemAction.Abort, 'abort'],
  [SystemAction.Print, 'print'], [SystemAction.ReportPreview, 'preview'],
]);

const DEFAULT_RESPONSES: Record<DialogKind, DialogResponse[]> = {
  confirm: ['yes', 'no'],
  message: ['ok'],
  error: ['ok'],
  requestPage: ['ok', 'cancel'],
  page: ['ok', 'cancel'],
};

/** A dialog as the MCP caller sees it. */
export interface DialogInfo {
  formId: string;
  kind: DialogKind;
  /** The dialog's caption ("Confirm", the report name, ...). */
  title?: string;
  /** For a confirm/message/error: the text it shows (the question to answer). */
  message?: string;
  /** The answers bc_respond_dialog accepts here: the dialog's own buttons, else its kind's. */
  responses: DialogResponse[];
  /** Fillable or informative fields, in the page-section field shape. */
  fields?: SectionField[];
}

/**
 * Describe a dialog from its control tree. Dialog trees may arrive as a bare object (no `t`)
 * or as an `lf` node; normalise to `lf` so buildFormTree processes the children.
 */
export function describeDialog(formId: string, controlTree: unknown): DialogInfo {
  const raw = (controlTree ?? {}) as Record<string, unknown>;
  const kind = KIND_BY_HINT[String(raw.MappingHint ?? raw.mappingHint ?? '')] ?? 'page';
  const title = (raw.Caption as string) || undefined;
  let message = (raw.Message as string) || undefined;
  let fields: SectionField[] = [];
  let responses: DialogResponse[] = [];
  if (typeof raw.Children !== 'undefined') {
    try {
      const root = buildFormTree(raw.t === 'lf' ? raw : { ...raw, t: 'lf' });
      let shown = treeFields(root).filter(f => f.properties.visible !== false && (fieldName(f) || f.properties.stringValue));
      if (kind === 'confirm' || kind === 'message' || kind === 'error') {
        // A MessageForm shows its text as a static string control (live cronus29: the discard
        // confirm's question is the caption of an `ssc` under server:c[0]/c[0]).
        const text = shown.find(f => f.type === 'ssc');
        if (text) {
          message ??= fieldName(text) || text.properties.stringValue;
          shown = shown.filter(f => f !== text);
        }
      }
      fields = shown.map(toSectionField);
      responses = [...new Set(treeActions(root)
        .filter(a => a.properties.visible !== false && a.properties.enabled !== false)
        .map(a => RESPONSE_BY_ACTION.get(a.systemAction))
        .filter((r): r is DialogResponse => r !== undefined))];
    } catch {
      // Non-fatal: a tree we cannot read still yields kind, title and default responses.
    }
  }
  // A request page opened with OpenForm(report=N) has Print/Preview/Cancel buttons but no OK
  // (live cronus29, report 6); OK on server:c[0] still runs it (CLAUDE.md "Report Execution Protocol").
  if (kind === 'requestPage' && responses.length > 0 && !responses.includes('ok')) responses.unshift('ok');
  return {
    formId,
    kind,
    ...(title ? { title } : {}),
    ...(message ? { message } : {}),
    responses: responses.length > 0 ? responses : DEFAULT_RESPONSES[kind],
    ...(fields.length > 0 ? { fields } : {}),
  };
}

/** The dialogs a batch of events opened. */
export function detectDialogs(events: BCEvent[]): DialogInfo[] {
  return events
    .filter((e): e is DialogOpenedEvent => e.type === 'DialogOpened')
    .map(e => describeDialog(e.formId, e.controlTree));
}

/** A page a call opened (drill-down, an action, a dialog answer): address it by pageContextId. */
export interface OpenedPage {
  pageContextId: string;
  caption: string;
  pageType: string;
}

/**
 * A dialog a call opened. `pageContextId` addresses it as a page context of its own:
 * fill its fields with bc_write_data against it, then answer it with bc_respond_dialog.
 */
export interface OpenedDialog extends DialogInfo {
  pageContextId: string;
}

/**
 * Detect the dialogs a call opened and register each as a page context of its own,
 * the way bc_run_report registers its request page, so bc_write_data can fill its
 * fields and bc_respond_dialog can press its button. Every tool that can open a
 * dialog goes through this (#52: bc_wizard_navigate returned dialogs without one).
 * Only the dialog's own events are applied to its context: a sibling dialog or a
 * host-form event in the same batch must not leak in.
 */
export function registerDialogs(
  repo: PageContextRepository,
  ownerPageContextId: string,
  events: BCEvent[],
): OpenedDialog[] {
  return detectDialogs(events).map(d => {
    const pageContextId = `session:page:dialog:${uuid().substring(0, 8)}`;
    repo.create(pageContextId, d.formId, { isModal: true, ownerPageContextId });
    repo.applyToPage(pageContextId, events.flatMap(e => eventForDialog(e, d.formId)));
    return { pageContextId, ...d };
  });
}

function eventForDialog(event: BCEvent, formId: string): BCEvent[] {
  if (!('formId' in event) || event.formId !== formId) return [];
  if (event.type !== 'DialogOpened') return [event];
  // Same normalisation as detectDialogs: a dialog tree can arrive without the `lf` tag.
  const raw = event.controlTree as Record<string, unknown> | undefined;
  if (raw && raw.t !== 'lf' && typeof raw.Children !== 'undefined') {
    return [{ ...event, controlTree: { ...raw, t: 'lf' } }];
  }
  return [event];
}
