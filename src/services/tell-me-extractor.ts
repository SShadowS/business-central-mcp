// src/services/tell-me-extractor.ts
//
// Decodes BC Tell Me (page-search) DataLoaded rows into structured
// SearchResult records. The wire shape was captured live from BC28
// (BUSINESS MANAGER profile, query 'customer') -- see
// src/protocol/captures/README.md for the row-layout details.
//
// Cell shape: rows are KEYED by named cells (not positional binders).
// Run-target is in cells.Source.stringValue as JSON: `[{ "page": "..." }]`
// or `[{ "report": "..." }]`. BC identifies pages by AL name, not numeric id.

import type { BCEvent } from '../protocol/types.js';
import { resolveChangeType } from '../protocol/wire-types.js';
import type { SearchResult } from './search-service.js';

interface CellValue {
  readonly stringValue?: string;
}

function readCellString(cells: Record<string, unknown>, key: string): string | undefined {
  const cell = cells[key];
  if (!cell || typeof cell !== 'object') return undefined;
  const sv = (cell as CellValue).stringValue;
  return typeof sv === 'string' && sv.length > 0 ? sv : undefined;
}

function parseSource(stringValue: string): { objectType: string; runTarget: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stringValue);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (!first || typeof first !== 'object') return null;
  const entries = Object.entries(first as Record<string, unknown>);
  if (entries.length === 0) return null;
  const [objectType, runTarget] = entries[0]!;
  if (typeof runTarget !== 'string') return null;
  return { objectType, runTarget };
}

/**
 * Extract a single Tell Me row's structured SearchResult. Returns null when
 * the payload doesn't match the expected shape -- callers iterating a row
 * collection should skip nulls silently.
 */
export function extractTellMeRow(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Row payloads may arrive under the long-name key OR the abbreviated wire
  // tag (e.g. 'DataRowInserted' vs 'drich') -- resolve via the wire-types map.
  const rowKey = Object.keys(r).find(k => {
    const resolved = resolveChangeType(k);
    return resolved === 'DataRowInserted' || resolved === 'DataRowUpdated';
  });
  const dataRow: unknown = rowKey !== undefined ? r[rowKey] : undefined;
  if (!Array.isArray(dataRow) || dataRow.length < 2) return null;
  const payload = dataRow[1];
  if (!payload || typeof payload !== 'object') return null;
  const cells = (payload as Record<string, unknown>).cells;
  if (!cells || typeof cells !== 'object') return null;

  const cellMap = cells as Record<string, unknown>;
  const name = readCellString(cellMap, 'Name');
  if (!name) return null;

  const sourceString = readCellString(cellMap, 'Source');
  if (!sourceString) return null;
  const source = parseSource(sourceString);
  if (!source) return null;

  const result: SearchResult = {
    name,
    objectType: source.objectType,
    runTarget: source.runTarget,
  };

  const departmentPath = readCellString(cellMap, 'DepartmentPath');
  if (departmentPath) (result as { departmentPath?: string }).departmentPath = departmentPath;

  const category = readCellString(cellMap, 'DepartmentCategory');
  if (category) (result as { category?: string }).category = category;

  const scoreString = readCellString(cellMap, 'SearchScore');
  if (scoreString) {
    const n = parseInt(scoreString, 10);
    if (!Number.isNaN(n)) (result as { score?: number }).score = n;
  }

  return result;
}

/**
 * Extract all Tell Me search results from a DataLoaded-bearing event stream.
 * Non-DataLoaded events are ignored. Malformed rows are silently skipped.
 */
export function extractTellMeResults(events: BCEvent[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const event of events) {
    if (event.type !== 'DataLoaded') continue;
    for (const raw of event.rows) {
      const result = extractTellMeRow(raw);
      if (result) out.push(result);
    }
  }
  return out;
}
