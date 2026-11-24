import { SearchPagesSchema, SearchPagesOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_search_pages',
    description: `Searches BC's Tell Me index for pages, reports, codeunits, and other run-targets matching the query. Each result is { name, objectType, runTarget, pageId?, departmentPath?, category?, score? } where objectType is "page" / "report" / "codeunit" / etc., runTarget is the BC AL object name (e.g. "Customer List"), pageId is the numeric page ID for a page result (pass it to bc_open_page), and category is the BC department (e.g. "Lists", "Tasks"). Use this when you do not know the page ID for an entity — search by keyword, then open the result's pageId. Results come in BC's relevance order, capped by limit (default 15); truncated: true means there were more. Do NOT use it when you already know the numeric page ID (call bc_open_page directly), and do NOT use it to read data — it only discovers objects.

Tell Me is PROFILE-SCOPED on the BC server. If the search returns no rows in an env where the BC web client finds matches, set the BC_PROFILE environment variable on bc-mcp's startup config to a profile that indexes the relevant objects (BUSINESS MANAGER, ACCOUNTANT, SALES ORDER PROCESSOR, etc.). The default profile may have an empty Tell Me index.

Report results carry no ID (Tell Me names them only by AL name), so they are for discovery: bc_run_report needs the numeric report ID.

Empty-result behavior: response includes a "note" string explaining the likely cause and suggesting BC_PROFILE remediation.

Examples:
- { "query": "customer" } returns rows like { "name": "Customers", "objectType": "page", "runTarget": "Customer List", "pageId": 22, "category": "Lists", "score": 4 }; open it with bc_open_page { "pageId": 22 }.
- Empty case: { "results": [], "truncated": false, "note": "No results. Tell Me is profile-scoped..." }.`,
    inputSchema: toMcpJsonSchema(SearchPagesSchema),
    outputSchema: toMcpJsonSchema(SearchPagesOutputSchema),
    zodSchema: SearchPagesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
  };
}
