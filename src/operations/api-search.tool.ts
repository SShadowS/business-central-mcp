// src/operations/api-search.tool.ts
import { ApiSearchSchema, ApiSearchOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_api_search',
    description: `Searches the Business Central APIs available to this user and returns action names such as "List_Customers_PAG30009", "List_CustomerLedgerEntries_QRY30302" or "Create_Customer_PAG30009". It covers every installed API page and API query the user can read — Microsoft's standard APIs, ISV and custom extension APIs — not only the Standard API v2.0 entities bc_query knows. Names are <Verb>_<EntitySet>_<PAG|QRY><object id>; List actions read, Create/Modify/Delete and bound/unbound actions change data.

Workflow: bc_api_search -> bc_api_describe (fields, filters, required parameters) -> bc_api_list to read, or bc_api_invoke to create, modify, delete or run an action. Matching is by name fragments, so search with entity words ("customer", "sales invoice", "ledger"); pass actionTypes ["List"] to find readable data only. Write actions appear only for API objects an admin enabled with those permissions in BC's MCP Server Configuration; reads are available for all installed APIs.

When NOT to use: to read tables that have no API (write an AL query with bc_data_query), or to work through the UI (bc_open_page). Runs on BC's own MCP server (BC 29+, API tools enabled), else BC_MCP_UNAVAILABLE; needs no web-client session.`,
    inputSchema: toMcpJsonSchema(ApiSearchSchema),
    outputSchema: toMcpJsonSchema(ApiSearchOutputSchema),
    zodSchema: ApiSearchSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.apiActions.search(input as Parameters<typeof ops.apiActions.search>[0]),
  };
}
