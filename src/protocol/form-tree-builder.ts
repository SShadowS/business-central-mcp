// src/protocol/form-tree-builder.ts
//
// Builds a FormNode tree from a raw BC `lf` JSON node. Replaces parseControlTree.
//
// Wire-level PageType ordinals come from decompiled
// Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs. Field type strings
// (sc/dc/bc/...) are emitted by Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.

import type {
  FormNode, LogicalFormNode, GroupNode, FieldNode, ActionNode, RepeaterNode,
  RepeaterColumnNode, FormHostNode, FilterNode, StackGroupNode, CueFieldNode,
  UnknownNode, NodeProperties, FieldType,
} from './form-node.js';
import { FIELD_TYPES } from './form-node.js';
import type { PageType } from './types.js';

const PAGE_TYPE_MAP: Record<number, PageType> = {
  0: 'Card', 1: 'List', 2: 'RoleCenter', 3: 'CardPart', 4: 'ListPart',
  5: 'Document', 6: 'Worksheet', 7: 'ListPlus', 8: 'ConfirmationDialog',
  9: 'NavigatePage', 10: 'StandardDialog', 11: 'API', 12: 'HeadlinePart',
  13: 'ReportPreview', 14: 'ReportProcessingOnly', 15: 'XmlPort',
  16: 'ReportViewer', 17: 'FilterPage', 18: 'ListQuery', 19: 'BannerPart',
  20: 'PromptDialog', 21: 'ConfigurationDialog', 22: 'UserControlHost',
};

