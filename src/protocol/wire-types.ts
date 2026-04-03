/** Change type abbreviations used in the "t" field of change objects */
export const CHANGE_TYPES: Record<string, string> = {
  'DataRefreshChange': 'DataRefreshChange',
  'drch': 'DataRefreshChange',
  'DataRowInserted': 'DataRowInserted',
  'drich': 'DataRowInserted',
  'DataRowUpdated': 'DataRowUpdated',
  'druch': 'DataRowUpdated',
  'DataRowRemoved': 'DataRowRemoved',
  'drrch': 'DataRowRemoved',
  'DataRowBookmarkChange': 'DataRowBookmarkChange',
  'drbch': 'DataRowBookmarkChange',
  'DataRowPropertyChange': 'DataRowPropertyChange',
  'drpch': 'DataRowPropertyChange',
  'PropertyChange': 'PropertyChange',
  'lcpch': 'PropertyChange',
  'PropertyChanges': 'PropertyChanges',
  'lcpchs': 'PropertyChanges',
  'ChildInserted': 'ChildInserted',
  'cich': 'ChildInserted',
  'ChildRemoved': 'ChildRemoved',
  'crch': 'ChildRemoved',
  'ChildMoved': 'ChildMoved',
  'cmch': 'ChildMoved',
  'EventRaisedChange': 'EventRaisedChange',
  'lcerch': 'EventRaisedChange',
  'MethodInvoked': 'MethodInvoked',
  'mich': 'MethodInvoked',
};

export type ChangeType = string;

export function resolveChangeType(wireType: string): string | undefined {
  return CHANGE_TYPES[wireType];
}

export const CONTROL_TYPES: Record<string, string> = {
  'lf': 'LogicalForm',
  'DN.LogicalForm': 'LogicalForm',
  'rc': 'RepeaterControl',
  'DN.RepeaterControl': 'RepeaterControl',
  'sc': 'StringControl',
  'DN.StringControl': 'StringControl',
  'ac': 'ActionControl',
  'DN.ActionControl': 'ActionControl',
};

export const SESSION_EVENTS = {
  FormToShow: 'FormToShow',
  DialogToShow: 'DialogToShow',
  MessageToShow: 'MessageToShow',
  LookupFormReady: 'LookupFormReady',
  UriToShow: 'UriToShow',
  RequestUserToken: 'RequestUserToken',
  CopilotSettingsChanged: 'CopilotSettingsChanged',
  ClosePendingForm: 'ClosePendingForm',
} as const;
