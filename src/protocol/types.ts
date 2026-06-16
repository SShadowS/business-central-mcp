// -- BCEvent types --

export type BCEvent =
  | FormCreatedEvent
  | FormClosedEvent
  | DialogOpenedEvent
  | MessageToShowEvent
  | DataLoadedEvent
  | PropertyChangedEvent
  | BookmarkChangedEvent
  | InvokeCompletedEvent
  | SessionInfoEvent
  | FileDownloadReadyEvent;

export interface FormCreatedEvent {
  readonly type: 'FormCreated';
  readonly formId: string;
  readonly parentFormId?: string;
  readonly isReload?: boolean;
  readonly controlTree: unknown;
}

export interface FormClosedEvent {
  readonly type: 'FormClosed';
  readonly formId: string;
}

export interface DialogOpenedEvent {
  readonly type: 'DialogOpened';
  readonly formId: string;
  readonly ownerFormId?: string;
  readonly controlTree: unknown;
}

/**
 * Non-modal toast message raised by BC's AL `Message()` / license-expiry
 * warning / other non-blocking session notifications.
 *
 * Wire: DN.LogicalClientEventRaisingHandler, params[0]="MessageToShow",
 * params[1] = { Text, Type?, Actions?, DefaultAction?, AutomationId? }.
 *
 * Type values (MessageFormIcon): None | Warning | Info | Error | Fatal |
 * Confirm | Permission. Serialised as the enum name string when the browser
 * UseEnumNames flag is true (default for the web client).
 *
 * Reference: LogicalMessageSerializer.Write() and
 * UISessionObserver.UiSessionMessageToShow() in decompiled
 * Microsoft.Dynamics.Framework.UI.Client / Microsoft.Dynamics.Framework.UI.Web.
 */
export interface MessageToShowEvent {
  readonly type: 'MessageToShow';
  /** Always empty string — MessageToShow is a session-level event, not form-scoped. */
  readonly formId: '';
  readonly text: string;
  /** Serialised MessageFormIcon enum name. Defaults to "None" when absent on wire. */
  readonly messageType: 'None' | 'Warning' | 'Info' | 'Error' | 'Fatal' | 'Confirm' | 'Permission';
  /** Available response actions. Defaults to ["Ok"] when omitted on wire. */
  readonly actions: string[];
  /** Default action name. Defaults to "Ok" when omitted on wire. */
  readonly defaultAction: string;
  readonly automationId?: string;
}

/**
 * A single validation result item that BC attaches to PropertyChanged events
 * as `changes.ValidationResults: ValidationResultItem[]`. An empty array clears
 * a previous error on the control.
 *
 * These arrive inline in PropertyChanged events (not as a separate event type)
 * when SaveValue is rejected by BC validation. The same items appear on the
 * offending control, its parent group, and the root form simultaneously.
 *
 * Severity values: "Error" (0) | "Warning" (1) | "Info" (2).
 *
 * Reference: ValidationResultItemSerializer.Write() in decompiled
 * Microsoft.Dynamics.Framework.UI.Client.
 */
export interface ValidationResultItem {
  /** Unique result-item identifier used for change tracking across events. */
  readonly Id: number;
  readonly Description: string;
  /**
   * Short one-sentence hint for the user (e.g. "Enter a number."). Optional — not
   * present for all validation types. Confirmed from live BC28 wire captures.
   */
  readonly DescriptionShort?: string;
  readonly Severity: 'Error' | 'Warning' | 'Info';
  /** True when the error is local (not from a remote sub-page). */
  readonly IsLocal?: boolean;
  /**
   * The control that triggered the validation. BC28 wire sends this as an object
   * `{ controlPath: string; formId: string }`, NOT a bare string.
   * Reference: live BC28 capture — Credit Limit (LCY) validation, 2026-06-15.
   */
  readonly OriginatingControl?: { readonly controlPath: string; readonly formId: string };
  readonly Title?: string | null;
  readonly TroubleshootInfo?: string | null;
  /**
   * BC exception type ordinal. 0 = standard field validation error. Not documented
   * in decompiled source but consistently present in live BC28 captures.
   */
  readonly ExceptionType?: number;
}

export interface DataLoadedEvent {
  readonly type: 'DataLoaded';
  readonly formId: string;
  readonly controlPath: string;
  readonly currentRowOnly: boolean;
  readonly rows: unknown[];
}

