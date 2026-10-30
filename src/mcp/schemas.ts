import { z } from 'zod';

// MCP delivers params as strings or typed values — coerce everything.
// Note: .transform() breaks z.toJSONSchema(), so we keep a separate
// JSON-schema-safe version (StringOrNumberInput) for schema generation.
const StringOrNumber = z.union([z.string(), z.number()]).transform(v => String(v).trim());
const StringOrNumberInput = z.union([z.string(), z.number()]);
// Object IDs must be purely numeric — non-numeric values produce opaque BC
// failures, and characters like `&` could inject extra OpenForm query params.
const NumericId = StringOrNumber.refine(v => /^\d+$/.test(v), 'must be a numeric id');

export const OpenPageSchema = z.object({
  pageId: NumericId.describe('Numeric BC page ID (e.g., 22 for Customer List, 21 for Customer Card). Use bc_search_pages to find IDs.'),
  bookmark: z.string().optional().describe('Open the page to a specific record. Bookmarks come from list row results in bc_open_page or bc_read_data.'),
  tenantId: z.string().optional().describe('BC tenant ID. Defaults to the server-configured tenant. Only needed in multi-tenant deployments.'),
});

export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  section: z.string().optional().describe('sectionId to refresh. Defaults to "header". Examples: "lines" (document line items), "factbox:Customer Statistics" (FactBox). Listed in the bc_open_page sections array.'),
  tab: z.string().optional().describe('Tab name to filter header fields by (e.g., "General", "Invoice Details", "Shipping and Billing"). Omit to return all header fields.'),
  clearFilters: z.boolean().optional().describe('Clears agent-applied filters and restores the page to its default/native filtered state. Page-defined SourceTableView filters (set in AL code) remain active — this is NOT a guaranteed blank filter set. Use before applying new filters to avoid stacking. Applies to list-shape sections only.'),
  filters: z.array(z.object({
    column: z.string().describe('Column caption name to filter on (e.g., "City", "No.").'),
    value: z.string().describe('Filter value. Supports exact match ("London"), ranges ("10000..20000"), wildcards ("*consulting*"), expressions (">1000").'),
  })).optional().describe('Server-side filters to apply before reading. Multiple filters combine with AND logic.'),
  sort: z.object({
    column: z.string().describe('Column caption name to sort by (e.g., "Name", "No."). Must match a repeater column on the section.'),
    direction: z.enum(['asc', 'desc']).describe('"asc" for ascending (A-Z, 0-9), "desc" for descending (Z-A, 9-0).'),
  }).optional().describe('Sort the repeater by a column before reading. Applied after filters, resets BC viewport to top of sorted result. Applies to list-shape sections only. Non-sortable columns (FlowFields, BLOBs) may be rejected by BC.'),
  columns: z.array(z.string()).optional().describe('Column caption names to include in results. Omit to return all columns. Reduces output size.'),
  range: z.object({
    offset: z.number().int().min(0).describe('0-based starting row index.'),
    limit: z.number().int().min(1).describe('Maximum number of rows to return.'),
  }).optional().describe('Slice a subset of repeater rows. Returns rows[offset..offset+limit]. Use with totalRowCount for pagination.'),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page. To fill a dialog or request page, use the pageContextId of its dialogsOpened entry (bc_execute_action) or requestPage (bc_run_report).'),
  fields: z.record(z.string(), z.string()).refine(f => Object.keys(f).length > 0, { message: 'fields must contain at least one field to write' }).describe('Key-value pairs of field caption names and string values to write (e.g., { "Name": "Contoso", "City": "London" }).'),
  section: z.string().optional().describe('Section to write to (e.g., "lines" for document line items). Omit for header fields.'),
  rowIndex: z.number().int().min(0).optional().describe('0-based row position in the repeater to write to. Use for line items. Prefer bookmark for stability.'),
  bookmark: z.string().optional().describe('Stable row identifier from bc_read_data results. Preferred over rowIndex when rows may be reordered.'),
  expectedStateVersion: z.number().optional().describe('Opt-in staleness guard. Pass the stateVersion from a prior bc_read_data or bc_open_page response. If the page state has changed since that read (async events or sibling writes mutated it), the call is rejected immediately with code STALE_CONTEXT before touching BC. Omit to skip the check.'),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page.'),
  action: z.string().min(1).optional().describe('Action caption name to execute (case-insensitive). Use action OR cue, not both. Must match a visible, enabled action from bc_open_page response.'),
  cue: z.string().min(1).optional().describe('Cue tile name to drill down on (e.g. "Sales Quotes", "Pending Approvals"). Use with section pointing at the subpage that owns the cuegroup. Use action OR cue, not both.'),
  section: z.string().optional().describe('Section context. Required when using cue; optional for action. Examples: "lines", "subpage:Activities".'),
  rowIndex: z.number().int().min(0).optional().describe('0-based row position for row-scoped actions.'),
  bookmark: z.string().optional().describe('Stable row identifier for row-scoped actions.'),
  bookmarks: z.array(z.string().min(1)).optional().describe('Stable row identifiers for a MULTI-ROW action (batch delete, apply-entries). The first bookmark is the anchor/current row. Mutually exclusive with bookmark, rowIndex, and cue. Bookmarks must come from a bc_read_data of the same section and must still be loaded. Only actions that consume a selection (e.g. Delete) act on all rows; Edit/View/DrillDown/New use the anchor only and are rejected with bookmarks[].'),
  expectedStateVersion: z.number().optional().describe('Opt-in staleness guard. Pass the stateVersion from a prior bc_read_data or bc_open_page response. If the page state has changed since that read (async events or sibling writes mutated it), the call is rejected immediately with code STALE_CONTEXT before touching BC. Omit to skip the check.'),
}).superRefine((d, ctx) => {
  if (!!d.action === !!d.cue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of: action, cue' });
  }
  if (d.bookmarks && (d.bookmark !== undefined || d.rowIndex !== undefined || d.cue !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bookmarks[] is mutually exclusive with bookmark, rowIndex, and cue.' });
  }
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
  action: z.enum(['drill_down', 'select']).optional().describe('"select" moves cursor to row (default). "drill_down" opens the record detail page (returns new pageContextId). For field lookups use the bc_lookup tool.'),
  section: z.string().optional().describe('Section containing the row (e.g., "lines" for document line items). Omit for header/default repeater.'),
});

export const RespondDialogSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the page that triggered the dialog.'),
  dialogFormId: z.string().min(1).describe('Dialog form ID from the dialogsOpened array returned by bc_execute_action or bc_write_data, or requestPage.formId returned by bc_run_report.'),
  response: z.enum(['ok', 'cancel', 'yes', 'no', 'abort', 'close']).describe('"ok" confirms, "cancel" dismisses, "yes"/"no" answers a question, "abort" force-closes, "close" closes a modal info page.'),
});

