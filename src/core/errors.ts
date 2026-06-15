export abstract class BCError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
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
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'CONNECTION_ERROR', context); }
}
export class AuthenticationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'AUTHENTICATION_ERROR', context); }
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
export class ValidationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'VALIDATION_ERROR', context); }
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

const ERROR_HINTS: Record<string, string> = {
  VALIDATION_ERROR: 'Correct the field value(s) and retry with bc_write_data.',
  BUSINESS_ERROR: 'BC rejected the operation. Read the message, adjust inputs, and retry.',
  SESSION_LOST: 'The session was reconnected. Re-open any pages with bc_open_page, then retry.',
  MODAL_RECONCILE_ERROR: 'A stuck modal was cleared by resetting the session. Re-open the page and retry.',
  TIMEOUT_ERROR: 'BC did not respond in time. Retry; if it persists the operation may be too heavy.',
};

/**
 * Returns a short, actionable hint for an MCP caller given an error code.
 * Returns `undefined` for codes that have no registered hint (e.g. PROTOCOL_ERROR,
 * CONNECTION_ERROR) — callers should show the raw error message in that case.
 */
export function errorHint(code: string): string | undefined {
  return ERROR_HINTS[code];
}