export interface PropertyChangedEvent {
  readonly type: 'PropertyChanged';
  readonly formId: string;
  readonly controlPath: string;
  readonly changes: Record<string, unknown>;
}

export interface BookmarkChangedEvent {
  readonly type: 'BookmarkChanged';
  readonly formId: string;
  readonly controlPath: string;
  readonly bookmark: string;
}

export interface InvokeCompletedEvent {
  readonly type: 'InvokeCompleted';
  readonly sequenceNumber: number;
  readonly completedInteractions: Array<{
    invocationId: string;
    durationMs: number;
    result?: unknown;
  }>;
}

export interface SessionInfoEvent {
  readonly type: 'SessionInfo';
  readonly formId: string;
  readonly sessionData: unknown;
}

/**
 * BC is ready to serve a file download. Emitted inline in the invoke callback
 * response as `DN.LogicalClientEventRaisingHandler` with event name `"UriToShow"`.
 *
 * Wire: params[0]="UriToShow", params[1]=relative URL, params[2]=style numeric string.
 * Style values: "0"=View, "1"=Download, "2"=Print.
 *
 * For reports, this arrives embedded in the format-dialog OK (`InvokeAction 300`)
 * response — NOT as a separate async Message notification. The URL is a
 * `DynamicFileHandler.axd?...` path relative to the BC base URL.
 *
 * Reference: `ResponseManager.RegisterUriToShowEvents` and
 * `FileUrlAddressProvider.cs` in decompiled
 * Microsoft.Dynamics.Framework.UI.Web. Verified from live BC28 wire capture
 * (2026-06-15): Trial Balance PDF download, form=41D.
 */
export interface FileDownloadReadyEvent {
  readonly type: 'FileDownloadReady';
  readonly formId: '';
  /** Relative URL path (e.g. "DynamicFileHandler.axd?form=41D&..."). Prepend BC base URL to fetch. */
  readonly relativeUrl: string;
  /** "0"=View, "1"=Download, "2"=Print */
  readonly style: string;
}

// -- BCInteraction types --

export type BCInteraction =
  | OpenFormInteraction
  | LoadFormInteraction
  | CloseFormInteraction
  | InvokeActionInteraction
  | SaveValueInteraction
  | FilterInteraction
  | SetCurrentRowInteraction
  | ScrollRepeaterInteraction
  | SessionActionInteraction;

interface BaseInteraction {
  readonly formId?: string;
  readonly controlPath?: string;
}

export interface OpenFormInteraction extends BaseInteraction {
  readonly type: 'OpenForm';
  readonly query: string;
}

export interface LoadFormInteraction extends BaseInteraction {
  readonly type: 'LoadForm';
  readonly formId: string;
  readonly loadData: boolean;
  readonly delayed?: boolean;
  readonly openForm?: boolean;
}

export interface CloseFormInteraction extends BaseInteraction {
  readonly type: 'CloseForm';
  readonly formId: string;
}

export interface InvokeActionInteraction extends BaseInteraction {
  readonly type: 'InvokeAction';
  readonly formId: string;
  readonly controlPath: string;
  readonly systemAction?: number;
  readonly namedParameters?: Record<string, unknown>;
}

export interface SaveValueInteraction extends BaseInteraction {
  readonly type: 'SaveValue';
  readonly formId: string;
  readonly controlPath: string;
  readonly newValue: string;
}

export interface FilterInteraction extends BaseInteraction {
  readonly type: 'Filter';
  readonly formId: string;
  readonly controlPath: string;
  readonly filterOperation: number;
  readonly filterColumnId?: string;
  readonly filterValue?: string;
}

export interface SetCurrentRowInteraction extends BaseInteraction {
  readonly type: 'SetCurrentRow';
  readonly formId: string;
  readonly controlPath: string;
  readonly key: string;
}

export interface ScrollRepeaterInteraction extends BaseInteraction {
  readonly type: 'ScrollRepeater';
  readonly formId: string;
  readonly controlPath: string;
  readonly delta: number;  // positive = forward/down, negative = backward/up
}

export interface SessionActionInteraction extends BaseInteraction {
  readonly type: 'SessionAction';
  readonly actionName: string;
  readonly namedParameters?: Record<string, unknown>;
}

// -- Constants --

