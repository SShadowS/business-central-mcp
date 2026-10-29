import {
  ToolboxError,
  errorBody,
  type ErrorBody,
  type ErrorDetails,
  type ErrorCategory,
} from '@sshadows/bc-toolbox-envelope';
import {
  errorHint,
  SessionLostError,
  BusinessValidationError,
  BusinessError,
  CardPartStubError,
  StaleContextError,
  InvalidBookmarkError,
  MultiRowActionUnavailableError,
  SignInRequiredError,
  DeviceLoginRequiredError,
  ConnectionError,
  DataQueryUnavailableError,
} from '../core/errors.js';

/**
 * The BC-specific error codes that are NOT folded into a Toolbox core code.
 * This is the exact argument to `errorBodySchema(...)` in the contract test:
 * the body the server EMITS must carry a code in `core ∪ BC_EXTENSION_CODES`.
 */
export const BC_EXTENSION_CODES = [
  'VALIDATION_ERROR',
  'BUSINESS_ERROR',
  'SESSION_LOST',
  'MODAL_RECONCILE_ERROR',
  'CARDPART_STUB',
  'STALE_CONTEXT',
  'INVALID_BOOKMARK',
  'MULTI_ROW_ACTION_UNAVAILABLE',
  'SIGN_IN_REQUIRED',
  'OAUTH_NOT_CONFIGURED',
  'DEVICE_LOGIN_REQUIRED',
  'ABORTED_ERROR',
  'OPERATION_ID_REUSED',
  'OPERATION_IN_DOUBT',
  'TEST_RUNNER_NOT_INSTALLED',
  'DATA_QUERY_UNAVAILABLE',
  'DATA_QUERY_ERROR',
] as const;

interface Rule {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
}

/**
 * Maps a BCError's original UPPER_SNAKE code to the code/category/retryable the
 * envelope emits. A code is folded to a Toolbox CORE code only when it is an
 * exact cross-tool synonym with no server-specific payload to preserve;
 * otherwise the original code is kept as an extension code (so a registered
 * `errorHint` and any caller that branches on the code still work).
 */
const RULES: Record<string, Rule> = {
  INPUT_VALIDATION_ERROR: { code: 'INVALID_ARGUMENT', category: 'validation', retryable: false },
  CONNECTION_ERROR: { code: 'ENDPOINT_UNREACHABLE', category: 'network', retryable: true },
  AUTHENTICATION_ERROR: { code: 'AUTHENTICATION_FAILED', category: 'auth', retryable: false },
  TIMEOUT_ERROR: { code: 'TIMEOUT', category: 'network', retryable: true },
  CONFIG_ERROR: { code: 'CONFIGURATION_ERROR', category: 'configuration', retryable: false },
  PROTOCOL_ERROR: { code: 'PROTOCOL_ERROR', category: 'protocol', retryable: false },
  COMPANY_NOT_FOUND: { code: 'NOT_FOUND', category: 'validation', retryable: false },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', category: 'validation', retryable: false },
  BUSINESS_ERROR: { code: 'BUSINESS_ERROR', category: 'server', retryable: false },
  SESSION_LOST: { code: 'SESSION_LOST', category: 'network', retryable: true },
  MODAL_RECONCILE_ERROR: { code: 'MODAL_RECONCILE_ERROR', category: 'state', retryable: true },
  CARDPART_STUB: { code: 'CARDPART_STUB', category: 'state', retryable: false },
  STALE_CONTEXT: { code: 'STALE_CONTEXT', category: 'state', retryable: true },
  INVALID_BOOKMARK: { code: 'INVALID_BOOKMARK', category: 'state', retryable: true },
  MULTI_ROW_ACTION_UNAVAILABLE: { code: 'MULTI_ROW_ACTION_UNAVAILABLE', category: 'validation', retryable: false },
  SIGN_IN_REQUIRED: { code: 'SIGN_IN_REQUIRED', category: 'auth', retryable: true },
  OAUTH_NOT_CONFIGURED: { code: 'OAUTH_NOT_CONFIGURED', category: 'configuration', retryable: false },
  DEVICE_LOGIN_REQUIRED: { code: 'DEVICE_LOGIN_REQUIRED', category: 'auth', retryable: true },
  ABORTED_ERROR: { code: 'ABORTED_ERROR', category: 'server', retryable: true },
  OPERATION_ID_REUSED: { code: 'OPERATION_ID_REUSED', category: 'validation', retryable: false },
  OPERATION_IN_DOUBT: { code: 'OPERATION_IN_DOUBT', category: 'state', retryable: false },
  TEST_RUNNER_NOT_INSTALLED: { code: 'TEST_RUNNER_NOT_INSTALLED', category: 'configuration', retryable: false },
  DATA_QUERY_UNAVAILABLE: { code: 'DATA_QUERY_UNAVAILABLE', category: 'configuration', retryable: false },
  // BC rejected the request (AL compile error, unknown table, ...): fix the input.
  DATA_QUERY_ERROR: { code: 'DATA_QUERY_ERROR', category: 'validation', retryable: false },
};

