// src/operations/api-invoke.tool.ts
import { ApiInvokeSchema, ApiInvokeOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_api_invoke',
    description: `Runs a Business Central API action that changes data: Create_* (insert a record), Modify_* (update one), Delete_* (delete one), or a bound/unbound action such as posting a document. Get the action name from bc_api_search and its exact parameters from bc_api_describe, then pass them as the "parameters" object. Create and Modify return the record as BC saved it, including its new "@odata.etag"; Delete returns no result.

Modify needs the record's key ("id") and "If-Match" set to its current "@odata.etag" (read it with bc_api_list); a stale etag is refused with API_ACTION_ERROR "Request_EntityChanged" — re-read and retry. BC applies its own validation and business logic; a rejection is API_ACTION_ERROR with BC's message and nothing is changed. Write actions exist only for API objects an admin enabled with those permissions in BC's MCP Server Configuration.

Pass an operationId to make a retry safe: the same id replays the first result instead of running the action again. replaySafe is true for Modify and Delete (a repeat is refused by BC: stale etag, or record gone) and false for Create and bound actions (a repeat would create or post again). When NOT to use: to read (bc_api_list), or for changes that need the UI's dialogs and pages (bc_open_page, bc_write_data, bc_execute_action). Runs on BC's own MCP server (BC 29+); needs no web-client session.`,
    inputSchema: toMcpJsonSchema(ApiInvokeSchema),
    outputSchema: toMcpJsonSchema(ApiInvokeOutputSchema),
    zodSchema: ApiInvokeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.apiActions.invoke(input as Parameters<typeof ops.apiActions.invoke>[0]),
  };
}
