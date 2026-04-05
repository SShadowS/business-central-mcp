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
  section: z.string().optional().describe('Section to read from (e.g., "lines" for document line items). Omit for header/default section. Available sections listed in bc_open_page response.'),
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
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).describe('Action caption name to execute (case-insensitive). Must match a visible, enabled action from bc_open_page response (e.g., "New", "Delete", "Post", "Release").'),
  section: z.string().optional().describe('Section context for the action (e.g., "lines"). Use to disambiguate when the same action exists on header and lines.'),
  rowIndex: z.number().optional().describe('0-based row position for row-scoped actions. Use for targeting a specific row on a list.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions. Preferred over rowIndex for stability.'),
});

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
});

export const ListCompaniesSchema = z.object({});

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
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
