import { ReadDataSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_read_data',
    description: `Refreshes a single section on an already-open page. Returns one Section: { sectionId, kind, caption, fields?, rows?, actions?, totalRowCount? }. Card-shape sections (header, factbox, requestPage) refresh their fields[]; list-shape sections refresh rows[]. Requires a pageContextId from a prior bc_open_page call.

Pass section: "header" (default) to refresh the page's header. Pass section: "lines" to refresh document line items. Pass a factbox sectionId (e.g. "factbox:Customer Statistics", as listed in the bc_open_page response) to refresh the FactBox card.

Option/enum and boolean fields in card-shape sections carry "options" (allowed choices as [{text, value}]) and "selectedOption" (current choice). When writing an enum field with bc_write_data, use the "value" string from "options" -- do NOT guess values. Example: after opening Item Card, the "Type" field returns options=[{text:"Inventory",value:"0"},{text:"Service",value:"1"},{text:"Non-Inventory",value:"2"}]; to change to Service, write value "1".

Filtering applies to list-shape sections only. Pass an array of { column, value }; values use BC filter syntax (exact "10000", ranges "10000..20000", wildcards "*consulting*", expressions ">1000"). Multiple filters combine with AND.

Column selection: pass columns: ["No.", "Name"] to limit the cells in each row, or the fields[] entries on a card section.

Range slicing: { offset, limit } returns rows[offset..offset+limit] for list sections. Use with totalRowCount for pagination.

Examples:
- Refresh header: { "pageContextId": "abc" }
- Filter customer list: { "pageContextId": "abc", "filters": [{ "column": "City", "value": "London" }] }
- Read sales order lines: { "pageContextId": "abc", "section": "lines" }
- Refresh a FactBox: { "pageContextId": "abc", "section": "factbox:Customer Statistics" }`,
    inputSchema: toMcpJsonSchema(ReadDataSchema),
    zodSchema: ReadDataSchema,
    execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
  };
}