export const SystemAction = {
  None: 0, New: 10, Delete: 20, Refresh: 30, Edit: 40,
  EditList: 50, View: 60, ViewList: 70, OpenFullList: 80,
  AssistEdit: 100, Lookup: 110, DrillDown: 120,
  PageSearch: 220,
  Ok: 300, Cancel: 310, Abort: 320,
  LookupOk: 330, LookupCancel: 340,
  // Reference: decompiled `Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs`
  // (BC28). `CloseOk = 350` is the dialog-level "close as OK" terminator emitted
  // alongside Cancel/Abort on wizard/standard-dialog forms; we treat it as a
  // cancel-shaped wizard nav role.
  CloseOk: 350,
  Yes: 380, No: 390,
} as const;

export const FilterOperation = {
  Execute: 0, AddLine: 1, RemoveLine: 2, Reset: 3,
} as const;

export type EventPredicate = (event: BCEvent, context: {
  callbackId: string;
  interactionFormId?: string;
  invokeCompletedSeen: boolean;
}) => boolean;

// -- PageState: derived from BCEvent[] projections --

/**
 * AL PageType names. Wire ordinal -> name mapping lives in form-tree-builder.ts
 * `PAGE_TYPE_MAP` and is sourced from decompiled `Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs`.
 */
export type PageType =
  | 'Card'
  | 'List'
  | 'RoleCenter'
  | 'CardPart'
  | 'ListPart'
  | 'Document'
  | 'Worksheet'
  | 'ListPlus'
  | 'ConfirmationDialog'
  | 'NavigatePage'
  | 'StandardDialog'
  | 'API'
  | 'HeadlinePart'
  | 'ReportPreview'
  | 'ReportProcessingOnly'
  | 'XmlPort'
  | 'ReportViewer'
  | 'FilterPage'
  | 'ListQuery'
  | 'BannerPart'
  | 'PromptDialog'
  | 'ConfigurationDialog'
  | 'UserControlHost'
  | 'Unknown';

export interface PageState {
  readonly pageContextId: string;
  readonly formId: string;
  readonly pageType: PageType;
  readonly controlTree: ControlField[];
  readonly repeater: RepeaterState | null;
  readonly filterControlPath: string | null;
  readonly actions: ActionInfo[];
  readonly childForms: ChildFormInfo[];
  readonly dialogs: DialogInfo[];
  readonly openFormIds: string[];
}

/**
 * MCP tool output DTO. Internal code reads `FieldNode` from `form-node.ts`
 * via `fields(root)` from `form-views.ts`. This shape is preserved at the
 * MCP boundary for tool output JSON stability.
 */
export interface ControlField {
  readonly controlPath: string;
  readonly caption: string;
  readonly type: string;
  readonly editable: boolean;
  /**
   * The control's own published `Visible` state. The user-visible filter must
   * combine this with every ancestor group's visibility — see
   * `isEffectivelyVisible` in protocol/visibility.ts.
   */
  readonly visible: boolean;
  readonly value?: unknown;
  readonly stringValue?: string;
  readonly columnBinderName?: string; // e.g., "1165569367_c2" — key in row cells
  readonly isLookup?: boolean;        // true if field has AssistEditAction or LookupAction
  readonly showMandatory?: boolean;   // true if field is marked as mandatory in BC
  /**
   * controlPaths of every gc ancestor between the form root (`server:`) and
   * this field's immediate parent gc, in root → leaf order. Empty for fields
   * that hang directly off the form root with no group container.
   */
  readonly ancestorGroupPaths: readonly string[];
}

export interface RepeaterState {
  readonly controlPath: string;
  readonly columns: RepeaterColumn[];
  readonly rows: RepeaterRow[];
  readonly totalRowCount: number | null;      // null = unknown; set from PropertyChanged, NOT rows.length
  readonly currentBookmark: string | null;     // per-repeater; set from BookmarkChanged events
}

export interface RepeaterColumn {
  readonly controlPath: string;
  readonly caption: string;
  readonly type: string;
  readonly columnBinderName?: string;   // key that matches row.cells keys
  readonly columnBinderPath?: string;   // for filter column IDs
}

export interface RepeaterRow {
  readonly bookmark: string;
  readonly cells: Record<string, unknown>;
}

export interface TabGroup {
  readonly caption: string;
  readonly fields: ControlField[];
}

/**
 * MCP tool output DTO. Internal code reads `ActionNode` from `form-node.ts`
 * via `actions(root)` from `form-views.ts`. This shape is preserved at the
 * MCP boundary for tool output JSON stability.
 */
export interface ActionInfo {
  readonly controlPath: string;
  readonly caption: string;
  readonly systemAction: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly isLineScoped: boolean;       // true if defined inside a repeater subtree
  readonly iconIdentifier?: string;     // raw icon resource path, e.g. "Actions/NextRecord/16.png"
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel'; // semantic role on a NavigatePage
}

