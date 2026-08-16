// src/operations/query.tool.ts
import { QuerySchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_query',
    description: `Reads records from Business Central in bulk using the Standard API v2.0 (OData/REST on port 7048). Use bc_query for efficient server-side filtered, sorted, and projected reads over many records — for example, fetching all open sales orders, listing customers in a city, or pulling G/L entries for a date range. This is far more efficient than using bc_open_page + bc_read_data for bulk reads because filtering and projection happen on the server before any data is transferred.

When to use bc_query: structured data retrieval over standard BC entities, when you need 2+ records with specific field selection, when you want server-side filter/sort/OData operators (\$filter, \$select, \$top, \$orderby, \$expand), or when you need to inspect a large dataset without driving the BC UI. Entity names are BC Standard API v2.0 names (camelCase): customers, vendors, items, salesOrders, salesInvoices, purchaseOrders, purchaseInvoices, generalLedgerEntries, accounts, journals, journalLines, companies, employees, dimensions, dimensionValues, currencies, paymentTerms, shipmentMethods, paymentMethods, countriesRegions, unitsOfMeasure, taxGroups, contacts. Pass filter as OData \$filter syntax (e.g., "city eq 'London'", "amount gt 1000", "postingDate ge 2024-01-01"). Pass select as comma-separated field names (e.g., "number,displayName,city") to limit response size. top defaults to 100 if omitted — pass explicitly to get more or fewer rows. Queries are company-scoped automatically; pass company to target a specific company (see bc_list_companies). The special "companies" entity is the one exception — it is the top-level environment list (not company-scoped), so the company parameter is ignored for it; query it to discover available companies.

When NOT to use bc_query: do not use for UI-driven flows (navigating pages, clicking buttons, filling forms — use bc_open_page + bc_execute_action for those). Do not use bc_query for posting, writing, or triggering BC business logic — OData reads are read-only; use bc_write_data and bc_execute_action for mutations. Do not use for custom/extension entities not in the Standard API v2.0 — those require the UI WebSocket tools. Auth: on-prem NavUserPassword uses HTTP Basic; BC Online (SaaS) uses device-code — when sign-in is needed the tool returns DEVICE_LOGIN_REQUIRED with a verification URL and code to show the user, and a retry after they sign in runs the query. bc_query does not need a /csh WebSocket session and does not open the SaaS sign-in window.`,
    inputSchema: toMcpJsonSchema(QuerySchema),
    zodSchema: QuerySchema,
    execute: (input) => ops.query.execute(input as Parameters<typeof ops.query.execute>[0]),
  };
}
