// src/operations/data-table-schema.tool.ts
import { DataTableSchemaSchema, DataTableSchemaOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_data_get_table_schema',
    description: `Returns the fields of a Business Central table as compact pipe-delimited text: a header with the table name, ID and primary key, then one line per field with its exact name and type, option values for Option fields, the formula for FlowFields (e.g. "FlowField: Sum("Cust. Ledger Entry"."Amount")"), and TableRelation targets ("rel: Country/Region"). Field names differ between environments and installed extensions, so call this for EVERY table before writing an AL query for bc_data_query — a wrong name is a compile error (AL0345).

Use fieldClass to list only Normal fields, FlowFields or FlowFilters, and nameContains to keep the answer small on wide tables (e.g. ["No.", "Amount", "Date"]). Get table IDs from bc_data_find_tables. When NOT to use: to read field values (this returns metadata only; run a query with bc_data_query, or read a page with bc_open_page). Runs on BC's own MCP server (BC 29+, "Data Query Tools (Preview)" enabled); needs no web-client session.`,
    inputSchema: toMcpJsonSchema(DataTableSchemaSchema),
    outputSchema: toMcpJsonSchema(DataTableSchemaOutputSchema),
    zodSchema: DataTableSchemaSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    sessionIndependent: true,
    execute: (input) => ops.dataQuery.getTableSchema(input as Parameters<typeof ops.dataQuery.getTableSchema>[0]),
  };
}
