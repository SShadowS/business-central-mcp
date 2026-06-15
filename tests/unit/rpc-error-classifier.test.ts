// tests/unit/rpc-error-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { isFatalRpcError } from '../../src/session/rpc-error-classifier.js';

describe('isFatalRpcError', () => {
  it('classifies InvalidSessionException as fatal', () => {
    expect(
      isFatalRpcError('Microsoft.Dynamics.Nav.Types.InvalidSessionException: session gone'),
    ).toBe(true);
  });

  it('classifies a payload containing "code":1 as fatal', () => {
    expect(isFatalRpcError('{"error":{"code":1,"message":"session not found"}}')).toBe(true);
  });

  it('does NOT classify LogicalModalityViolationException as fatal', () => {
    expect(
      isFatalRpcError('Microsoft.Dynamics.Nav.Runtime.LogicalModalityViolationException'),
    ).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isFatalRpcError('')).toBe(false);
  });

  it('returns false for an unrelated error message', () => {
    expect(isFatalRpcError('Some unrelated error: timeout while waiting for response')).toBe(false);
  });
});
