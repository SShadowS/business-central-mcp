import { describe, it, expect } from 'vitest';
import { isNonRetryableSessionCreateError } from '../../src/session/session-create-error.js';
import {
  AuthenticationError,
  ConnectionError,
  DeviceLoginRequiredError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../../src/core/errors.js';

describe('isNonRetryableSessionCreateError', () => {
  it('fails fast on the sign-in-flow classes', () => {
    expect(isNonRetryableSessionCreateError(
      new SignInRequiredError('x', { openedWindow: true, reason: 'r' }),
    )).toBe(true);
    expect(isNonRetryableSessionCreateError(new UrlElicitationRequiredError([]))).toBe(true);
    expect(isNonRetryableSessionCreateError(
      new DeviceLoginRequiredError('https://x', 'C', Date.now() + 60_000),
    )).toBe(true);
  });

  it('is driven by the class-level authRequired flag, not a code list', () => {
    // A future sign-in-flow class only needs authRequired=true — the same
    // flag bcErrorToHttp maps to 401 — to be recognized here.
    expect(isNonRetryableSessionCreateError({ code: 'FUTURE_SIGN_IN_THING', authRequired: true })).toBe(true);
  });

  it('AuthenticationError is retryable unless explicitly flagged', () => {
    expect(isNonRetryableSessionCreateError(new AuthenticationError('throttle'))).toBe(false);
    expect(isNonRetryableSessionCreateError(
      new AuthenticationError('hard', { nonRetryable: true }),
    )).toBe(true);
  });

  it('connection errors retry', () => {
    expect(isNonRetryableSessionCreateError(new ConnectionError('blip'))).toBe(false);
  });
});
