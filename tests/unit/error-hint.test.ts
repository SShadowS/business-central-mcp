import { describe, it, expect } from 'vitest';
import { errorHint } from '../../src/core/errors.js';

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

  it('returns undefined for unknown codes', () => {
    expect(errorHint('PROTOCOL_ERROR')).toBeUndefined();
    expect(errorHint('NOPE')).toBeUndefined();
    expect(errorHint('')).toBeUndefined();
  });
});
