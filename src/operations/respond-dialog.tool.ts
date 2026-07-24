import { RespondDialogSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_respond_dialog',
    description: `Responds to an open Business Central dialog or confirmation prompt. Dialogs are triggered by bc_execute_action, bc_write_data, or bc_run_report when BC requires user input (e.g., "Do you want to post?", "Delete this record?", validation warnings, or a report request page). When those tools return a dialogsOpened array with requiresDialogResponse: true, or bc_run_report returns a requestPage, you MUST call this tool (response: "ok" for a report request page) to continue the workflow.

The dialogFormId comes from the dialogsOpened array in the triggering tool's response. The response parameter accepts: "ok" (confirm/accept), "cancel" (dismiss/abort), "yes" or "no" (answer a yes/no question), "abort" (force-close), or "close" (close a modal information page). Choose the response that matches the dialog's intent -- confirmation dialogs typically need "yes", acceptance dialogs need "ok".

After responding, check the changedSections array in the result to see which page sections were affected. For example, posting a Sales Order may change all sections. If the dialog response triggers another dialog (chained confirmations), the response will include a new dialogsOpened array -- respond to each dialog in sequence.

Do NOT call this without a preceding dialog -- there is no dialog to respond to unless dialogsOpened was returned by bc_execute_action / bc_write_data, or a requestPage was returned by bc_run_report. Do NOT guess the dialogFormId -- always use the exact value from the dialogsOpened array (or requestPage.formId).

Example: { "pageContextId": "abc", "dialogFormId": "dialog-123", "response": "yes" }

If the action produces a file (Open in Excel, Print, export), its bytes appear in \`downloads[]\`; links BC would open externally appear in \`externalUris[]\` and are never fetched by the server.`,
    inputSchema: toMcpJsonSchema(RespondDialogSchema),
    zodSchema: RespondDialogSchema,
    execute: (input) => ops.respondDialog.execute(input as Parameters<typeof ops.respondDialog.execute>[0]),
  };
}
