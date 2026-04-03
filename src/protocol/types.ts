// -- BCEvent types --

export type BCEvent =
  | FormCreatedEvent
  | DialogOpenedEvent
  | DataLoadedEvent
  | PropertyChangedEvent
  | BookmarkChangedEvent
  | InvokeCompletedEvent
  | SessionInfoEvent;

export interface FormCreatedEvent {
  readonly type: 'FormCreated';
  readonly formId: string;
  readonly parentFormId?: string;
  readonly isReload?: boolean;
  readonly controlTree: unknown;
}

export interface DialogOpenedEvent {
  readonly type: 'DialogOpened';
  readonly formId: string;
  readonly ownerFormId?: string;
  readonly controlTree: unknown;
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

// -- BCInteraction types --

export type BCInteraction =
  | OpenFormInteraction
  | LoadFormInteraction
  | CloseFormInteraction
  | InvokeActionInteraction
  | SaveValueInteraction
  | FilterInteraction
  | SetCurrentRowInteraction
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
  Ok: 300, Cancel: 310, Abort: 320,
  LookupOk: 330, LookupCancel: 340, Yes: 380, No: 390,
} as const;

export const FilterOperation = {
  Execute: 0, AddLine: 1, RemoveLine: 2, Reset: 3,
} as const;

export type EventPredicate = (event: BCEvent, context: {
  callbackId: string;
  interactionFormId?: string;
  invokeCompletedSeen: boolean;
}) => boolean;
