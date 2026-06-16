import { WriteDataSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_write_data',
    description: `Writes one or more field values on an already-open Business Central page. Pass a fields object with caption-name keys and string values. BC validates each field and returns the server-confirmed value, which may differ from input due to formatting, auto-completion, or lookups (e.g., entering a partial customer name resolves to the full match). Requires a pageContextId from bc_open_page.

Fields must be editable -- writing to a read-only field returns an error. Write related fields together in one call (e.g., quantity and unit price), but avoid writing unrelated groups together because BC validation cascades may change dependent fields in unexpected order. Check the returned confirmed values to see what BC actually stored.

For Document page line items (Sales Order lines, Purchase Order lines), specify section: "lines" to write to the lines repeater. Use rowIndex (0-based row position) or bookmark (stable row identifier from bc_read_data results) to target a specific line. Prefer bookmark over rowIndex when rows may have been reordered or inserted since the last read.

Pass expectedStateVersion (from a prior bc_read_data or bc_open_page stateVersion field) to guard against acting on drifted state. If the page has been mutated by async events or a sibling operation since that read, the call is immediately rejected with code STALE_CONTEXT before touching BC. Re-read with bc_read_data to get the current stateVersion, then retry. Omit expectedStateVersion to skip the check.

Do NOT use this for triggering actions like Post, Delete, or Release -- use bc_execute_action instead. Do NOT use this for navigating to records -- use bc_navigate instead.

Examples:
- Write to Card header: { "pageContextId": "abc", "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" } }
- Write to Sales Order line: { "pageContextId": "abc", "section": "lines", "rowIndex": 0, "fields": { "Quantity": "5", "Unit Price": "100" } }
- Write with bookmark targeting: { "pageContextId": "abc", "section": "lines", "bookmark": "XXXX", "fields": { "Description": "Consulting Services" } }
- Write with staleness guard: { "pageContextId": "abc", "fields": { "Name": "Contoso" }, "expectedStateVersion": 3 }`,
    inputSchema: toMcpJsonSchema(WriteDataSchema),
    zodSchema: WriteDataSchema,
    execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
  };
}
