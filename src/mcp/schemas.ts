import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything.
// Note: .transform() breaks z.toJSONSchema(), so we keep a separate
// JSON-schema-safe version (StringOrNumberInput) for schema generation.
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());
const StringOrNumberInput = z.union([z.string(), z.number()]);

export const OpenPageSchema = z.object({
  pageId: StringOrNumber.describe('Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.'),
  bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
  tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  section: z.string().optional().describe('sectionId to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array.'),
  tab: z.string().optional().describe('Tab name to filter header fields by (e.g., "General", "Invoice Details", "Shipping and Billing"). Omit to return all header fields.'),
  filters: z.array(z.object({
    column: z.string().describe('Column caption name to filter on (e.g., "City", "No.").'),
    value: z.string().describe('Filter value. Supports exact match ("London"), ranges ("10000..20000"), wildcards ("*consulting*"), expressions (">1000").'),
  })).optional().describe('Server-side filters to apply before reading. Multiple filters combine with AND logic.'),
  columns: z.array(z.string()).optional().describe('Column caption names to include in results. Omit to return all columns. Reduces output size.'),
  range: z.object({
    offset: z.number().describe('0-based starting row index.'),
    limit: z.number().describe('Maximum number of rows to return.'),
  }).optional().describe('Slice a subset of repeater rows. Returns rows[offset..offset+limit]. Use with totalRowCount for pagination.'),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  fields: z.record(z.string(), z.string()).describe('Key-value pairs of field caption names and string values to write (e.g., { "Name": "Contoso", "City": "London" }).'),
  section: z.string().optional().describe('Section to write to (e.g., "lines" for document line items). Omit for header fields.'),
  rowIndex: z.number().optional().describe('0-based row position in the repeater to write to. Use for line items. Prefer bookmark for stability.'),
  bookmark: z.string().optional().describe('Stable row identifier from bc_read_data results. Preferred over rowIndex when rows may be reordered.'),
  expectedStateVersion: z.number().optional().describe('Opt-in staleness guard. Pass the stateVersion from a prior bc_read_data or bc_open_page response. If the page state has changed since that read (async events or sibling writes mutated it), the call is rejected immediately with code STALE_CONTEXT before touching BC. Omit to skip the check.'),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).optional().describe('Action caption name to execute (case-insensitive). Use action OR cue, not both. Must match a visible, enabled action from bc_open_page response.'),
  cue: z.string().min(1).optional().describe('Cue tile name to drill down on (e.g. "Sales Quotes", "Pending Approvals"). Use with section pointing at the subpage that owns the cuegroup. Use action OR cue, not both.'),
  section: z.string().optional().describe('Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Activities".'),
  rowIndex: z.number().optional().describe('0-based row position for row-scoped actions.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions.'),
  expectedStateVersion: z.number().optional().describe('Opt-in staleness guard. Pass the stateVersion from a prior bc_read_data or bc_open_page response. If the page state has changed since that read (async events or sibling writes mutated it), the call is rejected immediately with code STALE_CONTEXT before touching BC. Omit to skip the check.'),
}).refine(d => !!d.action !== !!d.cue, { message: 'Provide exactly one of: action, cue' });

export const ClosePageSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page. Becomes invalid after closing.'),
});

export const SearchPagesSchema = z.object({
  query: z.string().min(1).describe('Search term matching BC page names and keywords (e.g., "customer", "sales order", "chart of accounts"). Fuzzy matching supported.'),
});

export const NavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the List or Document page containing the row to navigate to.'),
  bookmark: z.string().min(1).describe('Row bookmark from bc_open_page or bc_read_data results identifying which record to navigate to.'),
  action: z.enum(['drill_down', 'select', 'lookup']).optional().describe('"select" moves cursor to row (default). "drill_down" opens the record detail page (returns new pageContextId). "lookup" triggers field lookup.'),
  section: z.string().optional().describe('Section containing the row (e.g., "lines" for document line items). Omit for header/default repeater.'),
  field: z.string().optional().describe('Column caption to drill down or look up from (e.g., "No." to drill down on item number). Omit to use the default drill-down column.'),
});

export const RespondDialogSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the page that triggered the dialog.'),
  dialogFormId: z.string().min(1).describe('Dialog form ID from the dialogsOpened array returned by bc_execute_action or bc_write_data.'),
  response: z.enum(['ok', 'cancel', 'yes', 'no', 'abort', 'close']).describe('"ok" confirms, "cancel" dismisses, "yes"/"no" answers a question, "abort" force-closes, "close" closes a modal info page.'),
});

export const SwitchCompanySchema = z.object({
  companyName: z.string().min(1).describe('Exact company name to switch to. Use bc_list_companies to see available company names.'),
});

export const RunReportSchema = z.object({
  reportId: StringOrNumber.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
  format: z.enum(['pdf', 'excel', 'word']).optional().describe('Rendered output format to capture. "pdf" captures a PDF via the BC "Send to..." flow. Omit to open the request page only without executing.'),
});

export const ListCompaniesSchema = z.object({});

export const WizardNavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page for a NavigatePage / wizard.'),
  action: z.enum(['back', 'next', 'finish', 'cancel']).describe('Wizard step navigation. "next" advances, "back" returns to previous step, "finish" completes the wizard, "cancel" aborts.'),
});

/**
 * Generate MCP-compatible JSON schema from a Zod schema.
 * Handles the OpenPageSchema specially since it uses .transform() which
 * z.toJSONSchema() cannot represent. All other schemas pass through directly.
 */
export function toMcpJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // OpenPageSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === OpenPageSchema) {
    const safe = z.object({
      pageId: StringOrNumberInput.describe('Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.'),
      bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
      tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  // RunReportSchema uses StringOrNumber with .transform() — use the safe variant
  if (schema === RunReportSchema) {
    const safe = z.object({
      reportId: StringOrNumberInput.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
      format: z.enum(['pdf', 'excel', 'word']).optional().describe('Rendered output format to capture. "pdf" captures a PDF via the BC "Send to..." flow. Omit to open the request page only without executing.'),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
