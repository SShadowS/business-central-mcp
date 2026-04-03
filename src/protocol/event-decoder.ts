import { HANDLER_TYPES } from './handler-types.js';
import { resolveChangeType, SESSION_EVENTS } from './wire-types.js';
import type {
  BCEvent, FormCreatedEvent, DialogOpenedEvent, DataLoadedEvent,
  PropertyChangedEvent, BookmarkChangedEvent, InvokeCompletedEvent, SessionInfoEvent,
} from './types.js';

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
        events.push({ type: 'FormCreated', formId: (eventData.formId ?? eventData.FormId ?? '') as string, parentFormId: (eventData.ParentForm ?? eventData.parentForm) as string | undefined, isReload: (eventData.IsReload ?? false) as boolean, controlTree: eventData } satisfies FormCreatedEvent);
        break;
      case SESSION_EVENTS.DialogToShow:
        events.push({ type: 'DialogOpened', formId: (eventData.formId ?? eventData.FormId ?? '') as string, ownerFormId: (eventData.OwnerForm ?? eventData.ownerForm) as string | undefined, controlTree: eventData } satisfies DialogOpenedEvent);
        break;
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