export const SwitchCompanySchema = z.object({
  companyName: z.string().min(1).describe('Exact company name to switch to. Use bc_list_companies to see available company names.'),
});

const FORMAT_DESCRIBE = 'Rendered output format to capture via the BC "Send to..." flow. "pdf" captures a PDF (BC default); "excel" captures Excel (prefers "data only" layout); "word" captures a Word document. Format availability depends on the report\'s installed layouts -- reports without the requested layout return an error listing available formats. Omit to open the request page only without executing.';

export const RunReportSchema = z.object({
  reportId: NumericId.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
  format: z.enum(['pdf', 'excel', 'word']).optional().describe(FORMAT_DESCRIBE),
});

export const UploadFileSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the host page whose upload action you just invoked (e.g. page 9650 after "Import Layout"). The open FileUploadForm dialog on that page is targeted automatically.'),
  path: z.string().min(1).optional().describe('Absolute path to a local file to upload. Provide exactly one of `path` or `base64`.'),
  base64: z.string().min(1).optional().describe('Base64-encoded file content, as an alternative to `path`. Provide exactly one of `path` or `base64`.'),
  fileName: z.string().min(1).optional().describe('File name BC should see (e.g. "extension.app"). Required with `base64`; defaults to the basename of `path`.'),
  formId: z.string().min(1).optional().describe('Override the target dialog form id. By default the open FileUploadForm dialog on the page is used. Pass the form id from bc_execute_action\'s dialogsOpened to target a specific upload dialog; it must be a FileUploadForm.'),
}).refine((v) => (v.path ? 1 : 0) + (v.base64 ? 1 : 0) === 1, { message: 'Provide exactly one of `path` or `base64`.' })
  .refine((v) => !(v.base64 && !v.fileName), { message: '`fileName` is required when uploading via `base64`.' });

