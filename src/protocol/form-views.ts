// src/protocol/form-views.ts
//
// Memoised derived views over a FormNode tree. Cached per-root via WeakMap;
// any tree mutation produces a new root, so cache invalidation is automatic.

import { DEFAULT_KEY_BY, type KeyBy } from './row-mapping.js';
import {
  isFieldNode, isActionNode, isRepeaterNode, isGroupNode, isLogicalFormNode,
  isStackGroupNode, isCueFieldNode,
  type ActionNode, type FieldNode, type FormNode, type RepeaterNode,
} from './form-node.js';
import { walkTree } from './form-tree-walk.js';

const NON_TAB_HINTS = new Set(['TOOLBAR', 'ACTIONBAR', 'PromptActions', 'CommandBarHelpGroup', 'CommandBarLayoutGroup']);

const fieldsCache = new WeakMap<FormNode, FieldNode[]>();
const actionsCache = new WeakMap<FormNode, ActionNode[]>();
const repeatersCache = new WeakMap<FormNode, ReadonlyMap<string, RepeaterNode>>();
const tabsCache = new WeakMap<FormNode, TabView[]>();
const groupVisibilityCache = new WeakMap<FormNode, ReadonlyMap<string, boolean>>();
const cuesCache = new WeakMap<FormNode, CueView[]>();

export interface TabView {
  readonly caption: string;
  readonly controlPath: string;
  readonly fields: readonly FieldNode[];
}

export function fields(root: FormNode): readonly FieldNode[] {
  const cached = fieldsCache.get(root);
  if (cached) return cached;
  const result: FieldNode[] = [];
  for (const n of walkTree(root)) if (isFieldNode(n)) result.push(n);
  fieldsCache.set(root, result);
  return result;
}

/** The field a tool's field name addresses: caption (case-insensitive) or exact controlPath. */
export function findField(root: FormNode, fieldName: string, keyBy: KeyBy = DEFAULT_KEY_BY): FieldNode | undefined {
  const lower = fieldName.toLowerCase();
  // DesignName mode: match the AL DesignName first, then fall back to caption / controlPath.
  if (keyBy === 'designName') {
    const byDesign = fields(root).find(f => !!f.properties.designName && f.properties.designName.toLowerCase() === lower);
    if (byDesign) return byDesign;
  }
  return fields(root).find(f => (f.properties.caption ?? '').toLowerCase() === lower || f.controlPath === fieldName);
}

/**
 * The record's primary-key controls: for each `Metadata.primaryKeyIds` entry (key
 * order), the first field bound to that table field (`tableFieldNo`), outside
 * repeater row templates. A key field with no control on the page is skipped;
 * an unbound form (no primaryKeyIds) yields [].
 */
export function primaryKeyFields(root: FormNode): Array<{ fieldNo: number; node: FieldNode }> {
  if (!isLogicalFormNode(root)) return [];
  const rcPaths = [...repeaters(root).keys()];
  const bound = fields(root).filter(f => f.tableFieldNo !== undefined && !rcPaths.some(p => f.controlPath.startsWith(`${p}/`)));
  return (root.metadata?.primaryKeyIds ?? []).flatMap(fieldNo => {
    const node = bound.find(f => f.tableFieldNo === fieldNo);
    return node ? [{ fieldNo, node }] : [];
  });
}

export function actions(root: FormNode): readonly ActionNode[] {
  const cached = actionsCache.get(root);
  if (cached) return cached;
  const result: ActionNode[] = [];
  for (const n of walkTree(root)) if (isActionNode(n)) result.push(n);
  actionsCache.set(root, result);
  return result;
}

export function repeaters(root: FormNode): ReadonlyMap<string, RepeaterNode> {
  const cached = repeatersCache.get(root);
  if (cached) return cached;
  const map = new Map<string, RepeaterNode>();
  for (const n of walkTree(root)) if (isRepeaterNode(n)) map.set(n.controlPath, n);
  repeatersCache.set(root, map);
  return map;
}

