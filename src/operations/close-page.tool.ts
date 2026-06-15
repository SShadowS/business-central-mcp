import { ClosePageSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_close_page',
    description: `Closes an open Business Central page and frees its server-side resources including the WebSocket form session. Always call this when you are finished working with a page to prevent resource leaks on the BC server. Requires a pageContextId from bc_open_page.

After closing, the pageContextId becomes invalid -- any subsequent bc_read_data, bc_write_data, bc_execute_action, or bc_navigate calls using it will fail. It is safe to call this even if prior operations on the page encountered errors. If you opened a drill-down page via bc_navigate (which returns a new pageContextId), close both the drill-down page and the original list page when done.

Do NOT call this in the middle of a multi-step workflow -- finish all reads, writes, and actions on the page first. Do NOT call this to "reset" a page; use bc_read_data to refresh data instead.`,
    inputSchema: toMcpJsonSchema(ClosePageSchema),
    zodSchema: ClosePageSchema,
    execute: (input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
  };
}
