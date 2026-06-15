import { NavigateSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_navigate',
    description: `Navigates to a specific record on an open Business Central List or Document page using its bookmark. Supports three actions: "select" positions the cursor on a row without opening it, "drill_down" opens the record in its Card/Document page, and "lookup" triggers the lookup action on a specific field. Requires a pageContextId from bc_open_page and a bookmark from row data returned by bc_open_page or bc_read_data.

Action "select" (default): Positions the cursor on the specified row. Use this before bc_execute_action when you need to target a specific record for an action like Delete. Does NOT open the record or return new data -- it only moves the selection.

Action "drill_down": Opens the record's detail page (e.g., drilling down from Customer List opens Customer Card, drilling down from Sales Orders opens Sales Order). Returns a NEW pageContextId for the opened Card/Document page with its full state. The original List page remains open. Remember to bc_close_page both pages when done.

Action "lookup": Triggers a lookup on a specific field (specified via the field parameter) to open the related entity's list for selection.

Section and field targeting: Use section (e.g., "lines") to navigate within a Document page's subpage repeater. Use field to specify which column to drill down or look up from (e.g., field: "No." to drill down on the item number column).

Do NOT use this for Card pages -- it only works on pages with repeater rows. Do NOT confuse "select" with "drill_down": select just moves the cursor, drill_down opens a new page.

Examples:
- Select a row: { "pageContextId": "abc", "bookmark": "XXXX", "action": "select" }
- Drill down to Card: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down" }
- Drill down on a line item field: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down", "section": "lines", "field": "No." }`,
    inputSchema: toMcpJsonSchema(NavigateSchema),
    zodSchema: NavigateSchema,
    execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
  };
}
