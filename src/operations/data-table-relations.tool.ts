// src/operations/data-table-relations.tool.ts
import { DataTableRelationsSchema, DataTableRelationsOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_data_get_table_relations',
    description: `Lists the TableRelation links of a Business Central table, so you can join tables correctly in an AL query. direction "outgoing" returns the tables this table points to and the fields that link them (e.g. Customer -> Country/Region via "Country/Region Code"); "incoming" returns the tables that point to this one (e.g. which ledger tables reference Customer), capped at 50 source tables with incomingTruncated/incomingTotalCount when cut. Conditional relations carry a "conditions" text (e.g. "Type=CONST(Item)").

Use it before writing a multi-dataitem query for bc_data_query: the via-field gives the DataItemLink. Pass relatedToTableIds to ask only about specific tables, which is also how to get past a truncated incoming list. Follow up with bc_data_get_table_schema for exact field names and types. When NOT to use: for single-table queries, or to read data. Runs on BC's own MCP server (BC 29+, "Data Query Tools (Preview)" enabled); needs no web-client session.`,
    inputSchema: toMcpJsonSchema(DataTableRelationsSchema),
    outputSchema: toMcpJsonSchema(DataTableRelationsOutputSchema),
    zodSchema: DataTableRelationsSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.dataQuery.getTableRelations(input as Parameters<typeof ops.dataQuery.getTableRelations>[0]),
  };
}
