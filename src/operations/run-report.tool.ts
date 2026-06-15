import { RunReportSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_run_report',
    description: `Execute a Business Central report by its numeric report ID. If the report has a request page (parameter/filter dialog), it will be returned with its fields so you can fill in parameters using bc_write_data and then execute the report by responding with bc_respond_dialog (response: "ok"). The report runs server-side on the BC service tier.

Output capture (downloading the rendered PDF, Excel, or Word document) is not yet supported. Use this tool for reports that perform server-side actions (batch posting via Report 295, inventory adjustments, data processing) or to inspect and fill request page parameters. Common reports: 1306 (Customer Statement), 120 (Aged Accounts Receivable), 6 (Trial Balance), 295 (Batch Post Sales Orders).

Do NOT use this for viewing data -- use bc_open_page and bc_read_data for data retrieval. Do NOT confuse reports with pages -- reports are processing/printing objects, pages are UI views.

Example: { "reportId": 6 }`,
    inputSchema: toMcpJsonSchema(RunReportSchema),
    zodSchema: RunReportSchema,
    execute: (input) => ops.runReport.execute(input as Parameters<typeof ops.runReport.execute>[0]),
  };
}
