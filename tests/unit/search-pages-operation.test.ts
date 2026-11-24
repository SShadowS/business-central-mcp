import { describe, it, expect } from 'vitest';
import { SearchPagesOperation } from '../../src/operations/search-pages.js';
import { ok } from '../../src/core/result.js';
import type { SearchResult } from '../../src/services/search-service.js';

describe('SearchPagesOperation', () => {
  it('returns results without a note when search yields hits', async () => {
    const fakeSearch = {
      search: async () => ok([
        { name: 'Customers', objectType: 'page', runTarget: 'Customer List' } as SearchResult,
      ]),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'customer' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results).toHaveLength(1);
      expect(result.value.note).toBeUndefined();
    }
  });

  it('caps results at limit (default 15) and says when it cut some off', async () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ name: `P${i}`, objectType: 'page', runTarget: `P${i}`, pageId: i + 1 }) as SearchResult);
    const op = new SearchPagesOperation({ search: async () => ok(many) } as never);
    const byDefault = await op.execute({ query: 'x' });
    expect(byDefault.ok && byDefault.value.results).toHaveLength(15);
    expect(byDefault.ok && byDefault.value.truncated).toBe(true);
    const three = await op.execute({ query: 'x', limit: 3 });
    expect(three.ok && three.value.results.map(r => r.name)).toEqual(['P0', 'P1', 'P2']);
    const all = await op.execute({ query: 'x', limit: 50 });
    expect(all.ok && all.value.truncated).toBe(true);
    const few = await new SearchPagesOperation({ search: async () => ok(many.slice(0, 2)) } as never).execute({ query: 'x' });
    expect(few.ok && few.value.truncated).toBe(false);
  });

  it('returns empty results with a profile-hint note when search yields nothing', async () => {
    const fakeSearch = {
      search: async () => ok([] as SearchResult[]),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'asdf' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results).toEqual([]);
      expect(result.value.note).toBeTruthy();
      expect(result.value.note).toMatch(/profile/i);
    }
  });

  it('propagates underlying errors unchanged', async () => {
    const fakeSearch = {
      search: async () => ({ ok: false as const, error: { message: 'BC down', code: 'CONNECTION_ERROR' } as never }),
    };
    const op = new SearchPagesOperation(fakeSearch as never);
    const result = await op.execute({ query: 'customer' });
    expect(result.ok).toBe(false);
  });
});
