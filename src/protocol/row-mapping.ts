// src/protocol/row-mapping.ts
//
// Pure helpers that translate BC repeater row cells from columnBinderName
// keys (e.g. "1165569367_c2") to output keys for MCP output. By default the
// output key is the column's display caption (language-dependent); callers
// can opt in to keying by the stable AL control name (`DesignName`) instead.
// Lives in protocol/ because both protocol-level adapters (section-dto.ts)
// and service-level code (data-service.ts) read these.

import type { RepeaterRow, RepeaterColumn } from './types.js';
import type { RepeaterColumnNode } from './form-node.js';

/**
 * How row cells (and card fields) are keyed in MCP output.
 * - `caption`: the display caption as shown in the BC client (language-dependent).
 * - `designName`: the AL control name (wire `DesignName`), stable across languages.
 *   Falls back to the caption, then the columnBinderName, when BC sends no DesignName.
 */
export type KeyBy = 'caption' | 'designName';

/**
 * Default keying when the caller does not pass `keyBy`.
 */
export const DEFAULT_KEY_BY: KeyBy = 'caption';

/** Normalise an optional/blank `keyBy` input to a concrete KeyBy. */
export function resolveKeyBy(keyBy: string | undefined | null): KeyBy {
  if (keyBy === 'designName' || keyBy === 'caption') return keyBy;
  return DEFAULT_KEY_BY;
}

/** Project a tree RepeaterColumnNode onto the RepeaterColumn DTO. */
export function repeaterColumnFromNode(c: RepeaterColumnNode): RepeaterColumn {
  return {
    controlPath: c.controlPath,
    caption: c.properties.caption ?? '',
    type: 'rcc',
    columnBinderName: c.columnBinder?.name,
    columnBinderPath: c.columnBinder?.path,
    ...(c.properties.designName ? { designName: c.properties.designName } : {}),
    ...(c.properties.controlIdentifier ? { controlIdentifier: c.properties.controlIdentifier } : {}),
    ...(c.tableFieldNo !== undefined ? { tableFieldNo: c.tableFieldNo } : {}),
    ...(c.properties.visible === false ? { visible: false } : {}),
  };
}

function baseKey(col: RepeaterColumn, keyBy: KeyBy): string {
  if (keyBy === 'designName') return col.designName || col.caption || col.columnBinderName || '';
  return col.caption || col.columnBinderName || '';
}

/**
 * Build a mapping from columnBinderName to output key (caption by default).
 * Used to remap row.cells keys from internal binder names to stable output keys.
 * Duplicate keys are disambiguated with an ordinal suffix ("Qty#2").
 */
export function buildBinderToCaptionMap(
  columns: RepeaterColumn[],
  keyBy: KeyBy = DEFAULT_KEY_BY,
): Map<string, string> {
  const map = new Map<string, string>();
  const usedKeys = new Set<string>();
  // DesignName-backed keys pick first, so a caption fallback never pushes a real DesignName to "#n".
  const ordered = keyBy === 'designName' ? [...columns.filter(c => c.designName), ...columns.filter(c => !c.designName)] : columns;
  for (const col of ordered) {
    if (!col.columnBinderName) continue;
    let key = baseKey(col, keyBy);
    // Disambiguate duplicate keys with an ordinal suffix, skipping any
    // suffix that collides with a key already assigned (e.g. a real "Qty#2").
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}#${n}`)) n++;
      key = `${key}#${n}`;
    }
    usedKeys.add(key);
    map.set(col.columnBinderName, key);
  }
  return map;
}

/** Column metadata entry, optionally returned alongside rows. */
export interface ColumnMetadata {
  /** The key used for this column in row.cells. */
  readonly key: string;
  readonly caption: string;
  readonly designName?: string;
  readonly controlIdentifier?: string;
  readonly tableFieldNo?: number;
  readonly binderPath?: string;
  /** Published Visible state; BC sends no cell values for hidden columns. */
  readonly visible?: boolean;
}

/** Describe each keyed column: its output key plus caption / DesignName / ids. */
export function buildColumnMetadata(
  columns: RepeaterColumn[],
  keyBy: KeyBy = DEFAULT_KEY_BY,
): ColumnMetadata[] {
  const map = buildBinderToCaptionMap(columns, keyBy);
  const out: ColumnMetadata[] = [];
  for (const col of columns) {
    if (!col.columnBinderName) continue;
    out.push({
      key: map.get(col.columnBinderName)!,
      caption: col.caption,
      ...(col.designName ? { designName: col.designName } : {}),
      ...(col.controlIdentifier ? { controlIdentifier: col.controlIdentifier } : {}),
      ...(col.tableFieldNo !== undefined ? { tableFieldNo: col.tableFieldNo } : {}),
      ...(col.columnBinderPath ? { binderPath: col.columnBinderPath } : {}),
      ...(col.visible === false ? { visible: false } : {}),
    });
  }
  return out;
}

/**
 * Remap row cell keys from columnBinderName to caption (or DesignName).
 * Cell values are extracted: if value is an object with stringValue, use that.
 */
export function mapRowCellKeys(
  rows: RepeaterRow[],
  columns: RepeaterColumn[],
  keyBy: KeyBy = DEFAULT_KEY_BY,
): RepeaterRow[] {
  const binderMap = buildBinderToCaptionMap(columns, keyBy);
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

/**
 * Resolve a repeater column by name (case-insensitive), used by filter / sort /
 * line-write resolution. Caption mode (default) matches the caption only,
 * exactly as before. DesignName mode matches the AL DesignName first and
 * falls back to the caption.
 */
export function findColumnNode<T extends RepeaterColumnNode>(
  columns: readonly T[],
  name: string,
  keyBy: KeyBy = DEFAULT_KEY_BY,
): T | undefined {
  const wanted = name.toLowerCase();
  if (keyBy === 'designName') {
    const byDesign = columns.find(c => !!c.properties.designName && c.properties.designName.toLowerCase() === wanted);
    if (byDesign) return byDesign;
  }
  return columns.find(c => (c.properties.caption ?? '').toLowerCase() === wanted);
}

/** Column names for "available columns" diagnostics, in the caller's key space. */
export function availableColumnNames(columns: readonly RepeaterColumnNode[], keyBy: KeyBy = DEFAULT_KEY_BY): string[] {
  return columns
    .map(c => (keyBy === 'designName' ? c.properties.designName || c.properties.caption : c.properties.caption) ?? '')
    .filter(Boolean);
}
