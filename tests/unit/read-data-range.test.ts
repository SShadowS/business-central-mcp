import { describe, it, expect } from 'vitest';

/**
 * Tests for range slicing and tab filtering logic used in ReadDataOperation.
 * These test the pure logic extracted from the operation, not the full operation
 * (which requires a DataService and FilterService connected to a real session).
 */

describe('range slicing', () => {
  function sliceRows(
    rows: Array<{ bookmark: string; cells: Record<string, unknown> }>,
    range?: { offset: number; limit: number },
  ) {
    if (!range) return rows;
    return rows.slice(range.offset, range.offset + range.limit);
  }

  const sampleRows = Array.from({ length: 10 }, (_, i) => ({
    bookmark: `bk${i}`,
    cells: { Name: `Item ${i}`, No: `${1000 + i}` },
  }));

  it('returns all rows when no range specified', () => {
    const result = sliceRows(sampleRows);
    expect(result.length).toBe(10);
  });

  it('slices from offset with limit', () => {
    const result = sliceRows(sampleRows, { offset: 2, limit: 3 });
    expect(result.length).toBe(3);
    expect(result[0]!.bookmark).toBe('bk2');
    expect(result[2]!.bookmark).toBe('bk4');
  });

  it('returns remaining rows when limit exceeds available', () => {
    const result = sliceRows(sampleRows, { offset: 8, limit: 5 });
    expect(result.length).toBe(2);
    expect(result[0]!.bookmark).toBe('bk8');
    expect(result[1]!.bookmark).toBe('bk9');
  });

  it('returns empty when offset is beyond rows', () => {
    const result = sliceRows(sampleRows, { offset: 20, limit: 5 });
    expect(result.length).toBe(0);
  });

  it('returns first N rows with offset 0', () => {
    const result = sliceRows(sampleRows, { offset: 0, limit: 3 });
    expect(result.length).toBe(3);
    expect(result[0]!.bookmark).toBe('bk0');
  });
});

describe('tab field filtering', () => {
  function filterByTab(
    rows: Array<{ bookmark: string; cells: Record<string, unknown> }>,
    tabFieldCaptions: Set<string>,
  ) {
    return rows.map(r => ({
      bookmark: r.bookmark,
      cells: Object.fromEntries(
        Object.entries(r.cells).filter(([k]) => tabFieldCaptions.has(k.toLowerCase())),
      ),
    }));
  }

  it('filters cells to only tab fields', () => {
    const rows = [
      { bookmark: 'bk1', cells: { Name: 'Alice', City: 'London', Amount: 100 } },
    ];
    const tabFields = new Set(['name', 'city']);
    const result = filterByTab(rows, tabFields);
    expect(Object.keys(result[0]!.cells)).toEqual(['Name', 'City']);
    expect(result[0]!.cells.Name).toBe('Alice');
  });

  it('returns empty cells when no fields match tab', () => {
    const rows = [
      { bookmark: 'bk1', cells: { Amount: 100, Quantity: 5 } },
    ];
    const tabFields = new Set(['name', 'city']);
    const result = filterByTab(rows, tabFields);
    expect(Object.keys(result[0]!.cells)).toEqual([]);
  });

  it('preserves bookmarks during filtering', () => {
    const rows = [
      { bookmark: 'bk1', cells: { Name: 'Alice' } },
      { bookmark: 'bk2', cells: { Name: 'Bob' } },
    ];
    const tabFields = new Set(['name']);
    const result = filterByTab(rows, tabFields);
    expect(result[0]!.bookmark).toBe('bk1');
    expect(result[1]!.bookmark).toBe('bk2');
  });
});
