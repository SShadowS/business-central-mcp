import {
  AuthenticationError,
  ConnectionError,
  DeviceLoginRequiredError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../core/errors.js';

export type SessionCreateError =
  | ConnectionError
  | AuthenticationError
  | DeviceLoginRequiredError
  | SignInRequiredError
  | UrlElicitationRequiredError;

export function isNonRetryableSessionCreateError(
  error: { code?: string; context?: Record<string, unknown>; authRequired?: boolean },
): boolean {
  // AuthenticationError is authRequired yet deliberately retryable unless
  // explicitly flagged: transient sign-in-path failures (an MFA throttle, a
  // dead stored session about to be replaced) retry through the backoff.
  if (error.code === 'AUTHENTICATION_ERROR') return error.context?.['nonRetryable'] === true;
  // Every other sign-in-flow class carries authRequired — the same
  // class-level flag bcErrorToHttp maps to HTTP 401 — so a new sign-in
  // error class needs no registration here.
  return error.authRequired === true;
}
