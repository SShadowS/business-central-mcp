import { WriteDataSchema, WriteDataOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_write_data',
    description: `Writes one or more field values on an already-open Business Central page. Pass a fields object with caption-name keys and string values. BC validates each field and returns the server-confirmed value, which may differ from input due to formatting, auto-completion, or lookups (e.g., entering a partial customer name resolves to the full match). Requires a pageContextId from bc_open_page.

A field (or list column) that BC publishes as hidden, disabled or not editable is not written: that result has success:false and an error saying why (a hidden list column is reported as hidden), and nothing is sent for it, because BC silently ignores such a write. Other fields in the same call are still written. A result with echoed:false and a warning means BC raised no error but sent no stored value back (BC echoes only a changed value, so rewriting the current value looks the same): the write is not confirmed, read the field back to verify. Write related fields together in one call (e.g., quantity and unit price), but avoid writing unrelated groups together because BC validation cascades may change dependent fields in unexpected order. Check the returned confirmed values to see what BC actually stored.

For Document page line items (Sales Order lines, Purchase Order lines), specify section: "lines" to write to the lines repeater. Use rowIndex (0-based row position) or bookmark (stable row identifier from bc_read_data results) to target a specific line. Prefer bookmark over rowIndex when rows may have been reordered or inserted since the last read.

Pass expectedStateVersion (from a prior bc_read_data or bc_open_page stateVersion field) to guard against acting on drifted state. If the page has been mutated by async events or a sibling operation since that read, the call is immediately rejected with code STALE_CONTEXT before touching BC. Re-read with bc_read_data to get the current stateVersion, then retry. Omit expectedStateVersion to skip the check.

Do NOT use this for triggering actions like Post, Delete, or Release -- use bc_execute_action instead. Do NOT use this for navigating to records -- use bc_navigate instead.

Examples:
- Write to Card header: { "pageContextId": "abc", "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" } }
- Write to Sales Order line: { "pageContextId": "abc", "section": "lines", "rowIndex": 0, "fields": { "Quantity": "5", "Unit Price": "100" } }
- Write with bookmark targeting: { "pageContextId": "abc", "section": "lines", "bookmark": "XXXX", "fields": { "Description": "Consulting Services" } }
- Write with staleness guard: { "pageContextId": "abc", "fields": { "Name": "Contoso" }, "expectedStateVersion": 3 }

Optional keyBy: "designName" uses stable AL DesignNames instead of captions (omit for captions).`,
    inputSchema: toMcpJsonSchema(WriteDataSchema),
    outputSchema: toMcpJsonSchema(WriteDataOutputSchema),
    zodSchema: WriteDataSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
  };
}
