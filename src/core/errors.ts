export abstract class BCError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  /** True when resolving this error requires the user to complete a sign-in
   * flow. Set on the subclass, so a new sign-in-flow error class carries its
   * own HTTP-401 classification instead of needing registration in a
   * hand-maintained code list elsewhere. */
  public readonly authRequired: boolean = false;
  protected constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, timestamp: this.timestamp.toISOString(), context: this.context };
  }
}
export class ConnectionError extends BCError {
  public readonly status?: number;
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONNECTION_ERROR', context);
    this.status = typeof context?.status === 'number' ? context.status : undefined;
  }
}
export class AuthenticationError extends BCError {
  public override readonly authRequired = true;
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'AUTHENTICATION_ERROR', context); }
}

export class SignInRequiredError extends BCError {
  public override readonly authRequired = true;
  public readonly openedWindow: boolean;
  public readonly reason: string;
  constructor(message: string, opts: { openedWindow: boolean; reason: string }) {
    super(message, 'SIGN_IN_REQUIRED', opts);
    this.openedWindow = opts.openedWindow;
    this.reason = opts.reason;
  }
}

export interface UrlElicitation {
  mode: 'url';
  elicitationId: string;
  url: string;
  message: string;
}

export class UrlElicitationRequiredError extends BCError {
  public override readonly authRequired = true;
  public readonly elicitations: UrlElicitation[];
  constructor(elicitations: UrlElicitation[], message = 'This request requires sign-in in the browser window.') {
    super(message, 'URL_ELICITATION_REQUIRED');
    this.elicitations = elicitations;
  }
}

// Deliberately NOT authRequired: OAUTH_NOT_CONFIGURED means BC_CLIENT_ID is
// missing from the server environment — a config problem no user sign-in can
// resolve, so an HTTP 401 would send clients into a pointless sign-in loop.
export class OAuthNotConfiguredError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'OAUTH_NOT_CONFIGURED', context);
  }
}

/**
 * A device-code sign-in is in flight: the user must open the verification
 * URL and enter the code, then retry the tool. The message carries the URL
 * and code so the MCP client can show them in chat — the MCP server has no
 * interactive terminal, so stderr never reaches the user.
 */
export class DeviceLoginRequiredError extends BCError {
  public override readonly authRequired = true;
  public readonly verificationUri: string;
  public readonly userCode: string;
  public readonly expiresAt: number;
  constructor(verificationUri: string, userCode: string, expiresAt: number) {
    super(
      `Sign in to Business Central: open ${verificationUri} and enter code ${userCode}. `
      + `The code expires in about ${Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))} minutes. `
      + 'Retry this tool after signing in.',
      'DEVICE_LOGIN_REQUIRED',
      { verificationUri, userCode, expiresAt },
    );
    this.verificationUri = verificationUri;
    this.userCode = userCode;
    this.expiresAt = expiresAt;
  }
}
export class TimeoutError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'TIMEOUT_ERROR', context); }
}
export class AbortedError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'ABORTED_ERROR', context); }
}
export class ProtocolError extends BCError {
  constructor(message: string, context?: Record<string, unknown>, code: string = 'PROTOCOL_ERROR') { super(message, code, context); }
}
export class SessionLostError extends BCError {
  public readonly impactedPageContextIds: string[];
  public readonly reconnectFailed: boolean;
  constructor(message: string, impactedPageContextIds: string[], options?: { reconnectFailed?: boolean; context?: Record<string, unknown> }) {
    super(message, 'SESSION_LOST', options?.context);
    this.impactedPageContextIds = impactedPageContextIds;
    this.reconnectFailed = options?.reconnectFailed ?? false;
  }
}
/**
 * Thrown when bc-mcp detected a `LogicalModalityViolationException` and the
 * automatic modal-stack reconciliation could not clear it (Abort failed, or
 * the violation persisted after retry). The session is killed and recreated
 * by the SessionManager -- page contexts are invalidated, callers must re-open
 * any pages.
 */
export class ModalReconcileError extends ProtocolError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context, 'MODAL_RECONCILE_ERROR');
  }
}
export class InputValidationError extends BCError {
  public readonly fieldErrors: Array<{ path: string; message: string }>;
  constructor(fieldErrors: Array<{ path: string; message: string }>) {
    super(`Input validation failed: ${fieldErrors.map(e => `${e.path}: ${e.message}`).join(', ')}`, 'INPUT_VALIDATION_ERROR');
    this.fieldErrors = fieldErrors;
  }
}
/**
 * Returned by bc_open_page when the requested page is a CardPart that BC
 * delivers as a server stub when opened standalone. Detection: pageType is
 * `CardPart` AND the root form has zero captioned fields AND zero cuegroup
 * tiles (cue-only CardParts like Activities are NOT stubs and pass through).
 * The caller should reach the part through its host form (a Role Center or
 * another page that embeds it).
 *
 * Verified-non-reproducing on stock BC28 (pages 1310, 9061, 9152 all return
 * full content). Reproduces on some vertical-app environments per limits.md #1.
 */
export class CardPartStubError extends ProtocolError {
  constructor(message: string, context: { pageId: string; hostHint: string }) {
    super(message, context, 'CARDPART_STUB');
  }
}

/**
 * Thrown when BC rejects a SaveValue due to field-level validation.
 * Maps to BC `ValidationResults` with Severity='Error' in PropertyChanged events.
 * Use `fieldErrors` to surface per-field messages to the MCP caller.
 */
export class BusinessValidationError extends BCError {
  public readonly fieldErrors: Array<{ field?: string; description: string; descriptionShort?: string }>;
  constructor(fieldErrors: Array<{ field?: string; description: string; descriptionShort?: string }>) {
    super(fieldErrors.map(e => e.description).join('; '), 'VALIDATION_ERROR');
    this.fieldErrors = fieldErrors;
  }
  public override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), fieldErrors: this.fieldErrors };
  }
}