export function buildFormTree(raw: unknown): FormNode {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`buildFormTree: expected an lf object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const t = obj.t as string | undefined;
  if (t !== 'lf') {
    throw new Error(`buildFormTree: expected lf root, got t=${JSON.stringify(t)}`);
  }
  return buildLogicalForm(obj);
}

function buildLogicalForm(obj: Record<string, unknown>): LogicalFormNode {
  const props = readProperties(obj);
  const children = buildChildren(obj.Children, 'server:', false);
  const metadata = metadataOf(obj);
  return {
    type: 'lf',
    controlPath: 'server:',
    serverId: (obj.ServerId as string) ?? '',
    pageType: pageTypeOf(obj),
    properties: props,
    children,
    ...(metadata ? { metadata } : {}),
  };
}

function pageTypeOf(obj: Record<string, unknown>): PageType {
  const n = obj.PageType as number | undefined;
  if (typeof n === 'number' && n in PAGE_TYPE_MAP) return PAGE_TYPE_MAP[n]!;
  return 'Unknown';
}

function metadataOf(obj: Record<string, unknown>): { id: number; sourceTableId: number } | undefined {
  const m = obj.Metadata as Record<string, unknown> | undefined;
  if (!m) return undefined;
  return {
    id: (m.id as number) ?? 0,
    sourceTableId: (m.sourceTableId as number) ?? 0,
  };
}

function buildChildren(rawChildren: unknown, parentPath: string, insideRepeater: boolean): FormNode[] {
  if (!Array.isArray(rawChildren)) return [];
  const result: FormNode[] = [];
  for (let i = 0; i < rawChildren.length; i++) {
    const child = rawChildren[i];
    if (!child || typeof child !== 'object') continue;
    const sep = parentPath === 'server:' ? '' : '/';
    const path = `${parentPath}${sep}c[${i}]`;
    const built = buildNode(child as Record<string, unknown>, path, insideRepeater);
    if (built.type === '__placeholder__' || built.type === '__spacer__') continue;
    result.push(built);
  }
  return result;
}

function buildNode(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): FormNode {
  const t = obj.t as string | undefined;
  if (!t) return makeUnknown(controlPath, '', readProperties(obj));

  if (t === 'gc') return buildGroup(obj, controlPath, insideRepeater);
  if (t === 'ac') return buildAction(obj, controlPath, insideRepeater);
  if (t === 'rc') return buildRepeater(obj, controlPath);
  if (t === 'fhc') return buildFormHost(obj, controlPath);
  if (t === 'filc') return buildFilter(obj, controlPath);
  if (t === 'stackgc') return buildStackGroup(obj, controlPath, insideRepeater);
  if (t === 'stackc') return buildCueField(obj, controlPath);
  if (FIELD_TYPES.has(t as FieldType)) return buildField(obj, t as FieldType, controlPath);
  return makeUnknown(controlPath, t, readProperties(obj), buildChildren(obj.Children, controlPath, insideRepeater));
}

function buildGroup(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): GroupNode {
  return {
    type: 'gc',
    controlPath,
    properties: readProperties(obj),
    children: buildChildren(obj.Children, controlPath, insideRepeater),
  };
}

function buildField(obj: Record<string, unknown>, t: FieldType, controlPath: string): FieldNode | UnknownNode {
  if (obj.MappingHint === 'PlaceholderField') {
    // Sentinel: buildChildren skips nodes with these synthetic types.
    return makeUnknown(controlPath, '__placeholder__', {});
  }
  if (t === 'ssc' && !obj.Caption && !obj.ColumnBinder) {
    return makeUnknown(controlPath, '__spacer__', {});
  }

  const props = readProperties(obj);
  // ExpressionProperties.Visible fallback when top-level Visible is absent.
  if (props.visible === undefined && obj.ExpressionProperties && typeof obj.ExpressionProperties === 'object') {
    const expr = obj.ExpressionProperties as Record<string, unknown>;
    if (typeof expr.Visible === 'boolean') (props as Record<string, unknown>).visible = expr.Visible;
  }
  const binder = obj.ColumnBinder as { Name?: string; Path?: string } | undefined;
  const hasLookup = !!(obj.AssistEditAction || obj.LookupAction);

  return {
    type: t,
    controlPath,
    properties: props,
    ...(binder?.Name ? { columnBinder: { name: binder.Name, ...(binder.Path ? { path: binder.Path } : {}) } } : {}),
    ...(hasLookup ? { hasLookup: true } : {}),
  };
}

function buildAction(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): ActionNode {
  const icon = obj.Icon as { Identifier?: string } | undefined;
  const sub: ActionNode[] = [];
  const rawChildren = obj.Children;
  if (Array.isArray(rawChildren)) {
    for (let i = 0; i < rawChildren.length; i++) {
      const c = rawChildren[i];
      if (!c || typeof c !== 'object') continue;
      const child = c as Record<string, unknown>;
      if (child.t !== 'ac') continue;
      const sep = controlPath === 'server:' ? '' : '/';
      sub.push(buildAction(child, `${controlPath}${sep}c[${i}]`, insideRepeater));
    }
  }
  return {
    type: 'ac',
    controlPath,
    systemAction: (obj.SystemAction as number) ?? 0,
    properties: readProperties(obj),
    children: sub,
    isLineScoped: insideRepeater,
    ...(icon?.Identifier ? { iconIdentifier: icon.Identifier } : {}),
  };
}

function buildRepeater(obj: Record<string, unknown>, controlPath: string): RepeaterNode {
  const columns: RepeaterColumnNode[] = [];
  const rawCols = obj.Columns;
  if (Array.isArray(rawCols)) {
    for (let j = 0; j < rawCols.length; j++) {
      const col = rawCols[j];
      if (!col || typeof col !== 'object') continue;
      const c = col as Record<string, unknown>;
      if (c.t !== 'rcc') continue;
      if (c.MappingHint === 'PlaceholderField') continue;
      const binder = c.ColumnBinder as { Name?: string; Path?: string } | undefined;
      columns.push({
        type: 'rcc',
        controlPath: `${controlPath}/co[${j}]`,
        properties: readProperties(c),
        ...(binder?.Name ? { columnBinder: { name: binder.Name, ...(binder.Path ? { path: binder.Path } : {}) } } : {}),
      });
    }
  }

  // Build the row-cell template children first so we can index their options.
  const children = buildChildren(obj.Children, controlPath, true);

  // Propagate options from row-cell template FieldNodes (rc.Children with Items)
  // into the matching rcc column by ColumnBinder name. The rcc header nodes do not
  // carry Items directly on the wire — they live on the inner sec/bc template child.
  // Reference: live BC28 wire capture (cuegroup-rolecenter-2026-04-28.json) —
  // rc.Children sec nodes carry Items + ColumnBinder matching the rcc ColumnBinder.
  if (children.length > 0 && columns.length > 0) {
    // Build a map: binderName -> options from children that have Items.
    const optionsByBinder = new Map<string, ReadonlyArray<{ readonly text: string; readonly value: string }>>();
    for (const child of children) {
      if (!('columnBinder' in child) || !child.columnBinder?.name) continue;
      if (!child.properties.options) continue;
      optionsByBinder.set(child.columnBinder.name, child.properties.options);
    }
    if (optionsByBinder.size > 0) {
      for (let k = 0; k < columns.length; k++) {
        const col = columns[k]!;
        const binderName = col.columnBinder?.name;
        if (!binderName) continue;
        const opts = optionsByBinder.get(binderName);
        if (!opts) continue;
        // Merge options into the rcc column properties (immutable update).
        columns[k] = {
          ...col,
          properties: { ...col.properties, options: opts },
        };
      }
    }
  }

  return {
    type: 'rc',
    controlPath,
    properties: readProperties(obj),
    columns,
    children,
  };
}

function buildFormHost(obj: Record<string, unknown>, controlPath: string): FormHostNode {
  const children = obj.Children as unknown[] | undefined;
  const lf = (Array.isArray(children) && children[0] && typeof children[0] === 'object')
    ? children[0] as Record<string, unknown>
    : undefined;
  return {
    type: 'fhc',
    controlPath,
    properties: readProperties(obj),
    hostedFormServerId: (lf?.ServerId as string) ?? '',
    hostedFormCaption: (lf?.Caption as string) ?? (obj.Caption as string) ?? '',
    hostedFormIsSubForm: (lf?.IsSubForm as boolean) ?? false,
    hostedFormIsPart: (lf?.IsPart as boolean) ?? false,
    hostedFormControlTree: lf,
  };
}

function buildFilter(obj: Record<string, unknown>, controlPath: string): FilterNode {
  return {
    type: 'filc',
    controlPath,
    properties: readProperties(obj),
    children: buildChildren(obj.Children, controlPath, false),
  };
}

function buildStackGroup(obj: Record<string, unknown>, controlPath: string, insideRepeater: boolean): StackGroupNode {
  const designName = typeof obj.DesignName === 'string' ? obj.DesignName : undefined;
  return {
    type: 'stackgc',
    controlPath,
    properties: readProperties(obj),
    children: buildChildren(obj.Children, controlPath, insideRepeater),
    ...(designName ? { designName } : {}),
  };
}

function buildCueField(obj: Record<string, unknown>, controlPath: string): CueFieldNode {
  const props = readProperties(obj);
  const binder = obj.ColumnBinder as { Name?: string; Path?: string } | undefined;
  const hasAction = obj.HasAction === true;
  const synopsis = typeof obj.Synopsis === 'string' ? obj.Synopsis : undefined;
  return {
    type: 'stackc',
    controlPath,
    properties: props,
    ...(binder?.Name ? { columnBinder: { name: binder.Name, ...(binder.Path ? { path: binder.Path } : {}) } } : {}),
    ...(hasAction ? { hasAction: true as const } : {}),
    ...(synopsis ? { synopsis } : {}),
  };
}

function makeUnknown(controlPath: string, type: string, properties: NodeProperties, children: FormNode[] = []): UnknownNode {
  return { __unknown: true, type, controlPath, properties, children };
}

function readProperties(obj: Record<string, unknown>): NodeProperties {
  const p: Record<string, unknown> = {};
  if (typeof obj.Caption === 'string') p.caption = obj.Caption;
  if (typeof obj.Visible === 'boolean') p.visible = obj.Visible;
  if (typeof obj.Editable === 'boolean') p.editable = obj.Editable;
  if (typeof obj.Enabled === 'boolean') p.enabled = obj.Enabled;
  if (obj.StringValue != null) p.stringValue = String(obj.StringValue);
  if ('ObjectValue' in obj) p.objectValue = obj.ObjectValue;
  if (typeof obj.ShowCaption === 'boolean') p.showCaption = obj.ShowCaption;
  if (obj.ShowMandatory === true) p.showMandatory = true;
  if (typeof obj.MappingHint === 'string') p.mappingHint = obj.MappingHint;
  if (typeof obj.DesignName === 'string') p.designName = obj.DesignName;
  if (typeof obj.ControlIdentifier === 'string') p.controlIdentifier = obj.ControlIdentifier;
  if (typeof obj.TotalRowCount === 'number') p.totalRowCount = obj.TotalRowCount;
  if (typeof obj.Bookmark === 'string') p.bookmark = obj.Bookmark;
  if (typeof obj.HasFiltersApplied === 'boolean') p.hasFiltersApplied = obj.HasFiltersApplied;
  // Record whether ExpressionProperties.Visible exists (wizard step detection).
  const expr = obj.ExpressionProperties;
  if (expr && typeof expr === 'object' && 'Visible' in (expr as Record<string, unknown>)) {
    p.hasVisibleExpression = true;
  }
  // Option/enum items — present on sec (option enum) and bc (boolean) controls.
  // Reference: live BC28 wire, Item Card page 30 "Type" field; decompiled
  // LogicalControlSerializer.WriteItems for the Items/CurrentIndex property names.
  if (Array.isArray(obj.Items)) {
    p.options = (obj.Items as Array<Record<string, unknown>>).map(item => ({
      text: String(item.Text ?? ''),
      value: String(item.Value ?? ''),
    }));
  }
  if (typeof obj.CurrentIndex === 'number') {
    p.optionIndex = obj.CurrentIndex;
  }
  return p as NodeProperties;
}
