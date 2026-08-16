import { describe, it, expect } from 'vitest';
import { errorHint, SignInRequiredError, UrlElicitationRequiredError } from '../../src/core/errors.js';

describe('errorHint', () => {
  it('maps VALIDATION_ERROR', () => {
    expect(errorHint('VALIDATION_ERROR')).toBe(
      'Correct the field value(s) and retry with bc_write_data.',
    );
  });

  it('maps BUSINESS_ERROR', () => {
    expect(errorHint('BUSINESS_ERROR')).toBe(
      'BC rejected the operation. Read the message, adjust inputs, and retry.',
    );
  });

  it('maps SESSION_LOST', () => {
    expect(errorHint('SESSION_LOST')).toBe(
      'The session was reconnected. Re-open any pages with bc_open_page, then retry.',
    );
  });

  it('maps MODAL_RECONCILE_ERROR', () => {
    expect(errorHint('MODAL_RECONCILE_ERROR')).toBe(
      'A stuck modal was cleared by resetting the session. Re-open the page and retry.',
    );
  });

  it('maps TIMEOUT_ERROR', () => {
    expect(errorHint('TIMEOUT_ERROR')).toBe(
      'BC did not respond in time. Retry; if it persists the operation may be too heavy.',
    );
  });

  it('maps CARDPART_STUB', () => {
    expect(errorHint('CARDPART_STUB')).toBe(
      'This page is a CardPart stub when opened standalone. See the hostHint in this error and open that host page instead.',
    );
  });

  it('maps STALE_CONTEXT', () => {
    expect(errorHint('STALE_CONTEXT')).toBe(
      'The page changed since you last read it (stateVersion mismatch). Re-read with bc_read_data to get the current stateVersion, then retry.',
    );
  });

  it('maps SIGN_IN_REQUIRED and constructs SignInRequiredError with that code', () => {
    expect(errorHint('SIGN_IN_REQUIRED')).toMatch(/sign-in|Authenticator|login/i);
    const e = new SignInRequiredError('A display is required to sign in to Business Central Online.', {
      openedWindow: false,
      reason: 'no_display',
    });
    expect(e.code).toBe('SIGN_IN_REQUIRED');
  });

  it('constructs UrlElicitationRequiredError with mode url', () => {
    const e = new UrlElicitationRequiredError([{
      mode: 'url',
      elicitationId: '00000000-0000-0000-0000-000000000001',
      url: 'http://127.0.0.1:1/?k=test',
      message: 'Sign in to Business Central in the window that opened.',
    }]);
    expect(e.code).toBe('URL_ELICITATION_REQUIRED');
    expect(e.elicitations[0]?.mode).toBe('url');
  });

  it('maps OAUTH_NOT_CONFIGURED', () => {
    expect(errorHint('OAUTH_NOT_CONFIGURED')).toMatch(/devicelogin|device-code/i);
  });

  it('returns undefined for unknown codes', () => {
    expect(errorHint('PROTOCOL_ERROR')).toBeUndefined();
    expect(errorHint('NOPE')).toBeUndefined();
    expect(errorHint('')).toBeUndefined();
  });
});
