import { ExecuteActionSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_execute_action',
    description: `Executes either a named action OR a cue-tile drill-down on an open page. Pass action for header / line / system actions (Post, Delete, New, Release). Pass cue for Role Center cue tiles to open the underlying list (e.g. cue: "Sales Quotes" with section: "subpage:Activities" opens the Sales Quotes list). Requires a pageContextId from bc_open_page.

For cue drill-down, also pass section pointing at the subpage that owns the cuegroup. The returned openedPages array contains the targetPageContextId of the newly-opened list page.

Otherwise behaves identically to the existing action flow: validates the action is enabled, sends the InvokeAction RPC, applies the resulting events, and returns updatedFields / changedSections / dialogsOpened / openedPages.

Use exactly one of "action" or "cue" -- passing both is an error.

If the action triggers a confirmation dialog or modal page, the response includes a dialogsOpened array with the dialog's formId and details. When requiresDialogResponse is true, you must follow up with bc_respond_dialog to confirm or cancel.

Row-scoped actions (Delete, Edit on a list row) require targeting a specific row. Use rowIndex (0-based) or bookmark to specify which row the action applies to. For Document pages, use section to disambiguate between header and line actions (e.g., "Delete" on header deletes the whole document, "Delete" on "lines" deletes one line).

Pass expectedStateVersion (from a prior bc_read_data or bc_open_page stateVersion field) to guard against acting on drifted state. If the page has been mutated by async events or a sibling operation since that read, the call is immediately rejected with code STALE_CONTEXT before touching BC. Re-read with bc_read_data to get the current stateVersion, then retry. Omit expectedStateVersion to skip the check.

Do NOT use this for writing field values -- use bc_write_data. Do NOT use this to open records from a list -- use bc_navigate with drill_down action instead.

Examples:
- Drill into a cue tile: { "pageContextId": "rc1", "section": "subpage:Activities", "cue": "Sales Quotes" }
- Post a sales order: { "pageContextId": "so1", "action": "Post" }
- Delete a row: { "pageContextId": "list1", "action": "Delete", "bookmark": "..." }
- Create new record: { "pageContextId": "abc", "action": "New" }
- Delete a document line: { "pageContextId": "abc", "action": "Delete", "section": "lines", "rowIndex": 2 }
- Execute with staleness guard: { "pageContextId": "abc", "action": "Post", "expectedStateVersion": 5 }`,
    inputSchema: toMcpJsonSchema(ExecuteActionSchema),
    zodSchema: ExecuteActionSchema,
    execute: (input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
  };
}
