import { describe, it, expect } from 'vitest';
import { InputValidationError } from '../../src/core/errors.js';
import { validatePageContextId } from '../../src/mcp/page-context-validator.js';

describe('stale page context validation', () => {
  it('returns context when pageContextId is valid', () => {
    const mockRepo = {
      get: (id: string) => id === 'valid-id' ? { pageContextId: 'valid-id', caption: 'Customer List' } : undefined,
      listPageContextSummaries: () => [{ id: 'valid-id', caption: 'Customer List' }],
    } as any;

    const result = validatePageContextId(mockRepo, 'valid-id');
    expect(result.pageContextId).toBe('valid-id');
  });

  it('throws InputValidationError with open pages list when invalid', () => {
    const mockRepo = {
      get: () => undefined,
      listPageContextSummaries: () => [
        { id: 'ctx-1', caption: 'Customer List' },
        { id: 'ctx-2', caption: 'Item Card' },
      ],
    } as any;

    expect(() => validatePageContextId(mockRepo, 'bad-id')).toThrow(InputValidationError);
    try {
      validatePageContextId(mockRepo, 'bad-id');
    } catch (e) {
      expect((e as Error).message).toContain('bad-id');
      expect((e as Error).message).toContain('Customer List');
      expect((e as Error).message).toContain('Item Card');
    }
  });

  it('shows helpful message when no pages are open', () => {
    const mockRepo = {
      get: () => undefined,
      listPageContextSummaries: () => [],
    } as any;

    try {
      validatePageContextId(mockRepo, 'bad-id');
    } catch (e) {
      expect((e as Error).message).toContain('No pages are currently open');
    }
  });
});
