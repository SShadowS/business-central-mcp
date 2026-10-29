// src/operations/data-find-tables.tool.ts
import { DataFindTablesSchema, DataFindTablesOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_data_find_tables',
    description: `Finds Business Central tables by name or by meaning and returns their table IDs and names. This is the first step of the data query workflow: bc_data_find_tables -> bc_data_get_table_schema (exact field names) -> bc_data_get_table_relations (join paths, when joining tables) -> bc_data_query (compile and run an AL query). Use searchMode "keyword" with comma-separated name fragments when you can guess the table name ("customer, ledger entry"), and "semantic" with a plain-language description when you cannot ("posted invoices that are still unpaid"); semantic search ranks the source tables of matching pages and returns a score. Semantic search relies on BC's Copilot metadata search and can come back empty where that is not set up (seen on an on-prem BC 29.1 container); fall back to "keyword" when it returns no tables.

When to use: before writing an AL query for bc_data_query, to discover the table behind a business concept, including tables from extensions and tables that have no API page. When NOT to use: to read records from a known Standard API entity (bc_query is simpler), or to find a page to open in the UI (use bc_search_pages). The data query tools run on BC's own MCP server (BC 29+) and need "Data Query Tools (Preview)" enabled in BC's MCP Server Configuration; otherwise they return DATA_QUERY_UNAVAILABLE. They need no web-client session and no open page.`,
    inputSchema: toMcpJsonSchema(DataFindTablesSchema),
    outputSchema: toMcpJsonSchema(DataFindTablesOutputSchema),
    zodSchema: DataFindTablesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.dataQuery.findTables(input as Parameters<typeof ops.dataQuery.findTables>[0]),
  };
}
