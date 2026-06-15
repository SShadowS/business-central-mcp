import { OpenPageSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_open_page',
    description: `Opens a Business Central page by its numeric page ID and returns its complete state as a list of sections. Each section has a sectionId, kind (header / lines / factbox / subpage / requestPage), caption, and the appropriate content shape. Card-shape sections (most headers, factboxes, requestPages) carry fields[] (and headers also carry actions[]). List-shape sections (lines, list-bodied headers, repeater subpages) carry rows[] and totalRowCount. The header section adapts to its page: it is card-shape on Card pages and list-shape on List pages -- the kind stays "header" either way for path stability. This is the entry point for all Business Central operations -- it returns a pageContextId that every other bc_ tool requires as input. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21) return one header (card-shape) plus any FactBox sections attached to the page. List pages (Customer List=22) return a header (list-shape, rows[] populated). Document pages (Sales Order=42) return a header (card-shape), a "lines" list-shape section with the document lines, and any FactBoxes.

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
