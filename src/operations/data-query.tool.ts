// src/operations/data-query.tool.ts
import { DataQuerySchema, DataQueryOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_data_query',
    description: `Compiles an AL query object you write and, with returnData: true, runs it against any Business Central table the user can read — including tables with no API page and tables from extensions — and returns a page of rows. BC compiles the query on the fly as a dynamic object (nothing is published) and always runs it ReadOnly with the user's permissions and security filters. Without returnData it only compiles and returns the columns and dataitems, which is a cheap way to validate a query; compile errors come back as DATA_QUERY_ERROR with AL diagnostics (e.g. AL0345 for an unknown field) that you can fix and retry.

Workflow: bc_data_find_tables (table IDs) -> bc_data_get_table_schema (exact field names, for every table) -> bc_data_get_table_relations (join fields) -> bc_data_query. Joins, filters, aggregations (Method = Sum/Count/...), OrderBy and TopNumberOfRows all work, so prefer letting BC aggregate over fetching raw rows. Results are paged: top is 1-50 (default 10), skip pages forward, totalCount comes on the first page, hasMore says whether another page exists; rows are arrays in column order.

When to use: ad-hoc reads, totals and joins over data the Standard API does not expose, or when bc_query's entities do not fit. When NOT to use: to change data (read-only; use bc_write_data / bc_execute_action), for simple reads of Standard API entities (bc_query), or to see what a page shows (bc_open_page). Needs BC 29+ with "Data Query Tools (Preview)" enabled in BC's MCP Server Configuration, else DATA_QUERY_UNAVAILABLE (Microsoft has announced billing for these tools at general availability). No web-client session needed.`,
    inputSchema: toMcpJsonSchema(DataQuerySchema),
    outputSchema: toMcpJsonSchema(DataQueryOutputSchema),
    zodSchema: DataQuerySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.dataQuery.query(input as Parameters<typeof ops.dataQuery.query>[0]),
  };
}
