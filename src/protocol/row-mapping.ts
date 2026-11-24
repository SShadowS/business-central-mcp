// src/protocol/row-mapping.ts
//
// Pure helpers that translate BC repeater row cells from columnBinderName
// keys (e.g. "1165569367_c2") to display-caption keys for MCP output.
// Lives in protocol/ because both protocol-level adapters (section-dto.ts)
// and service-level code (data-service.ts) read these.

import type { RepeaterRow, RepeaterColumn } from './types.js';

/**
 * Build a mapping from columnBinderName to column caption.
 * Used to remap row.cells keys from internal binder names to human-readable captions.
 */
export function buildBinderToCaptionMap(columns: RepeaterColumn[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedCaptions = new Set<string>();
  for (const col of columns) {
    if (!col.columnBinderName) continue;
    let caption = col.caption || col.columnBinderName;
    // Disambiguate duplicate captions with an ordinal suffix, skipping any
    // suffix that collides with a caption already assigned (e.g. a real "Qty#2").
    if (usedCaptions.has(caption)) {
      let n = 2;
      while (usedCaptions.has(`${caption}#${n}`)) n++;
      caption = `${caption}#${n}`;
    }
    usedCaptions.add(caption);
    map.set(col.columnBinderName, caption);
  }
  return map;
}

/**
 * Remap row cell keys from columnBinderName to caption.
 * Cell values are extracted: if value is an object with stringValue, use that.
 */
export function mapRowCellKeys(rows: RepeaterRow[], columns: RepeaterColumn[]): Array<{ bookmark: string; cells: Record<string, string | null> }> {
  const binderMap = buildBinderToCaptionMap(columns);
  return rows.map(row => ({
    bookmark: row.bookmark,
    cells: remapCells(row.cells, binderMap),
  }));
}

export function remapCells(
  cells: Record<string, unknown>,
  binderMap: Map<string, string>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, rawValue] of Object.entries(cells)) {
    // A picture cell ({ type: 'image', objectValue: <media guid>, source: 'img?sessionid=...' },
    // live cronus29 page 22 "Image") carries no data an agent can use, and its source URL
    // embeds the session id.
    if (rawValue && typeof rawValue === 'object' && (rawValue as { type?: unknown }).type === 'image') continue;
    result[binderMap.get(key) ?? key] = cellDisplay(rawValue);
  }
  return result;
}

/**
 * One form for every cell: BC's display string, or null when the cell is empty. BC omits
 * stringValue for a blanked zero ({ objectValue: 0 }, BlankZero) and some selections
 * ({ objectValue: false }), so those are formatted here the way the column shows them elsewhere.
 */
export function cellDisplay(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue !== 'object') return rawValue === '' ? null : String(rawValue);
  const cell = rawValue as { stringValue?: unknown; objectValue?: unknown };
  if (typeof cell.stringValue === 'string') return cell.stringValue === '' ? null : cell.stringValue;
  if (typeof cell.objectValue === 'boolean') return cell.objectValue ? 'Yes' : 'No';
  if (typeof cell.objectValue === 'number' || typeof cell.objectValue === 'string') return String(cell.objectValue);
  return null;
}
