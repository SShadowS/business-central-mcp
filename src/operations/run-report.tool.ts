import { RunReportSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_run_report',
    description: `Execute a Business Central report by its numeric report ID. If the report has a request page (parameter/filter dialog), it will be returned with its fields so you can fill in parameters using bc_write_data and then execute the report by responding with bc_respond_dialog (response: "ok"). The report runs server-side on the BC service tier.

Pass format: "pdf" to capture the rendered output as a base64-encoded PDF. The tool drives the BC "Send to..." flow (SystemAction 410) internally and returns download.bytes (base64) plus download.contentType and download.fileName. If BC_REPORT_DIR env var is set the file is also saved to disk and savedPath is returned. Only "pdf" is supported; "excel" and "word" are NOT yet supported and will return an error.

Use this tool for reports that perform server-side actions (batch posting via Report 295, inventory adjustments, data processing) or to inspect and fill request page parameters. Common reports: 1306 (Customer Statement), 120 (Aged Accounts Receivable), 6 (Trial Balance), 295 (Batch Post Sales Orders).

Do NOT use this for viewing data -- use bc_open_page and bc_read_data for data retrieval. Do NOT confuse reports with pages -- reports are processing/printing objects, pages are UI views.

Example (open request page): { "reportId": 6 }
Example (capture PDF):       { "reportId": 6, "format": "pdf" }`,
    inputSchema: toMcpJsonSchema(RunReportSchema),
    zodSchema: RunReportSchema,
    execute: (input) => ops.runReport.execute(input as Parameters<typeof ops.runReport.execute>[0]),
  };
}
