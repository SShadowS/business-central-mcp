import { OpenPageSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_open_page',
    description: `Opens a Business Central page by its numeric page ID and returns its complete state as a list of sections. Each section has a sectionId, kind (header / lines / factbox / subpage / requestPage), caption, and the appropriate content shape. Card-shape sections (most headers, factboxes, requestPages) carry fields[] (and headers also carry actions[]). List-shape sections (lines, list-bodied headers, repeater subpages) carry rows[] and totalRowCount. The header section adapts to its page: it is card-shape on Card pages and list-shape on List pages -- the kind stays "header" either way for path stability. This is the entry point for interactive, page-scoped work -- it returns a pageContextId that the page-scoped tools (bc_read_data, bc_write_data, bc_execute_action, bc_navigate, bc_respond_dialog, bc_close_page, bc_lookup) take as input, plus a stateVersion you can pass as expectedStateVersion to bc_write_data / bc_execute_action to guard against stale state. (bc_query, bc_run_report, bc_search_pages, bc_list_companies, and bc_switch_company do NOT need a pageContextId.) For bulk, read-only data over standard entities, prefer bc_query -- it needs no open page. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21) return one header (card-shape) plus any FactBox sections attached to the page. List pages (Customer List=22) return a header (list-shape, rows[] populated). Document pages (Sales Order=42) return a header (card-shape), a "lines" list-shape section with the document lines, and any FactBoxes.

Option/enum fields and boolean fields in card-shape sections carry two extra properties: "options" (the allowed choices as [{text, value}]) and "selectedOption" (the currently chosen entry). Always use the "value" string from "options" as the SaveValue payload when writing an enum field -- do NOT guess or invent values. Example: Item Card "Type" field returns options=[{text:"Inventory",value:"0"},{text:"Service",value:"1"},{text:"Non-Inventory",value:"2"}] and selectedOption={text:"Inventory",value:"0"}.

Typical workflow: bc_open_page -> bc_read_data (refresh / filter / paginate a section) -> bc_write_data (edit fields in any section) -> bc_execute_action (post / release / delete) -> bc_close_page. Always call bc_close_page when done. Do NOT call this if the page is already open -- reuse the existing pageContextId.

Optional bookmark parameter opens a Card page to a specific record. Bookmarks come from list rows in any prior section.

Examples:
- { "pageId": 22 } opens Customer List. Sections: [{ "sectionId": "header", "kind": "header", "rows": [...], "actions": [...] }] (no fields[] on a list-shape header).
- { "pageId": 21, "bookmark": "..." } opens Customer Card. Sections include the header card plus FactBoxes (e.g. { "sectionId": "factbox:Customer Statistics", "kind": "factbox", "fields": [...] }).`,
    inputSchema: toMcpJsonSchema(OpenPageSchema),
    zodSchema: OpenPageSchema,
    execute: (input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
  };
}
