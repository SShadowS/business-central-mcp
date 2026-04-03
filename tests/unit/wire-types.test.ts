import { describe, it, expect } from 'vitest';
import { resolveChangeType } from '../../src/protocol/wire-types.js';

describe('resolveChangeType', () => {
  it('resolves abbreviated types', () => {
    expect(resolveChangeType('drch')).toBe('DataRefreshChange');
    expect(resolveChangeType('drich')).toBe('DataRowInserted');
    expect(resolveChangeType('lcpchs')).toBe('PropertyChanges');
    expect(resolveChangeType('drbch')).toBe('DataRowBookmarkChange');
  });

  it('resolves full names', () => {
    expect(resolveChangeType('DataRefreshChange')).toBe('DataRefreshChange');
    expect(resolveChangeType('PropertyChanges')).toBe('PropertyChanges');
  });

  it('returns undefined for unknown types', () => {
    expect(resolveChangeType('unknown')).toBeUndefined();
  });
});
