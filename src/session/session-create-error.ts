import {
  AuthenticationError,
  ConnectionError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../core/errors.js';

export type SessionCreateError =
  | ConnectionError
  | AuthenticationError
  | SignInRequiredError
  | UrlElicitationRequiredError;

export function isNonRetryableSessionCreateError(error: { code?: string; context?: Record<string, unknown> }): boolean {
  if (error.code === 'SIGN_IN_REQUIRED' || error.code === 'URL_ELICITATION_REQUIRED') return true;
  return error.code === 'AUTHENTICATION_ERROR' && error.context?.['nonRetryable'] === true;
}
