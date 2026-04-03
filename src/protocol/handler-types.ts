export const HANDLER_TYPES = {
  LogicalClientChange: 'DN.LogicalClientChangeHandler',
  LogicalClientEventRaising: 'DN.LogicalClientEventRaisingHandler',
  ExtensionObjectChange: 'DN.ExtensionObjectChangeHandler',
  LogicalClientInit: 'DN.LogicalClientInitHandler',
  SessionInit: 'DN.SessionInitHandler',
  CachedSessionInit: 'DN.CachedSessionInitHandler',
  LogicalSessionChange: 'DN.LogicalSessionChangeHandler',
  SessionSettingsChanged: 'DN.SessionSettingsChangedHandler',
  NavigationServiceInit: 'DN.NavigationServiceInitHandler',
  NavigationServiceChange: 'DN.NavigationServiceChangeHandler',
  EmptyPageStack: 'DN.EmptyPageStackHandler',
  CallbackResponseProperties: 'DN.CallbackResponseProperties',
  IsExecuting: 'DN.IsExecutingHandler',
} as const;

export type HandlerType = (typeof HANDLER_TYPES)[keyof typeof HANDLER_TYPES];
