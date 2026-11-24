import { RespondDialogSchema, RespondDialogOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_respond_dialog',
    description: `Responds to an open Business Central dialog or confirmation prompt. Dialogs are triggered by bc_execute_action, bc_write_data, or bc_run_report when BC requires user input (e.g., "Do you want to post?", "Delete this record?", validation warnings, or a report request page). When those tools return a dialogsOpened array with requiresDialogResponse: true (bc_run_report's request page included), you MUST call this tool (response: "ok" for a report request page) to continue the workflow.

The dialogFormId comes from the dialogsOpened array in the triggering tool's response. Each dialog entry says what it is: kind ("confirm", "message", "error", "requestPage", "page"), title, message (the question or text it shows), responses (the answers this dialog accepts; pick one of them) and fields (inputs, same shape as page fields). The result's "closed" says whether BC closed the dialog, and "closedPages" lists pages the answer closed (e.g. "yes" on a discard confirm closes its card): those pageContextIds no longer work. The response parameter accepts: "ok" (confirm/accept), "cancel" (dismiss/abort), "yes" or "no" (answer a yes/no question), "abort" (only for a dialog that shows an Abort button; on any other dialog BC ignores it and the call fails with INPUT_VALIDATION_ERROR, the dialog still open), "close" (close a modal information page), or "print" / "preview" (press Print or Preview on a report request page that an action opened, e.g. Print... on a posted document: it has no OK button, so "ok" does nothing there). The tool presses the dialog's own button for the response (e.g. "ok" also matches a page's OK that BC models as LookupOk). Choose the response that matches the dialog's intent -- confirmation dialogs typically need "yes", acceptance dialogs need "ok".

After responding, check the changedSections array in the result to see which page sections were affected. For example, posting a Sales Order may change all sections. If the dialog response triggers another dialog (chained confirmations), the response will include a new dialogsOpened array -- respond to each dialog in sequence.

Do NOT call this without a preceding dialog -- there is no dialog to respond to unless a tool returned dialogsOpened (bc_execute_action, bc_write_data, bc_wizard_navigate, bc_respond_dialog, bc_close_page, bc_upload_file, bc_run_report). Do NOT guess the dialogFormId -- always use the exact formId from the dialogsOpened array.

This tool only presses a button; it never sets values. To fill a dialog's input fields (e.g. a request page or a dialog with entry fields), call bc_write_data with the pageContextId from the dialogsOpened entry -- that is the dialog's own page context -- and then call this tool to press OK. If a write fails, fix it or cancel the dialog; do not press "ok" over a failed field. Pass either that dialog pageContextId or the opening page's; changedSections and openedPages always describe the opening page.

Example: { "pageContextId": "abc", "dialogFormId": "dialog-123", "response": "yes" }

If the action produces a file (Open in Excel, Print, export), its bytes appear in \`downloads[]\` (an operationId replay returns the metadata with error code NOT_REPLAYED instead of the bytes); links BC would open externally appear in \`externalUris[]\` and are never fetched by the server.`,
    inputSchema: toMcpJsonSchema(RespondDialogSchema),
    outputSchema: toMcpJsonSchema(RespondDialogOutputSchema),
    zodSchema: RespondDialogSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: (input) => ops.respondDialog.execute(input as Parameters<typeof ops.respondDialog.execute>[0]),
  };
}
