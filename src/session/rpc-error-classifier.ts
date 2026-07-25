/**
 * Classifies RPC error messages as fatal (session-killing) or non-fatal.
 *
 * A fatal error means the BC session is irrecoverably invalid and must be
 * torn down. The two known fatal conditions are:
 *
 *  - `InvalidSessionException` – BC's server-side session no longer exists
 *    (expired, restarted, or stolen by another client).
 *  - `"code":1` – the JSON-RPC error payload carries code 1, which BC uses
 *    for session-not-found errors in some response shapes.
 *
 * The code check uses a bounded regex so that code 1 matches exactly:
 * a bare substring test on `"code":1` would also match `"code":10`,
 * `"code":100`, `"code":15041`, etc., misclassifying non-fatal RPC errors
 * as fatal (killing alive sessions), and would miss `"code": 1` with
 * whitespace after the colon.
 *
 * This is a pure function with no side effects, intentionally kept
 * separate from BCSession so it can be unit-tested without any session state.
 */
const FATAL_CODE_1_RE = /"code":\s*1(?=[,}\s])/;

export function isFatalRpcError(message: string): boolean {
  return message.includes('InvalidSessionException') || FATAL_CODE_1_RE.test(message);
}

/**
 * True when an RPC error message is BC's InvalidBookmarkException — the anchor
 * bookmark passed to SetCurrentRowAndRowsSelection is not in BC's loaded rows.
 * Pure; unit-tested without session state.
 */
export function isInvalidBookmarkError(message: string): boolean {
  return message.includes('InvalidBookmarkException');
}
