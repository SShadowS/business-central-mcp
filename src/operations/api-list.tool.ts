// src/operations/api-list.tool.ts
import { ApiListSchema, ApiListOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_api_list',
    description: `Reads records through any Business Central API List action found with bc_api_search, with server-side OData filter, select, orderby, top and skip. Rows come back as JSON objects with the API's field names plus "@odata.etag" for API pages (pass that etag as "If-Match" when modifying the record with bc_api_invoke). totalCount is the number of matching records and hasMore says whether another page exists; top defaults to 10.

Use it for any API page or API query — standard, ISV or custom — including ones bc_query does not know (bc_query covers only the Standard API v2.0 entities). Check field names with bc_api_describe first; a filter on a non-filterable field is rejected. When NOT to use: for tables without an API (bc_data_query runs an AL query over any table), or to change data (bc_api_invoke). Read-only. Runs on BC's own MCP server (BC 29+, API tools enabled); needs no web-client session.`,
    inputSchema: toMcpJsonSchema(ApiListSchema),
    outputSchema: toMcpJsonSchema(ApiListOutputSchema),
    zodSchema: ApiListSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.apiActions.list(input as Parameters<typeof ops.apiActions.list>[0]),
  };
}
