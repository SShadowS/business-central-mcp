import { WizardNavigateSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_wizard_navigate',
    description: `Drive a Business Central NavigatePage / wizard by semantic step. Use after bc_open_page on a page whose response has isModal: true and pageType: "NavigatePage" (Continia activation wizards, BC setup wizards, request pages with multi-step layouts). The action argument is one of: "next" (advance), "back" (return to previous step), "finish" (complete the wizard), "cancel" (abort).

bc-mcp identifies the navigation buttons by the icon resource BC's own client uses (Actions/PreviousRecord, Actions/NextRecord, Actions/Approve), not by SystemAction or caption -- so localised wizards work without changes. The response surfaces fields visible on the new step, the remaining navigation options (availableNav), and a closed flag set when the wizard finished.

Typical workflow: bc_open_page (returns isModal=true, fields for step 0) -> bc_write_data (fill step 0 inputs) -> bc_wizard_navigate { action: "next" } -> bc_write_data (fill step 1) -> ... -> bc_wizard_navigate { action: "finish" }. The wizard closes itself on finish/cancel; the pageContextId becomes invalid afterwards.

Do NOT use this for non-wizard pages -- use bc_execute_action instead. Do NOT call "next" past the last step -- use "finish" once availableNav lists it.

Example: { "pageContextId": "abc", "action": "next" }

If the action produces a file (Open in Excel, Print, export), its bytes appear in \`downloads[]\`; links BC would open externally appear in \`externalUris[]\` and are never fetched by the server.`,
    inputSchema: toMcpJsonSchema(WizardNavigateSchema),
    zodSchema: WizardNavigateSchema,
    execute: (input) => ops.wizardNavigate.execute(input as Parameters<typeof ops.wizardNavigate.execute>[0]),
  };
}
