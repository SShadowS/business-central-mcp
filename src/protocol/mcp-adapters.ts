// src/protocol/mcp-adapters.ts
//
// Adapters from internal FormNode tree shapes to MCP output DTOs
// (ControlField, ActionInfo). Used at the MCP boundary only -- internal
// code reads FieldNode/ActionNode directly via form-views.ts.

import type { FieldNode, FormNode } from './form-node.js';
import { ancestorGroupPaths } from './form-tree-walk.js';
import type { ControlField } from './types.js';

export function fieldNodeToControlField(root: FormNode, f: FieldNode): ControlField {
  return {
    controlPath: f.controlPath,
    caption: f.properties.caption ?? '',
    type: f.type,
    editable: f.properties.editable ?? false,
    visible: f.properties.visible ?? true,
    stringValue: f.properties.stringValue,
    value: f.properties.objectValue ?? f.properties.stringValue,
    columnBinderName: f.columnBinder?.name,
    ...(f.hasLookup ? { isLookup: true } : {}),
    ...(f.hasLookup && f.canShowSimpleLookup === false ? { lookupCustom: true } : {}),
    ...(f.properties.showMandatory ? { showMandatory: true } : {}),
    ancestorGroupPaths: ancestorGroupPaths(root, f.controlPath),
  };
}
