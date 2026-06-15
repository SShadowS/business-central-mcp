import { ListCompaniesSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_list_companies',
    description: `List all companies available in the current Business Central environment. Returns an array of company names along with the currently active company name. Use this before bc_switch_company to verify the target company exists and to discover available companies.

This tool opens the BC Companies system page internally, reads all entries, and closes it. It does not affect your currently open pages or session state. No parameters are required.

Do NOT use this if you already know the company name -- call bc_switch_company directly. If you need to work with data in a specific company, use bc_switch_company followed by bc_open_page.`,
    inputSchema: toMcpJsonSchema(ListCompaniesSchema),
    zodSchema: ListCompaniesSchema,
    execute: () => ops.listCompanies.execute(),
  };
}