const FALLBACK: Rule = { code: 'INTERNAL_ERROR', category: 'internal', retryable: false };

/** nextSteps fallback for core codes that carry no registered errorHint. */
const DEFAULT_NEXT: Record<string, string> = {
  INVALID_ARGUMENT: 'Fix the arguments and call the tool again.',
  ENDPOINT_UNREACHABLE: 'Check the BC endpoint is reachable, then retry.',
  AUTHENTICATION_FAILED: 'Check the BC credentials/config, then retry.',
  CONFIGURATION_ERROR: 'Fix the server configuration, then retry.',
  PROTOCOL_ERROR: 'Retry; if it persists, capture the frame and file an issue.',
  NOT_FOUND: 'The target does not exist or is not accessible. Verify the identifier and retry.',
  ABORTED_ERROR: 'The operation was aborted; the change may or may not have landed. Read the record back, then retry under a new operationId.',
  INTERNAL_ERROR: 'Unexpected server error. Retry; if it persists, check the server logs.',
};

/** Scalar extras pulled off a rich BCError (arrays/objects -> JSON strings). */
function detailsFor(e: unknown, originalCode?: string): ErrorDetails {
  const d: ErrorDetails = {};
  if (originalCode) d.bcCode = originalCode;
  if (e instanceof SessionLostError) {
    d.impactedPageContextIds = JSON.stringify(e.impactedPageContextIds);
    d.reconnectFailed = e.reconnectFailed;
  } else if (e instanceof BusinessValidationError) {
    d.fieldErrors = JSON.stringify(e.fieldErrors);
  } else if (e instanceof BusinessError) {
    d.severity = e.severity;
    d.source = e.source;
  } else if (e instanceof CardPartStubError) {
    const ctx = e.context ?? {};
    if (typeof ctx.pageId === 'string') d.pageId = ctx.pageId;
    if (typeof ctx.hostHint === 'string') d.hostHint = ctx.hostHint;
  } else if (e instanceof StaleContextError) {
    d.expectedGeneration = e.expectedGeneration;
    d.actualGeneration = e.actualGeneration;
  } else if (e instanceof InvalidBookmarkError) {
    d.bookmark = e.bookmark;
  } else if (e instanceof MultiRowActionUnavailableError) {
    d.actionName = e.actionName;
    d.selectionCount = e.selectionCount;
  } else if (e instanceof SignInRequiredError) {
    d.openedWindow = e.openedWindow;
    d.reason = e.reason;
  } else if (e instanceof DeviceLoginRequiredError) {
    d.verificationUri = e.verificationUri;
    d.userCode = e.userCode;
    d.expiresAt = e.expiresAt;
  } else if (e instanceof DataQueryUnavailableError) {
    d.reason = e.reason;
  } else if (e instanceof ConnectionError && e.status != null) {
    d.status = e.status;
  }
  return d;
}

/**
 * The ONE formatter. `like` is any {code?, message} — a BCError instance (so the
 * `detailsFor` instanceof branches fire and carry rich fields), a gate failure,
 * or a bare throw. Produces a strict, machine-readable ErrorBody.
 */
export function toBcErrorBody(
  tool: string,
  like: { code?: string; message: string },
  extraDetails?: ErrorDetails,
): ErrorBody {
  const rule = (like.code && RULES[like.code]) || FALLBACK;
  const nextSteps = [
    like instanceof SessionLostError && like.reconnectFailed
      ? 'The session was lost and reconnecting to BC failed. Check that BC is reachable, then retry; re-open any pages with bc_open_page.'
      : (like.code && errorHint(like.code)) || DEFAULT_NEXT[rule.code] || 'Retry the operation.',
  ];
  const details = { ...detailsFor(like, like.code), ...extraDetails };
  return errorBody(
    tool,
    new ToolboxError(rule.code, String(like.message ?? 'Unknown error'), rule.category, rule.retryable, details),
    nextSteps,
  );
}

/** The MCP isError tool result that carries the body (both machine- and human-readable). */
export function bcErrorResult(
  id: unknown,
  tool: string,
  like: { code?: string; message: string },
  extra?: ErrorDetails,
) {
  const body = toBcErrorBody(tool, like, extra);
  return {
    jsonrpc: '2.0' as const,
    id,
    result: {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: true,
    },
  };
}