export const ListCompaniesSchema = z.object({});

export const GetOperationSchema = z.object({
  operationId: z.string().min(1).max(200).describe('The operationId you passed to a mutating tool (bc_write_data, bc_execute_action, ...).'),
});

export const WizardNavigateSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID returned by bc_open_page for a NavigatePage / wizard.'),
  action: z.enum(['back', 'next', 'finish', 'cancel']).describe('Wizard step navigation. "next" advances, "back" returns to previous step, "finish" completes the wizard, "cancel" aborts.'),
});

export const LookupSchema = z.object({
  pageContextId: z.string().min(1).describe('Page context ID of the open page (card or list) returned by bc_open_page.'),
  field: z.string().min(1).describe('Caption of the field to enumerate lookup candidates for (e.g., "Salesperson Code", "Gen. Bus. Posting Group"). Must be an editable FK/related-table field that has a lookup (isLookup=true in bc_open_page or bc_read_data response).'),
  search: z.string().optional().describe('Optional search string to filter candidates (e.g., "AR" to narrow to codes starting with AR). Applied via BC\'s native search on the lookup list. Omit to return all rows up to maxRows.'),
  maxRows: z.number().int().min(1).max(500).optional().describe('Maximum number of candidate rows to return. Defaults to 50. Max 500. BC may return fewer if the table has fewer records.'),
});

export const QuerySchema = z.object({
  entity: z.string().min(1).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Entity must be a valid API identifier, e.g. "salesOrders", "items"').describe('BC Standard API v2.0 entity name (camelCase). Examples: customers, vendors, items, salesOrders, salesInvoices, purchaseOrders, generalLedgerEntries, accounts, companies, employees. See BC Standard API docs for the full list.'),
  filter: z.string().optional().describe('OData $filter expression for server-side filtering. Examples: "city eq \'London\'", "amount gt 1000", "postingDate ge 2024-01-01 and postingDate le 2024-12-31", "contains(displayName, \'Contoso\')". Applied by BC before returning data.'),
  select: z.string().optional().describe('Comma-separated OData $select field names to limit response size. Examples: "number,displayName,city", "id,amount,postingDate". Omit to return all fields.'),
  top: z.number().int().min(1).optional().describe('Maximum number of rows to return. Defaults to 100 if omitted to prevent accidental full-table scans. Pass explicitly to get more rows.'),
  orderby: z.string().optional().describe('OData $orderby expression. Examples: "displayName asc", "postingDate desc", "amount desc,number asc".'),
  expand: z.string().optional().describe('OData $expand for related entities. Examples: "salesLines", "customer($select=displayName)". Use sparingly — expanded entities increase response size significantly.'),
  company: z.string().optional().describe('Override the BC company name for this query. Defaults to the server-configured company (BC_ODATA_COMPANY or first available company). Use when querying a specific company in a multi-company BC environment.'),
});

const DataCompany = z.string().min(1).optional().describe('Company to run in (exact, case-sensitive name from bc_list_companies). Defaults to the current session company, then BC_ODATA_COMPANY, then the user\'s default company in BC.');
const TableId = z.number().int().positive().describe('Numeric BC table ID (e.g., 18 Customer, 17 G/L Entry, 37 Sales Line). Find IDs with bc_data_find_tables.');

