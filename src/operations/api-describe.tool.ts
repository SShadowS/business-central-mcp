// src/operations/api-describe.tool.ts
import { ApiDescribeSchema, ApiDescribeOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_api_describe',
    description: `Returns the full schema of one Business Central API action found with bc_api_search: what it does, and the JSON schema of its parameters. For a List action the schema's "_availableFields" lists every field with its type and option values, and says which fields can be used in filter, orderby and select. For Create the properties are the editable fields; for Modify the required "id" and "If-Match" (the record's current "@odata.etag") plus the editable fields; for Delete the key; for a bound action the key and the action's own parameters.

Call it before bc_api_list (to know the exact field names for filter/select/orderby) and before every bc_api_invoke (to send exactly the parameters the action takes; bc_api_invoke's "parameters" object uses the property names from this schema). When NOT to use: to discover action names (bc_api_search) or to read data (bc_api_list). Runs on BC's own MCP server (BC 29+, API tools enabled); needs no web-client session.`,
    inputSchema: toMcpJsonSchema(ApiDescribeSchema),
    outputSchema: toMcpJsonSchema(ApiDescribeOutputSchema),
    zodSchema: ApiDescribeSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.apiActions.describe(input as Parameters<typeof ops.apiActions.describe>[0]),
  };
}
