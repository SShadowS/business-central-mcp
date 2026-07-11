import { ReadDataSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_read_data',
    description: `Refreshes a single section on an already-open page. Returns { section: { sectionId, kind, caption, fields?, rows?, actions?, totalRowCount? }, stateVersion }. Card-shape sections (header, factbox, requestPage) refresh their fields[]; list-shape sections refresh rows[]. The returned stateVersion can be passed as expectedStateVersion to bc_write_data / bc_execute_action to reject stale-state writes. Requires a pageContextId from a prior bc_open_page call.

Do NOT use this for bulk or analytical reads over standard entities (customers, items, ledger entries, ...) -- prefer bc_query, which reads server-side via OData with no open page and no UI paging. Use bc_read_data when you need the interactive page's exact rows, factboxes, or option metadata.

Pass section: "header" (default) to refresh the page's header. Pass section: "lines" to refresh document line items. Pass a factbox sectionId (e.g. "factbox:Customer Statistics", as listed in the bc_open_page response) to refresh the FactBox card.

Option/enum and boolean fields in card-shape sections carry "options" (allowed choices as [{text, value}]) and "selectedOption" (current choice). When writing an enum field with bc_write_data, use the "value" string from "options" -- do NOT guess values. Example: after opening Item Card, the "Type" field returns options=[{text:"Inventory",value:"0"},{text:"Service",value:"1"},{text:"Non-Inventory",value:"2"}]; to change to Service, write value "1".

Filtering applies to list-shape sections only. Pass an array of { column, value }; values use BC filter syntax (exact "10000", ranges "10000..20000", wildcards "*consulting*", expressions ">1000"). Multiple filters combine with AND.

clearFilters: true resets agent-applied filters and restores the page to its default/native filtered state before reading. Note: page-defined SourceTableView filters (set in AL code) remain active -- this does NOT guarantee a completely empty filter set. Use before applying new filters to avoid stacking. Applies to list-shape sections only. Runs before any filters[] in the same call.

Sorting: pass sort: { column, direction } to sort the repeater before reading. Applied server-side after any filters. Resets BC viewport to top of sorted result. "asc" = A-Z / 0-9, "desc" = Z-A / 9-0. The column must be a visible repeater column on the section. Non-sortable columns (FlowFields, BLOBs) may be rejected by BC with an error. Applies to list-shape sections only.

Column selection: pass columns: ["No.", "Name"] to limit the cells in each row, or the fields[] entries on a card section.

Range slicing: { offset, limit } returns rows[offset..offset+limit] for list sections. Use with totalRowCount for pagination.

Examples:
- Refresh header: { "pageContextId": "abc" }
- Filter customer list: { "pageContextId": "abc", "filters": [{ "column": "City", "value": "London" }] }
- Sort by Name ascending: { "pageContextId": "abc", "sort": { "column": "Name", "direction": "asc" } }
- Sort by Name descending: { "pageContextId": "abc", "sort": { "column": "Name", "direction": "desc" } }
- Filter and sort: { "pageContextId": "abc", "filters": [{ "column": "City", "value": "London" }], "sort": { "column": "Name", "direction": "asc" } }
- Clear filters and re-read: { "pageContextId": "abc", "clearFilters": true }
- Clear and re-filter: { "pageContextId": "abc", "clearFilters": true, "filters": [{ "column": "City", "value": "London" }] }
- Read sales order lines: { "pageContextId": "abc", "section": "lines" }
- Refresh a FactBox: { "pageContextId": "abc", "section": "factbox:Customer Statistics" }`,
    inputSchema: toMcpJsonSchema(ReadDataSchema),
    zodSchema: ReadDataSchema,
    execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
  };
}
