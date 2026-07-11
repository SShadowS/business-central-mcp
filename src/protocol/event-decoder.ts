import { HANDLER_TYPES } from './handler-types.js';
import { resolveChangeType, SESSION_EVENTS } from './wire-types.js';
import type {
  BCEvent, FormCreatedEvent, FormClosedEvent, DialogOpenedEvent, MessageToShowEvent,
  DataLoadedEvent, RowDeltaEvent, PropertyChangedEvent, BookmarkChangedEvent, InvokeCompletedEvent,
  SessionInfoEvent, FileDownloadReadyEvent,
} from './types.js';

const MESSAGE_TYPES: readonly MessageToShowEvent['messageType'][] =
  ['None', 'Warning', 'Info', 'Error', 'Fatal', 'Confirm', 'Permission'];

/**
 * Normalize BC's MessageToShow `Type` to the canonical messageType union,
 * tolerating casing variants (e.g. "error" → "Error"). An unrecognized or
 * numeric-ordinal value falls back to 'None' instead of leaking a non-union
 * value that `classifyBusinessError`'s exact `=== 'Error'` check would skip.
 */
function normalizeMessageType(raw: unknown): MessageToShowEvent['messageType'] {
  if (typeof raw === 'string') {
    const match = MESSAGE_TYPES.find(t => t.toLowerCase() === raw.toLowerCase());
    if (match) return match;
  }
  return 'None';
}

export class EventDecoder {
  decode(handlers: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    for (const handler of handlers) {
      if (!handler || typeof handler !== 'object') continue;
      const h = handler as { handlerType?: string; parameters?: unknown[] };
      if (!h.handlerType || !Array.isArray(h.parameters)) continue;
      try {
        switch (h.handlerType) {
          case HANDLER_TYPES.LogicalClientChange:
            events.push(...this.decodeLogicalClientChange(h.parameters));
            break;
          case HANDLER_TYPES.LogicalClientEventRaising:
            events.push(...this.decodeEventRaising(h.parameters));
            break;
          case HANDLER_TYPES.CallbackResponseProperties:
            events.push(...this.decodeCallbackResponseProperties(h.parameters));
            break;
          case HANDLER_TYPES.CachedSessionInit:
          case HANDLER_TYPES.SessionInit:
            events.push(...this.decodeSessionInfo(h.parameters));
            break;
        }
      } catch { /* malformed handler - skip */ }
    }
    return events;
  }

  private decodeLogicalClientChange(params: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    const formId = params[0] as string;
    const changes = params[1] as unknown[];
    if (!formId || !Array.isArray(changes)) return events;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const c = change as Record<string, unknown>;
      const wireType = c.t as string;
      const resolved = resolveChangeType(wireType);
      const controlRef = c.ControlReference as { controlPath?: string } | undefined;
      const controlPath = controlRef?.controlPath ?? '';

      switch (resolved) {
        case 'DataRefreshChange':
          events.push({ type: 'DataLoaded', formId, controlPath, currentRowOnly: (c.CurrentRowOnly as boolean) ?? false, rows: (c.RowChanges as unknown[]) ?? [] } satisfies DataLoadedEvent);
          break;
        case 'DataRowInserted':
        case 'DataRowUpdated': {
          // Top-level incremental row change: { t, ControlReference, "<t>": [index, { bookmark, cells }] }.
          // Verified from decompiled LogicalChangeSetSerializer (BC28): these are
          // emitted as top-level siblings on the delta path, not nested in a
          // DataRefreshChange. The payload key equals the (long) type name.
          const arr = (c[resolved] ?? c[wireType]) as unknown[] | undefined;
          if (Array.isArray(arr) && arr.length >= 2 && arr[1] && typeof arr[1] === 'object') {
            const payload = arr[1] as Record<string, unknown>;
            events.push({
              type: 'RowDelta', formId, controlPath,
              op: resolved === 'DataRowInserted' ? 'insert' : 'update',
              bookmark: (payload['bookmark'] ?? payload['Bookmark'] ?? '') as string,
              index: typeof arr[0] === 'number' ? (arr[0] as number) : undefined,
              cells: (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>,
            } satisfies RowDeltaEvent);
          }
          break;
        }
        case 'DataRowRemoved': {
          // Removal is identified by bookmark only (no index). Wire: { t, ControlReference, Bookmark }.
          const bookmark = (c.Bookmark ?? c.bookmark) as string | undefined;
          if (bookmark) {
            events.push({ type: 'RowDelta', formId, controlPath, op: 'remove', bookmark } satisfies RowDeltaEvent);
          }
          break;
        }
        case 'DataRowPropertyChange':
          // Intentionally ignored. Verified from decompiled BC28
          // (LogicalControlDataObserver.OnRowEntryPropertyChanged): this change
          // only ever carries a row-level Selected/Expanded/Draft boolean, never
          // a cell value (cell changes arrive as DataRowUpdated). The row model
          // ({ bookmark, cells }) tracks none of those, so there is nothing to
          // apply — decoding it as a cell would corrupt cells with a bogus key.
          break;
        case 'PropertyChanges':
          events.push({ type: 'PropertyChanged', formId, controlPath, changes: (c.Changes as Record<string, unknown>) ?? {} } satisfies PropertyChangedEvent);
          break;
        case 'PropertyChange': {
          const propName = c.PropertyName as string;
          if (propName) {
            events.push({ type: 'PropertyChanged', formId, controlPath, changes: { [propName]: c.PropertyValue } } satisfies PropertyChangedEvent);
          }
          break;
        }
        case 'DataRowBookmarkChange':
          events.push({ type: 'BookmarkChanged', formId, controlPath, bookmark: (c.Bookmark as string) ?? '' } satisfies BookmarkChangedEvent);
          break;
      }
    }
    return events;
  }

