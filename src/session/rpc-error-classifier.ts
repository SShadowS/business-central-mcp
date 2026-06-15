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
 * This is a pure function with no side effects, intentionally kept
 * separate from BCSession so it can be unit-tested without any session state.
 */
export function isFatalRpcError(message: string): boolean {
  return message.includes('InvalidSessionException') || message.includes('"code":1');
}
