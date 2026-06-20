// src/operations/lookup.tool.ts
import { LookupSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_lookup',
    description: `Enumerates candidate values for a related-table (FK) field by invoking BC's built-in Lookup on the field and returning the result rows. Use this when you need to see valid choices for a field before writing it with bc_write_data — for example, listing all Salesperson Codes before filling "Salesperson Code" on a Customer Card, or listing all Gen. Bus. Posting Groups before selecting one.

Use bc_lookup when the field has isLookup=true in the bc_open_page or bc_read_data response. The field must be on an open page (pageContextId from bc_open_page). The operation is non-mutating: it opens the lookup form and always cancels without selecting a value, leaving the source page field unchanged. Provide an optional search string to filter candidates (e.g., search:"AR" to narrow to codes starting with "AR").

Do NOT use bc_lookup for option/enum fields — those already expose their fixed choices in the options array of bc_open_page and bc_read_data responses. Do NOT use for fields where isLookup is false or absent. Do NOT use for fields that carry lookupCustom=true in the bc_open_page or bc_read_data response: isLookup=true together with lookupCustom=true means the field drives a custom AL OnLookup trigger that BC does not expose as an enumerable lookup form — bc_lookup returns a clear error for these. Use the field's own UI/AssistEdit instead.

Workflow: bc_open_page → inspect field isLookup=true → bc_lookup to list candidates → bc_write_data with chosen value.`,
    inputSchema: toMcpJsonSchema(LookupSchema),
    zodSchema: LookupSchema,
    execute: (input) => ops.lookup.execute(input as Parameters<typeof ops.lookup.execute>[0]),
  };
}
