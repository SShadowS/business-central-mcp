import { UploadFileSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_upload_file',
    description: `Upload a local file into a Business Central file-upload dialog, driving the page's AL \`Upload\`/\`UploadIntoStream\` code on the uploaded stream. This is a TWO-STEP flow: first invoke the page's upload action (bc_execute_action, e.g. "Import Layout" on Custom Report Layouts / page 9650) so BC opens the file-picker dialog (a FileUploadForm, returned in dialogsOpened), then call bc_upload_file with that page's pageContextId. The file is sent as a multipart POST to BC's DynamicFileUploadHandler over the same authenticated session, and the dialog is closed afterwards — exactly what the web client does — which resumes the suspended AL code on your bytes.

The upload targets the page's open FileUploadForm dialog automatically; optionally pass \`formId\` (the dialog formId from bc_execute_action's dialogsOpened) to target it explicitly. The call FAILS with a clear error instead of uploading when no FileUploadForm dialog is open — BC would otherwise silently discard the bytes (HTTP 200 with no effect), e.g. when the action failed and opened an error dialog instead, or when the invoked action is a declarative \`fileuploadaction\` (wire type \`fla\`, such as Extension Management's "Upload Extension..."), which uses a different protocol this tool does not serve.

Provide the file as either \`path\` (an absolute path to a local file) or \`base64\` (inline content, with \`fileName\`).

The response reports the uploaded fileName, sizeBytes, the target formId, and any dialogsOpened the AL code raised in reaction to the file (e.g. a validation error for a bad file — respond to those with bc_respond_dialog, or re-read the page with bc_read_data to see the imported rows). This tool is for pushing a file TO BC; to retrieve files FROM BC (reports, "Open in Excel"), use bc_run_report / bc_execute_action, which return downloads[].

Example (local path):  { "pageContextId": "session:page:9650:ab12", "path": "C:/tmp/layout.docx" }
Example (base64):      { "pageContextId": "session:page:9650:ab12", "base64": "UEsDBAo...", "fileName": "layout.docx" }`,
    inputSchema: toMcpJsonSchema(UploadFileSchema),
    zodSchema: UploadFileSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: (input) => ops.uploadFile.execute(input as Parameters<typeof ops.uploadFile.execute>[0]),
  };
}
