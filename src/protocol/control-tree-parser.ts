import type { ControlField, RepeaterColumn, RepeaterState, ActionInfo } from './types.js';

export interface ParsedControlTree {
  caption: string;
  pageType: 'Card' | 'List' | 'Document' | 'Unknown';
  fields: ControlField[];
  repeater: RepeaterState | null;
  actions: ActionInfo[];
  metadata?: { id: number; sourceTableId: number };
}

const FIELD_TYPES = new Set(['sc', 'dc', 'bc', 'dtc', 'i32c', 'sec', 'pc']);

const PAGE_TYPE_MAP: Record<number, ParsedControlTree['pageType']> = {
  0: 'Card',
  1: 'List',
  2: 'Document',
};

/**
 * Parse a BC control tree (the `lf` root node from FormCreated.controlTree)
 * and extract fields, repeater columns, actions, and page metadata.
 */
export function parseControlTree(controlTree: unknown): ParsedControlTree {
  const result: ParsedControlTree = {
    caption: '',
    pageType: 'Unknown',
    fields: [],
    repeater: null,
    actions: [],
  };

  if (!controlTree || typeof controlTree !== 'object') return result;
  const root = controlTree as Record<string, unknown>;

  // Extract root metadata from the lf node
  result.caption = (root.Caption as string) ?? '';
  const pageTypeNum = root.PageType as number | undefined;
  if (pageTypeNum !== undefined && pageTypeNum in PAGE_TYPE_MAP) {
    result.pageType = PAGE_TYPE_MAP[pageTypeNum]!;
  }

  if (root.Metadata && typeof root.Metadata === 'object') {
    const meta = root.Metadata as Record<string, unknown>;
    result.metadata = {
      id: (meta.id as number) ?? 0,
      sourceTableId: (meta.sourceTableId as number) ?? 0,
    };
  }

  // Walk the tree starting from root Children
  const children = root.Children as unknown[] | undefined;
  if (Array.isArray(children)) {
    walkChildren(children, 'server:c[0]', result);
  }

  return result;
}

function walkChildren(children: unknown[], parentPath: string, result: ParsedControlTree): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    const t = node.t as string | undefined;
    if (!t) continue;

    const controlPath = `${parentPath}/c[${i}]`;

    if (FIELD_TYPES.has(t)) {
      extractField(node, t, controlPath, result);
    } else if (t === 'ac') {
      extractAction(node, controlPath, result);
    } else if (t === 'rc' && result.repeater === null) {
      // Use the first repeater found (the main page repeater).
      // Subsequent rc nodes are typically from embedded sub-pages.
      extractRepeater(node, controlPath, result);
    }

    // Recurse into Children (gc groups, etc.)
    const subChildren = node.Children as unknown[] | undefined;
    if (Array.isArray(subChildren)) {
      walkChildren(subChildren, controlPath, result);
    }
  }
}

function extractField(
  node: Record<string, unknown>,
  t: string,
  controlPath: string,
  result: ParsedControlTree,
): void {
  // Skip placeholder fields
  if (node.MappingHint === 'PlaceholderField') return;

  // Determine visibility: check direct Visible, then ExpressionProperties.Visible
  let visible = true;
  if (typeof node.Visible === 'boolean') {
    visible = node.Visible;
  } else if (node.ExpressionProperties && typeof node.ExpressionProperties === 'object') {
    const expr = node.ExpressionProperties as Record<string, unknown>;
    if (typeof expr.Visible === 'boolean') {
      visible = expr.Visible;
    }
  }

  const binder = node.ColumnBinder as { Name?: string } | undefined;

  result.fields.push({
    controlPath,
    caption: (node.Caption as string) ?? '',
    type: t,
    editable: (node.Editable as boolean) ?? false,
    visible,
    stringValue: node.StringValue != null ? String(node.StringValue) : undefined,
    value: node.ObjectValue ?? node.StringValue,
    columnBinderName: binder?.Name || undefined,
  });
}

function extractAction(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
): void {
  result.actions.push({
    controlPath,
    caption: (node.Caption as string) ?? '',
    systemAction: (node.SystemAction as number) ?? 0,
    enabled: (node.Enabled as boolean) ?? true,
    visible: (node.Visible as boolean) ?? true,
  });
}

function extractRepeater(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
): void {
  const columns: RepeaterColumn[] = [];
  const rccArray = node.Columns as unknown[] | undefined;
  if (Array.isArray(rccArray)) {
    for (let j = 0; j < rccArray.length; j++) {
      const col = rccArray[j] as Record<string, unknown> | undefined;
      if (!col || col.t !== 'rcc') continue;
      // Skip placeholder columns
      if (col.MappingHint === 'PlaceholderField') continue;

      columns.push({
        controlPath: `${controlPath}/co[${j}]`,
        caption: (col.Caption as string) ?? '',
        type: 'rcc',
        columnBinderPath: (col.ColumnBinderPath as string) || undefined,
      });
    }
  }

  result.repeater = {
    controlPath,
    columns,
    rows: [],       // Rows come from DataLoaded events, not the control tree
    totalRowCount: 0,
  };
}
