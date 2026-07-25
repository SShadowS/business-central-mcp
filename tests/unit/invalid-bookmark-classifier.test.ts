import { describe, it, expect } from 'vitest';
import { isInvalidBookmarkError } from '../../src/session/rpc-error-classifier.js';
import { InvalidBookmarkError, errorHint } from '../../src/core/errors.js';

describe('isInvalidBookmarkError', () => {
  it('matches a BC InvalidBookmarkException message', () => {
    expect(isInvalidBookmarkError('...Microsoft.Dynamics...InvalidBookmarkException: bad bookmark')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isInvalidBookmarkError('LogicalModalityViolationException')).toBe(false);
    expect(isInvalidBookmarkError('some other error')).toBe(false);
  });
});

describe('InvalidBookmarkError', () => {
  it('carries code INVALID_BOOKMARK and re-read guidance', () => {
    const e = new InvalidBookmarkError('BK9');
    expect(e.code).toBe('INVALID_BOOKMARK');
    expect(e.message).toMatch(/loaded|re-read/i);
    expect(errorHint('INVALID_BOOKMARK')).toBeTruthy();
  });
});
