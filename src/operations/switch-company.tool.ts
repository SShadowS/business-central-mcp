import { SwitchCompanySchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_switch_company',
    description: `Switch to a different company within the current Business Central session. All currently open pages will be invalidated and their pageContextIds will become unusable -- you must call bc_open_page to re-open any pages you need in the new company context.

Use bc_list_companies first to see the available company names and verify the target company exists. The companyName must be an exact match. After switching, all subsequent bc_open_page, bc_read_data, bc_write_data, and bc_execute_action calls will operate against the new company's data.

Do NOT switch companies in the middle of a multi-step workflow (e.g., between creating a Sales Order and posting it). Complete all operations in the current company first, then switch.

Example: { "companyName": "CRONUS International Ltd." }`,
    inputSchema: toMcpJsonSchema(SwitchCompanySchema),
    zodSchema: SwitchCompanySchema,
    execute: (input) => ops.switchCompany.execute(input as Parameters<typeof ops.switchCompany.execute>[0]),
  };
}