/**
 * Thrown when BC raises a non-validation business error via MessageToShow
 * (messageType='Error'|'Fatal') or an ErrorDialog (MappingHint='ErrorDialog').
 * `source` tells the caller which channel surfaced the error.
 */
export class BusinessError extends BCError {
  public readonly bcText: string;
  public readonly severity: string;
  public readonly source: 'message' | 'dialog';
  constructor(opts: { bcText: string; severity: string; source: 'message' | 'dialog' }) {
    super(opts.bcText, 'BUSINESS_ERROR');
    this.bcText = opts.bcText;
    this.severity = opts.severity;
    this.source = opts.source;
  }
  public override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), bcText: this.bcText, severity: this.severity, source: this.source };
  }
}

/**
 * Thrown (as an Err result) when a mutating operation is given an
 * `expectedStateVersion` that does not match the page context's current
 * generation. This means the page state drifted (async Message events or a
 * sibling operation mutated the form) since the LLM last read it.
 *
 * The caller should re-read with bc_read_data to obtain the current
 * stateVersion, then retry.
 */
export class StaleContextError extends BCError {
  public readonly expectedGeneration: number;
  public readonly actualGeneration: number;
  constructor(expectedGeneration: number, actualGeneration: number, context?: Record<string, unknown>) {
    super(
      `Page state changed since last read: expectedStateVersion=${expectedGeneration}, actual=${actualGeneration}. Re-read with bc_read_data to get the current stateVersion, then retry.`,
      'STALE_CONTEXT',
      context,
    );
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
  }
}

export class InvalidBookmarkError extends BCError {
  public readonly bookmark: string;
  constructor(bookmark: string, context?: Record<string, unknown>) {
    super(
      `Bookmark "${bookmark}" is no longer in BC's loaded rows. Re-read the section with bc_read_data to get current bookmarks, then retry.`,
      'INVALID_BOOKMARK',
      context,
    );
    this.bookmark = bookmark;
  }
}

/**
 * Returned when a multi-row selection is applied to an action that Business
 * Central disables for multiple records on this page. BC computes action
 * enablement server-side (decompiled `ActionControl.Enabled` = `Action.CanInvoke`)
 * and pushes an `Enabled=false` PropertyChanged after the selection — the same
 * signal the web client uses to grey out the button. Verified live: the Customer
 * list (page 22) keeps Delete enabled for a single row but disables it once
 * 2+ rows are selected, whereas setup lists (Payment Terms, Countries/Regions)
 * keep it enabled. Detecting this replaces the old silent no-op (BC ignores an
 * invoke of a disabled action, so the action returned success with no deletion).
 */
export class MultiRowActionUnavailableError extends BCError {
  public readonly actionName: string;
  public readonly selectionCount: number;
  constructor(actionName: string, selectionCount: number, context?: Record<string, unknown>) {
    super(
      `Business Central disables '${actionName}' for a ${selectionCount}-row selection on this page. ` +
        `Some pages (e.g. the Customer list) forbid multi-record ${actionName.toLowerCase()}. ` +
        `Retry with a single bookmark, or perform the action one row at a time.`,
      'MULTI_ROW_ACTION_UNAVAILABLE',
      context,
    );
    this.actionName = actionName;
    this.selectionCount = selectionCount;
  }
}

const ERROR_HINTS: Record<string, string> = {
  VALIDATION_ERROR: 'Correct the field value(s) and retry with bc_write_data.',
  BUSINESS_ERROR: 'BC rejected the operation. Read the message, adjust inputs, and retry.',
  SESSION_LOST: 'The session was reconnected. Re-open any pages with bc_open_page, then retry.',
  MODAL_RECONCILE_ERROR: 'A stuck modal was cleared by resetting the session. Re-open the page and retry.',
  TIMEOUT_ERROR: 'BC did not respond in time. Retry; if it persists the operation may be too heavy.',
  CARDPART_STUB: 'This page is a CardPart stub when opened standalone. See the hostHint in this error and open that host page instead.',
  STALE_CONTEXT: 'The page changed since you last read it (stateVersion mismatch). Re-read with bc_read_data to get the current stateVersion, then retry.',
  INVALID_BOOKMARK: 'The anchor bookmark is no longer loaded in BC. Re-read the section with bc_read_data and retry with a current bookmark.',
  MULTI_ROW_ACTION_UNAVAILABLE: 'This page disables the action for multiple selected rows. Retry with a single bookmark, or repeat the action per row.',
  SIGN_IN_REQUIRED: 'Complete Microsoft sign-in in the window that opened (Authenticator number matching), then retry this tool. If no window appeared, run the MCP on a machine with a display or run `npx business-central-mcp login` with the same `STATE_DIR`.',
  OAUTH_NOT_CONFIGURED: 'bc_query on BC Online needs BC_CLIENT_ID set to a multi-tenant public Entra app (delegated user_impersonation). If it is set, check the server logs. UI tools do not need this.',
  DEVICE_LOGIN_REQUIRED: 'Show the user the sign-in URL and code from this message. After they complete sign-in, retry this tool — it picks up the pending sign-in automatically.',
  URL_ELICITATION_REQUIRED: 'The host must open the sign-in page. Retry the tool after completing sign-in.',
};

/**
 * Returns a short, actionable hint for an MCP caller given an error code.
 * Returns `undefined` for codes that have no registered hint (e.g. PROTOCOL_ERROR,
 * CONNECTION_ERROR) — callers should show the raw error message in that case.
 */
export function errorHint(code: string): string | undefined {
  return ERROR_HINTS[code];
}
