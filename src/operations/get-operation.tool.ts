import { GetOperationSchema, GetOperationOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';
import type { GetOperationInput } from './get-operation.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_get_operation',
    description: `Look up what happened to an earlier mutating call made with an operationId (bc_write_data, bc_execute_action, bc_respond_dialog, bc_wizard_navigate, bc_close_page, bc_switch_company, bc_run_report, bc_upload_file). Returns the operation ledger entry: status (sent, completed, unknown), tool, timestamps, replaySafe, the stored result, and the target snapshot captured before the call ran.

When the outcome is unknown or replaySafe is false, this tool also re-reads the target in the current session: it re-opens the page by page id and record bookmark, reads the identified fields (the record's key fields and any written fields, plus the lines of a document such as a sales order) or the targeted row, closes the page again, and returns them as readBack plus evidenceHash, a SHA-256 of the canonical JSON of readBack. A key field marked source 'bookmark' has no control on the page and is decoded from the record bookmark: an Option key shows its ordinal (Sales Order "Document Type" = '1', meaning Order), not its caption. Use it after OPERATION_IN_DOUBT, a timeout, or SESSION_LOST to decide whether the change landed before acting again under a new operationId.

This tool changes nothing in BC. A completed, replay-safe operation is returned without a read-back. If the operation ran in another company, readBackError COMPANY_MISMATCH tells you to bc_switch_company first. If a dialog is open in the session, readBackError MODAL_OPEN: answer it with bc_respond_dialog first (opening a page would cancel it). If the record no longer exists (a fully posted document is deleted), readBackError RECORD_NOT_OPENED. If the re-opened page shows a different key value than the recorded one, readBackError KEY_MISMATCH returns readBack WITHOUT an evidenceHash: the page landed on another record, so the read-back proves nothing about the target. Do NOT use it to read arbitrary records -- use bc_open_page and bc_read_data for that.

Optional keyBy: "designName" uses stable AL DesignNames instead of captions (omit for captions).`,
    inputSchema: toMcpJsonSchema(GetOperationSchema),
    outputSchema: toMcpJsonSchema(GetOperationOutputSchema),
    zodSchema: GetOperationSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: (input) => ops.getOperation.execute(input as GetOperationInput),
  };
}
