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
export function mapRowCellKeys(rows: RepeaterRow[], columns: RepeaterColumn[]): RepeaterRow[] {
  const binderMap = buildBinderToCaptionMap(columns);
  return rows.map(row => ({
    bookmark: row.bookmark,
    cells: remapCells(row.cells, binderMap),
  }));
}

export function remapCells(
  cells: Record<string, unknown>,
  binderMap: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(cells)) {
    const caption = binderMap.get(key) ?? key;
    // Extract the display value from BC's cell structure
    // BC sends cells as objects like { stringValue: "...", objectValue: ..., editable: ..., ... }
    if (rawValue && typeof rawValue === 'object') {
      const cell = rawValue as Record<string, unknown>;
      // Prefer stringValue (formatted), fall back to objectValue (raw), then null for empty cells
      result[caption] = cell.stringValue ?? cell.objectValue ?? null;
    } else {
      result[caption] = rawValue;
    }
  }
  return result;
}
