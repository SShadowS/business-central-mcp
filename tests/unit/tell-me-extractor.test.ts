// tests/unit/tell-me-extractor.test.ts
//
// Drives the extractor over a frozen wire fixture from BC28 BUSINESS MANAGER
// profile, query "customer". See src/protocol/captures/README.md.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTellMeResults, extractTellMeRow } from '../../src/services/tell-me-extractor.js';
import type { BCEvent } from '../../src/protocol/types.js';

const fixturePath = resolve(__dirname, '../../src/protocol/captures/tell-me-result-2026-04-28.json');
const fixtureEvents = JSON.parse(readFileSync(fixturePath, 'utf8')) as BCEvent[];

describe('extractTellMeResults — fixture', () => {
  const results = extractTellMeResults(fixtureEvents);

  // The fixture contains TWO DataLoaded streams (server:c[1] = primary
  // search results, 23 rows; server:c[2] = secondary results, 32 rows).
  // The extractor processes both -- BC's Tell Me web UI surfaces results
  // from both repeaters, so the MCP client sees the union (55 rows).
  it('extracts 55 rows from the customer query fixture', () => {
    expect(results.length).toBe(55);
  });

  it('every result has a non-empty name', () => {
    for (const r of results) {
      expect(r.name).toBeTruthy();
    }
  });

  it('every result has objectType from { page, report }', () => {
    for (const r of results) {
      expect(['page', 'report']).toContain(r.objectType);
    }
  });

  it('runTarget matches the BC AL name', () => {
    // BC's Tell Me decouples display name from AL name: row name="Customers"
    // surfaces the Customer List page (AL name "Customer List").
    const customerList = results.find(r => r.runTarget === 'Customer List');
    expect(customerList).toBeDefined();
    expect(customerList!.objectType).toBe('page');
    expect(customerList!.name).toBe('Customers');
  });

  // The CacheKey cell is `<pageId>:...` (decompiled CacheKeyHelper.CalculateCacheKeyCore,
  // invariant culture); reports have none. Live cronus29: "Customers" -> 22:embedded(False).
  it('gives every page result its numeric pageId from the CacheKey, reports none', () => {
    expect(results.find(r => r.runTarget === 'Customer Contracts')!.pageId).toBe(8053);
    expect(results.find(r => r.runTarget === 'Imported Customer Contracts')!.pageId).toBe(8013);
    for (const r of results) {
      if (r.objectType === 'page') expect(Number.isInteger(r.pageId)).toBe(true);
      else expect(r).not.toHaveProperty('pageId');
    }
  });

  it('parses score, departmentPath, category', () => {
    const customerList = results.find(r => r.runTarget === 'Customer List');
    expect(customerList!.category).toBeTruthy();
    expect(customerList!.departmentPath).toBeTruthy();
    expect(typeof customerList!.score).toBe('number');
    expect(customerList!.score! > 0).toBe(true);
  });
});

describe('extractTellMeRow — robustness', () => {
  it('returns null on null input', () => {
    expect(extractTellMeRow(null)).toBeNull();
  });

  it('returns null on missing DataRowInserted', () => {
    expect(extractTellMeRow({})).toBeNull();
  });

  it('returns null on malformed DataRowInserted', () => {
    expect(extractTellMeRow({ DataRowInserted: 'not-an-array' })).toBeNull();
  });

  it('returns null when cells.Source is missing', () => {
    expect(extractTellMeRow({ DataRowInserted: [0, { cells: { Name: { stringValue: 'X' } } }] })).toBeNull();
  });

  it('returns null when Source.stringValue is not parseable JSON', () => {
    expect(extractTellMeRow({
      DataRowInserted: [0, { cells: {
        Name: { stringValue: 'X' },
        Source: { stringValue: 'not json' },
      }}],
    })).toBeNull();
  });

  it('handles report Source format', () => {
    const row = {
      DataRowInserted: [0, { cells: {
        Name: { stringValue: 'Trial Balance' },
        Source: { stringValue: '[{ "report": "Trial Balance"}]' },
        DepartmentCategory: { stringValue: 'Reports' },
        SearchScore: { stringValue: '5' },
      }}],
    };
    const result = extractTellMeRow(row);
    expect(result).not.toBeNull();
    expect(result!.objectType).toBe('report');
    expect(result!.runTarget).toBe('Trial Balance');
    expect(result!.score).toBe(5);
  });
});

describe('extractTellMeResults — empty', () => {
  it('returns [] for events with no DataLoaded', () => {
    expect(extractTellMeResults([
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ])).toEqual([]);
  });

  it('returns [] for empty DataLoaded.rows', () => {
    expect(extractTellMeResults([
      { type: 'DataLoaded', formId: 'X', controlPath: 'p', currentRowOnly: false, rows: [] },
    ])).toEqual([]);
  });
});