export function tabs(root: FormNode): readonly TabView[] {
  const cached = tabsCache.get(root);
  if (cached) return cached;
  if (!isLogicalFormNode(root)) {
    tabsCache.set(root, []);
    return [];
  }
  const result: TabView[] = [];
  for (const child of root.children) {
    if (!isGroupNode(child)) continue;
    const caption = child.properties.caption;
    if (!caption) continue;
    const hint = child.properties.mappingHint;
    if (hint && NON_TAB_HINTS.has(hint)) continue;
    const tabFields: FieldNode[] = [];
    for (const n of walkTree(child)) if (isFieldNode(n)) tabFields.push(n);
    result.push({ caption, controlPath: child.controlPath, fields: tabFields });
  }
  tabsCache.set(root, result);
  return result;
}

export function groupVisibility(root: FormNode): ReadonlyMap<string, boolean> {
  const cached = groupVisibilityCache.get(root);
  if (cached) return cached;
  const map = new Map<string, boolean>();
  for (const n of walkTree(root)) {
    if (isGroupNode(n)) map.set(n.controlPath, n.properties.visible ?? true);
  }
  groupVisibilityCache.set(root, map);
  return map;
}

export function filterControlPath(root: FormNode): string | null {
  for (const n of walkTree(root)) {
    if (n.type === 'filc') return n.controlPath;
  }
  return null;
}

export interface CueView {
  /** Caption of the parent stackgc (e.g. "Ongoing Sales"). May be empty. */
  readonly groupCaption: string;
  /** controlPath of the parent stackgc — useful for grouping in MCP output. */
  readonly groupControlPath: string;
  /** Caption of the cue tile (e.g. "Sales Quotes"). */
  readonly caption: string;
  /** controlPath of the cue tile; pass to InvokeAction(DrillDown=120). */
  readonly controlPath: string;
  /** Display value (the count). Initially "0"; populated by PropertyChanged after LoadForm. */
  readonly value: string;
  /** True when the cue supports drill-down (HasAction on the wire). */
  readonly hasAction: boolean;
  /** Tooltip text from the AL source. */
  readonly synopsis?: string;
}

/**
 * Collect every cue tile (stackc) reachable under any cuegroup container
 * (stackgc) in the tree. Cuegroups can be nested arbitrarily deep — for
 * example a Role Center hosts CardParts via fhc → lf → stackgc → ... — so
 * the walk is recursive and does NOT stop at the first stackgc.
 *
 * Each CueView records the parent stackgc's caption + controlPath so that
 * MCP output can group cues by their visual cluster. Orphan stackc nodes
 * (not enclosed in a stackgc) are skipped.
 */
export function cues(root: FormNode): readonly CueView[] {
  const cached = cuesCache.get(root);
  if (cached) return cached;

  const result: CueView[] = [];

  function visit(node: FormNode, parentGroup: { caption: string; controlPath: string } | null): void {
    if (isStackGroupNode(node)) {
      const newGroup = { caption: node.properties.caption ?? '', controlPath: node.controlPath };
      for (const child of node.children) visit(child, newGroup);
      return;
    }
    if (isCueFieldNode(node) && parentGroup) {
      result.push({
        groupCaption: parentGroup.caption,
        groupControlPath: parentGroup.controlPath,
        caption: node.properties.caption ?? '',
        controlPath: node.controlPath,
        value: node.properties.stringValue ?? '',
        hasAction: node.hasAction === true,
        ...(node.synopsis ? { synopsis: node.synopsis } : {}),
      });
      return;
    }
    // Recurse into other container kinds (gc, lf, fhc, etc.). FormHostNode's
    // hosted form lives in `hostedFormControlTree` (raw lf JSON), NOT in
    // `children` — page-context-repo builds a separate FormState for it,
    // so this view does not need to walk into hostedFormControlTree.
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, parentGroup);
    }
    // Repeater columns (rcc) are leaves and cannot host stackgcs — no need
    // to recurse into RepeaterNode.columns.
  }

  visit(root, null);
  cuesCache.set(root, result);
  return result;
}