/**
 * Per-form record of every group container's current `Visible` value, keyed by
 * controlPath. Maintained by FormProjection: seeded from the parsed control
 * tree and updated from `PropertyChanged` events whose target is a gc path.
 *
 * Groups not in the map are treated as visible (default-true) — only groups
 * the parser saw are tracked. Empty for forms with no group containers.
 */
export type GroupVisibility = ReadonlyMap<string, boolean>;

/**
 * Tracks the active step on a NavigatePage / wizard. BC's web client owns the
 * step variable entirely client-side; the wire only carries the initial
 * visibility and the `ExpressionProperties.Visible` membership flag that marks
 * which groups participate. We mirror the same state machine here.
 */
export interface WizardState {
  /**
   * controlPaths of the participating step groups in document order. Always
   * length ≥ 2; otherwise the page isn't treated as a wizard.
   */
  readonly stepPaths: readonly string[];
  /** Index into `stepPaths` of the currently visible step. */
  readonly currentStepIndex: number;
}

export enum ControlContainerType {
  ContentArea = 0,
  FactBoxArea = 1,
  RoleCenterArea = 2,
  RequestPageFilters = 3,
  DetailsArea = 4,
}

export interface ChildFormInfo {
  readonly formId: string;
  readonly caption: string;
}

export interface DialogInfo {
  readonly formId: string;
  readonly ownerFormId?: string;
  readonly controlTree: unknown;
}

// -- Backward compatibility --

import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import {
  fields as treeFields, actions as treeActions,
  repeaters as treeRepeaters, filterControlPath as treeFilter,
} from './form-views.js';

/**
 * DEPRECATED: Use PageContext for new code.
 * Converts a PageContext back to a PageState for consumers that haven't been migrated yet.
 */
export function derivePageState(ctx: PageContext): PageState {
  const rootForm = ctx.forms.get(ctx.rootFormId);
  const rep = rootForm ? primaryRepeaterFromCtx(rootForm) : null;
  return {
    pageContextId: ctx.pageContextId,
    formId: ctx.rootFormId,
    pageType: ctx.pageType,
    controlTree: rootForm ? treeFields(rootForm.root).map(f => ({
      controlPath: f.controlPath,
      caption: f.properties.caption ?? '',
      type: f.type,
      editable: f.properties.editable ?? false,
      visible: f.properties.visible ?? true,
      stringValue: f.properties.stringValue,
      value: f.properties.objectValue ?? f.properties.stringValue,
      columnBinderName: f.columnBinder?.name,
      ancestorGroupPaths: [],
    })) : [],
    repeater: rep,
    filterControlPath: rootForm ? treeFilter(rootForm.root) : null,
    actions: rootForm ? treeActions(rootForm.root).map(a => ({
      controlPath: a.controlPath,
      caption: a.properties.caption ?? '',
      systemAction: a.systemAction,
      enabled: a.properties.enabled ?? true,
      visible: a.properties.visible ?? true,
      isLineScoped: a.isLineScoped,
      iconIdentifier: a.iconIdentifier,
    })) : [],
    childForms: Array.from(ctx.forms.entries())
      .filter(([fId]) => fId !== ctx.rootFormId)
      .map(([fId]) => ({ formId: fId, caption: '' })),
    dialogs: ctx.dialogs,
    openFormIds: ctx.ownedFormIds,
  };
}

function primaryRepeaterFromCtx(form: FormState): RepeaterState | null {
  const first = treeRepeaters(form.root).values().next();
  if (first.done) return null;
  const node = first.value;
  const rows = form.rows.get(node.controlPath) ?? [];
  return {
    controlPath: node.controlPath,
    columns: node.columns.map(c => ({
      controlPath: c.controlPath,
      caption: c.properties.caption ?? '',
      type: 'rcc',
      columnBinderName: c.columnBinder?.name,
      columnBinderPath: c.columnBinder?.path,
    })),
    rows: [...rows],
    totalRowCount: node.properties.totalRowCount ?? null,
    currentBookmark: node.properties.bookmark ?? null,
  };
}

// Section DTO re-export. New code should import from `protocol/section-dto.js`
// directly; this re-export keeps `protocol/types.js` as the single barrel for
// MCP DTOs.
export type { Section, SectionField, SectionAction, SectionRow, SectionCue } from './section-dto.js';
