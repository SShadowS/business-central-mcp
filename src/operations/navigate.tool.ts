import { NavigateSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_navigate',
    description: `Navigates to a specific record on an open Business Central List or Document page using its bookmark. Supports two actions: "select" positions the cursor on a row without opening it, and "drill_down" opens the record in its Card/Document page. Requires a pageContextId from bc_open_page and a bookmark from row data returned by bc_open_page or bc_read_data.

Action "select" (default): Positions the cursor on the specified row. Does NOT open the record or return new data -- it only moves the selection. Note: bc_execute_action can target a row directly via its own bookmark/rowIndex parameters, so you usually do not need a separate select before an action like Delete.

Action "drill_down": Opens the record's detail page (e.g., drilling down from Customer List opens Customer Card, drilling down from Sales Orders opens Sales Order). Returns a NEW pageContextId for the opened Card/Document page with its full state. The original List page remains open. Remember to bc_close_page both pages when done.

Section targeting: Use section (e.g., "lines") to navigate within a Document page's subpage repeater. Omit it for the header/default repeater.

Do NOT use this for Card pages -- it only works on pages with repeater rows. Do NOT confuse "select" with "drill_down": select just moves the cursor, drill_down opens a new page. For field-level lookups (enumerating valid values for a related-table field), use bc_lookup, not this tool.

Examples:
- Select a row: { "pageContextId": "abc", "bookmark": "XXXX", "action": "select" }
- Drill down to Card: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down" }
- Drill down from a document line: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down", "section": "lines" }`,
    inputSchema: toMcpJsonSchema(NavigateSchema),
    zodSchema: NavigateSchema,
    execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
  };
}