export const DataFindTablesSchema = z.object({
  searchText: z.string().min(1).describe('For searchMode "keyword": one or more comma-separated table name fragments (e.g., "customer, ledger entry"). For "semantic": a natural-language description of the data you need (e.g., "unpaid invoices from vendors").'),
  searchMode: z.enum(['keyword', 'semantic']).describe('"keyword" matches table names by substring; "semantic" searches page metadata by meaning and returns the source tables of the best-matching pages.'),
  top: z.number().int().min(1).max(50).optional().describe('Maximum number of tables to return (default 20, max 50).'),
  company: DataCompany,
});

export const DataTableSchemaSchema = z.object({
  tableId: TableId,
  fieldClass: z.enum(['Normal', 'FlowField', 'FlowFilter']).optional().describe('Only fields of this class. FlowFields are calculated (e.g., Customer "Balance (LCY)"); FlowFilters only narrow FlowField calculations.'),
  nameContains: z.array(z.string().min(1)).min(1).optional().describe('Only fields whose name contains any of these fragments (case-insensitive), e.g. ["No.", "Amount"]. Use it on wide tables to keep the answer small.'),
  company: DataCompany,
});

export const DataTableRelationsSchema = z.object({
  tableId: TableId,
  direction: z.enum(['outgoing', 'incoming']).describe('"outgoing": tables this table points to through TableRelation fields (e.g., Customer -> Country/Region). "incoming": tables that point to this one (capped at 50 source tables).'),
  relatedToTableIds: z.array(z.number().int().positive()).min(1).optional().describe('Only relations to/from these table IDs. Use it to find the join path between two known tables, or when an incoming answer was truncated.'),
  company: DataCompany,
});

export const DataQuerySchema = z.object({
  queryText: z.string().min(1).describe('Complete source of ONE AL query object, e.g. `query 50100 TopCustomers { elements { dataitem(Cust; Customer) { column(No; "No.") { } column(Name; Name) { } } } }`. Object ID and name are free (any ID works; nothing is published). Supports AL query features: joined dataitems (DataItemLink), filters (DataItemTableFilter on normal fields, ColumnFilter for FlowFields), aggregations (Method = Sum/Count/Average/Min/Max), date grouping (Method = Year/Month/Day), OrderBy. Limit rows with `top`, not TopNumberOfRows. Field names must match bc_data_get_table_schema exactly.'),
  returnData: z.boolean().optional().describe('false (default): only compile and return the column/dataitem schema — use it to check a query cheaply. true: also run it and return a page of rows.'),
  top: z.number().int().min(1).max(50).optional().describe('Rows per page when returnData is true (default 10, max 50).'),
  skip: z.number().int().min(0).max(100000).optional().describe('Rows to skip for paging (max 100000). totalCount is only returned on the first page (skip 0). Paging needs a deterministic order: add OrderBy if BC says pagination is not supported.'),
  company: DataCompany,
});