  private decodeEventRaising(params: unknown[]): BCEvent[] {
    const events: BCEvent[] = [];
    const eventName = params[0] as string;
    const eventData = (params[1] ?? {}) as Record<string, unknown>;

    switch (eventName) {
      case SESSION_EVENTS.FormToShow:
        events.push({ type: 'FormCreated', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string, parentFormId: (eventData.ParentForm ?? eventData.parentForm) as string | undefined, isReload: (eventData.IsReload ?? false) as boolean, controlTree: eventData } satisfies FormCreatedEvent);
        break;
      case SESSION_EVENTS.DialogToShow:
        events.push({ type: 'DialogOpened', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string, ownerFormId: (eventData.OwnerForm ?? eventData.ownerForm) as string | undefined, controlTree: eventData } satisfies DialogOpenedEvent);
        break;
      case SESSION_EVENTS.ClosePendingForm:
        events.push({ type: 'FormClosed', formId: (eventData.ServerId ?? eventData.formId ?? eventData.FormId ?? '') as string } satisfies FormClosedEvent);
        break;
      case SESSION_EVENTS.LookupFormReady: {
        // LookupFormReady: params[1] is the raw lf JSON of the lookup form.
        // Emit FormCreated so BCSession.updateFormTracking tracks the lookup
        // form's ServerId in _openFormIds, enabling LookupCancel to include
        // it in the openFormIds array of subsequent requests.
        // Reference: live-verified design: docs/superpowers/plans/2026-06-20-bc-lookup-tool.md
        events.push({
          type: 'FormCreated',
          formId: (eventData.ServerId ?? '') as string,
          parentFormId: undefined,
          isReload: false,
          controlTree: eventData,
        } satisfies FormCreatedEvent);
        break;
      }
      case SESSION_EVENTS.MessageToShow: {
        // Non-modal toast: AL Message(), license-expiry warnings, etc.
        // Wire: params[1] = { Text, Type?, Actions?, DefaultAction?, AutomationId? }
        // Reference: LogicalMessageSerializer.Write() (decompiled
        //   Microsoft.Dynamics.Framework.UI.Client), confirmed via live BC28 probe.
        const rawActions = eventData.Actions as string[] | undefined;
        const rawDefault = eventData.DefaultAction as string | undefined;
        events.push({
          type: 'MessageToShow',
          formId: '',
          text: (eventData.Text as string | undefined) ?? '',
          messageType: normalizeMessageType(eventData.Type),
          actions: rawActions ?? ['Ok'],
          defaultAction: rawDefault ?? 'Ok',
          automationId: eventData.AutomationId as string | undefined,
        } satisfies MessageToShowEvent);
        break;
      }
      case SESSION_EVENTS.UriToShow: {
        // Download/view URI delivered inline in the invoke callback response.
        // params[0]="UriToShow", params[1]=relativeUrl, params[2]=style.
        // Style: "0"=View, "1"=Download, "2"=Print.
        // Reference: ResponseManager.RegisterUriToShowEvents (decompiled
        //   Microsoft.Dynamics.Framework.UI.Web). Verified from live BC28 wire
        //   capture (2026-06-15): Trial Balance PDF, DynamicFileHandler.axd.
        const relativeUrl = params[1] as string | undefined;
        const style = params[2] as string | undefined;
        if (relativeUrl) {
          events.push({
            type: 'FileDownloadReady',
            formId: '',
            relativeUrl,
            style: style ?? '1',
          } satisfies FileDownloadReadyEvent);
        }
        break;
      }
    }
    return events;
  }

  private decodeCallbackResponseProperties(params: unknown[]): BCEvent[] {
    const data = params[0] as Record<string, unknown> | undefined;
    if (!data) return [];
    const completed = (data.CompletedInteractions ?? []) as Array<Record<string, unknown>>;
    return [{ type: 'InvokeCompleted', sequenceNumber: (data.SequenceNumber as number) ?? 0, completedInteractions: completed.map(ci => ({ invocationId: (ci.InvocationId as string) ?? '', durationMs: (ci.Duration as number) ?? 0, result: ci.Result })) } satisfies InvokeCompletedEvent];
  }

  private decodeSessionInfo(params: unknown[]): BCEvent[] {
    return [{ type: 'SessionInfo', formId: '', sessionData: params[0] } satisfies SessionInfoEvent];
  }
}
