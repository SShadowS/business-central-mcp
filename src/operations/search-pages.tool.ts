import { SearchPagesSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_search_pages',
    description: `Searches BC's Tell Me index for pages, reports, codeunits, and other run-targets matching the query. Each result is { name, objectType, runTarget, departmentPath?, category?, score? } where objectType is "page" / "report" / "codeunit" / etc., runTarget is the BC AL object name (e.g. "Customer List"), and category is the BC department (e.g. "Lists", "Tasks"). Use this when you do not know the page ID for an entity — search by keyword first, then resolve. Do NOT use it when you already know the numeric page ID (call bc_open_page directly), and do NOT use it to read data — it only discovers objects.

Tell Me is PROFILE-SCOPED on the BC server. If the search returns no rows in an env where the BC web client finds matches, set the BC_PROFILE environment variable on bc-mcp's startup config to a profile that indexes the relevant objects (BUSINESS MANAGER, ACCOUNTANT, SALES ORDER PROCESSOR, etc.). The default profile may have an empty Tell Me index.

Note that BC's Tell Me identifies pages by AL name, not by numeric ID. The runTarget is therefore a string like "Customer List" rather than "22". To open the result, the caller currently still needs the numeric page ID: match the runTarget AL name to a known page ID (e.g. "Customer List" = 22), or try bc_open_page with a candidate ID.

Empty-result behavior: response includes a "note" string explaining the likely cause and suggesting BC_PROFILE remediation.

Examples:
- { "query": "customer" } returns rows like { "name": "Customers", "objectType": "page", "runTarget": "Customer List", "category": "Lists", "score": 9 }.
- Empty case: { "results": [], "note": "No results. Tell Me is profile-scoped..." }.`,
    inputSchema: toMcpJsonSchema(SearchPagesSchema),
    zodSchema: SearchPagesSchema,
    execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
  };
}