export const RunTestsSchema = z.object({
  codeunits: z.string().min(1).optional().describe('Test codeunit ID filter in BC filter syntax: a range "50490..50494", a list "50490|50492", or one ID "50490". Provide exactly one of `codeunits` or `extensionId`.'),
  extensionId: z.string().min(1).optional().describe('App ID (GUID) of the extension whose test codeunits to run. Provide exactly one of `codeunits` or `extensionId`.'),
  methods: z.string().min(1).optional().describe('Optional test procedure name filter in BC filter syntax, e.g. "TestPostInvoice" or "*Persona*|NoPersona*". Only matching methods run.'),
  suiteName: z.string().min(1).max(10).regex(/^[A-Za-z0-9_-]+$/).optional().describe('Test suite to (re)build and run. Default "MCP". Up to 10 characters. The suite\'s lines are replaced on every run; pick a different name to keep another suite (e.g. BcContainerHelper\'s "DEFAULT") untouched.'),
  testRunnerCodeunitId: z.number().int().optional().describe('Test runner codeunit. Default 130450 ("Test Runner - Isol. Codeunit", rolls back after each codeunit). 130451 runs with isolation disabled, so test writes are committed.'),
  requiredTestIsolation: z.number().int().min(0).optional().describe('Optional RequiredTestIsolation filter (0 None/Codeunit, 1 Disabled, 2 Function, per the CodeUnit Metadata option). Only applies together with testType.'),
  testType: z.number().int().min(1).optional().describe('Optional TestType filter (1 UnitTest, 2 IntegrationTest, 3 Uncategorized, per the CodeUnit Metadata option).'),
}).refine((v) => (v.codeunits ? 1 : 0) + (v.extensionId ? 1 : 0) === 1, { message: 'Provide exactly one of `codeunits` or `extensionId`.' });

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
      format: z.enum(['pdf', 'excel', 'word']).optional().describe(FORMAT_DESCRIBE),
    });
    return z.toJSONSchema(safe) as Record<string, unknown>;
  }
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-tool OUTPUT schemas (issue #40). Advertised in tools/list and matching
// the `structuredContent` each successful call returns. Top-level fields are
// precise; deeply-nested, already-typed DTOs (Section, FieldWriteResult,
// Download, SearchResult, LookupRow, OperationEntry, ...) are accepted loosely
// so a real payload never fails to validate and a forward-added nested field
// never breaks the advertised contract.
// ---------------------------------------------------------------------------

const Dialog = z.looseObject({ formId: z.string(), message: z.string().optional() });
const OpenedDialog = Dialog.extend({ pageContextId: z.string() });
const Download = z.looseObject({
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  style: z.string(),
  savedPath: z.string().optional(),
});
const ExternalUri = z.object({ uri: z.string(), style: z.string() });
const OpenedPage = z.object({ pageContextId: z.string(), caption: z.string() });
const Section = z.looseObject({});
const Loose = z.looseObject({});

export const OpenPageOutputSchema = z.object({
  pageContextId: z.string(),
  pageType: z.string(),
  caption: z.string(),
  isModal: z.boolean(),
  sections: z.array(Section),
  stateVersion: z.number(),
});

export const ReadDataOutputSchema = z.object({
  section: Section,
  stateVersion: z.number(),
});

export const WriteDataOutputSchema = z.object({
  results: z.array(Loose),
  allSucceeded: z.boolean(),
  changedSections: z.array(z.string()),
  dialogsOpened: z.array(Dialog),
  requiresDialogResponse: z.boolean(),
  validationWarnings: z.array(Loose),
  replaySafe: z.boolean(),
});

export const ExecuteActionOutputSchema = z.object({
  success: z.boolean(),
  dialog: OpenedDialog.optional(),
  updatedFields: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional(),
  changedSections: z.array(z.string()),
  openedPages: z.array(OpenedPage),
  dialogsOpened: z.array(OpenedDialog),
  requiresDialogResponse: z.boolean(),
  downloads: z.array(Download),
  externalUris: z.array(ExternalUri),
  replaySafe: z.boolean(),
});

export const ClosePageOutputSchema = z.object({
  success: z.boolean(),
  dialogsOpened: z.array(Dialog),
  requiresDialogResponse: z.boolean(),
  replaySafe: z.boolean(),
});

export const SearchPagesOutputSchema = z.object({
  results: z.array(Loose),
  note: z.string().optional(),
});

export const NavigateOutputSchema = z.object({
  targetPageContextId: z.string().optional(),
  pageType: z.string().optional(),
  sections: z.array(Section).optional(),
  changedSections: z.array(z.string()),
  dialogsOpened: z.array(Dialog),
  requiresDialogResponse: z.boolean(),
});

export const RespondDialogOutputSchema = z.object({
  success: z.boolean(),
  changedSections: z.array(z.string()),
  dialogsOpened: z.array(Dialog),
  requiresDialogResponse: z.boolean(),
  openedPages: z.array(OpenedPage),
  downloads: z.array(Download),
  externalUris: z.array(ExternalUri),
  replaySafe: z.boolean(),
});

export const SwitchCompanyOutputSchema = z.object({
  previousCompany: z.string(),
  newCompany: z.string(),
  invalidatedPageContextIds: z.array(z.string()),
  replaySafe: z.boolean(),
});

export const ListCompaniesOutputSchema = z.object({
  currentCompany: z.string(),
  companies: z.array(z.object({ name: z.string(), displayName: z.string() })),
});

export const RunReportOutputSchema = z.object({
  success: z.boolean(),
  reportId: z.number(),
  requestPage: z.looseObject({ pageContextId: z.string(), formId: z.string() }).optional(),
  dialogsOpened: z.array(Dialog),
  requiresDialogResponse: z.boolean(),
  downloads: z.array(Download),
  externalUris: z.array(ExternalUri),
  replaySafe: z.boolean(),
});

export const WizardNavigateOutputSchema = z.object({
  success: z.boolean(),
  caption: z.string(),
  fields: z.array(z.object({ name: z.string(), value: z.string().optional(), editable: z.boolean() })),
  availableNav: z.array(z.string()),
  closed: z.boolean(),
  changedSections: z.array(z.string()),
  dialogsOpened: z.array(Dialog),
  downloads: z.array(Download),
  externalUris: z.array(ExternalUri),
  replaySafe: z.boolean(),
});

export const LookupOutputSchema = z.object({
  rows: z.array(Loose),
  totalFound: z.number(),
});

export const QueryOutputSchema = z.object({
  entity: z.string(),
  rows: z.array(z.unknown()),
  rowCount: z.number(),
  count: z.number().optional(),
  cappedAt: z.number().optional(),
  hasMore: z.boolean(),
});

export const DataFindTablesOutputSchema = z.object({
  company: z.string(),
  tables: z.array(z.object({ tableId: z.number(), tableName: z.string(), score: z.number().optional() })),
});

export const DataTableSchemaOutputSchema = z.object({
  company: z.string(),
  tableId: z.number(),
  schema: z.string(),
});

export const DataTableRelationsOutputSchema = z.looseObject({
  company: z.string(),
  tableId: z.number(),
  tableName: z.string(),
  outgoing: z.array(Loose).optional(),
  incoming: z.array(Loose).optional(),
  incomingTruncated: z.boolean().optional(),
  incomingTotalCount: z.number().optional(),
  hint: z.string().optional(),
});

// One object shape for both answers (an MCP outputSchema must be an object):
// status 'compiled' carries column metadata + dataItems; 'executed' carries
// column names + rows.
export const DataQueryOutputSchema = z.object({
  company: z.string(),
  status: z.enum(['compiled', 'executed']),
  columns: z.array(z.unknown()),
  dataItems: z.array(Loose).optional(),
  rows: z.array(z.array(z.unknown())).optional(),
  rowCount: z.number().optional(),
  skip: z.number().optional(),
  top: z.number().optional(),
  totalCount: z.number().optional(),
  hasMore: z.boolean().optional(),
});

export const UploadFileOutputSchema = z.object({
  success: z.boolean(),
  fileName: z.string(),
  sizeBytes: z.number(),
  formId: z.string(),
  dialogsOpened: z.array(z.looseObject({ formId: z.string(), message: z.string().optional() })),
  replaySafe: z.boolean(),
});

export const GetOperationOutputSchema = z.looseObject({
  entry: Loose,
  readBack: Loose.optional(),
  evidenceHash: z.string().optional(),
  readBackError: z.object({ code: z.string(), message: z.string() }).optional(),
});

const TestRow = z.object({
  codeunitId: z.number(),
  codeunitName: z.string(),
  method: z.string(),
  status: z.enum(['passed', 'failed', 'skipped', 'notRun']),
  durationMs: z.number(),
  output: z.string(),
  callStack: z.string().optional(),
});

export const RunTestsOutputSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'noTests', 'aborted']),
  summary: z.object({ total: z.number(), passed: z.number(), failed: z.number(), skipped: z.number(), notRun: z.number(), durationMs: z.number() }),
  results: z.array(TestRow),
  failedTests: z.array(z.object({ codeunitId: z.number(), method: z.string() })),
  suiteName: z.string(),
  testRunnerCodeunitId: z.number(),
  aborted: z.object({ code: z.string(), message: z.string() }).optional(),
  replaySafe: z.boolean(),
});
