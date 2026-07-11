// src/mcp/prompts.ts
//
// MCP prompt templates (the `prompts/*` primitive of the MCP spec). Each prompt
// is a parameterized, reusable playbook that seeds the client's model with the
// correct multi-step choreography over this server's bc_* tools — encoding the
// protocol gotchas (section targeting, dialog handling, business-error
// classification, dimensions sub-editor, report request pages) so an agent
// does not have to rediscover them.
//
// A prompt is pure data + a `build(args)` that returns MCP prompt messages. It
// needs no BC session, so the set is constructed once and shared across the
// HTTP and stdio entry points.

export interface PromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface PromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: { readonly type: 'text'; readonly text: string };
}

export interface PromptResult {
  readonly description: string;
  readonly messages: PromptMessage[];
}

export interface PromptDefinition {
  readonly name: string;
  readonly description: string;
  readonly arguments: PromptArgument[];
  readonly build: (args: Record<string, string>) => PromptResult;
}

/** One `user` message carrying the filled-in playbook. */
function userPlaybook(description: string, text: string): PromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Value of an optional arg, or a readable placeholder for the template. */
function opt(args: Record<string, string>, key: string, placeholder: string): string {
  const v = args[key];
  return v && v.trim() ? v.trim() : placeholder;
}

function has(args: Record<string, string>, key: string): boolean {
  return typeof args[key] === 'string' && args[key]!.trim().length > 0;
}

const CORE_NOTE =
  'Every page-scoped tool threads a `pageContextId` returned by bc_open_page. ' +
  'Pass `section` ("header" | "lines" | "factbox:<Name>" | "subpage:<Name>") to target a sub-form; ' +
  'omit it for the main/header form. Address list rows by their `bookmark` (from bc_read_data), not position.';

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'bc_find_page',
    description: 'Find a Business Central page or report by natural-language name and open it.',
    arguments: [
      { name: 'query', description: 'What to find, e.g. "customer list", "sales orders", "trial balance report".', required: true },
    ],
    build: (a) => userPlaybook(
      `Find and open: ${opt(a, 'query', '<query>')}`,
      `Goal: locate and open the Business Central object for "${opt(a, 'query', '<query>')}".

Steps:
1. Call bc_search_pages { query: "${opt(a, 'query', '<query>')}" }. Results carry \`objectType\` ('page' | 'report' | ...), \`name\`, and \`runTarget\`.
2. Pick the best match. If it is a page, call bc_open_page with its numeric id (use bc_search_pages hits to resolve the id). If it is a report, use the bc_report workflow instead.
3. After bc_open_page, report the returned \`sections\` and \`stateVersion\` so the caller knows what is available.

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_read_list',
    description: 'Open a list page, apply filters/sorting, and read a slice of rows.',
    arguments: [
      { name: 'page', description: 'Numeric page id (e.g. 22 = Customer List) or the page name to search for.', required: true },
      { name: 'filters', description: 'Filter conditions in plain terms, e.g. "City = London, Balance > 1000". Optional.', required: false },
      { name: 'sort', description: 'Sort column + direction, e.g. "Name asc". Optional.', required: false },
      { name: 'columns', description: 'Comma-separated columns to return. Optional (returns all).', required: false },
    ],
    build: (a) => userPlaybook(
      `Read list: ${opt(a, 'page', '<page>')}`,
      `Goal: read rows from list page "${opt(a, 'page', '<page>')}"${has(a, 'filters') ? ` filtered by: ${a['filters']}` : ''}${has(a, 'sort') ? `, sorted by ${a['sort']}` : ''}.

Steps:
1. Resolve the page id (bc_search_pages if a name was given), then bc_open_page.
2. Call bc_read_data on the pageContextId with:
   - clearFilters: true first if you need a clean filter set (page-defined SourceTableView filters still apply).
   ${has(a, 'filters') ? `- filters: translate "${a['filters']}" into [{ column, value }] entries. Values support ranges ("10000..20000"), wildcards ("*ltd*"), and expressions (">1000").` : '- filters: [{ column, value }] as needed.'}
   ${has(a, 'sort') ? `- sort: { column, direction } for "${a['sort']}".` : '- sort: { column, direction } if ordering matters.'}
   ${has(a, 'columns') ? `- columns: [${a['columns']!.split(',').map(c => `"${c.trim()}"`).join(', ')}].` : '- columns: [ ... ] to trim the payload if you only need some.'}
   - range: { offset, limit } to page through large lists; use \`totalRowCount\` to know when to stop.
3. For bulk/analytical reads that do not need the UI, prefer the bc_bulk_read workflow (OData) instead.

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_edit_record',
    description: 'Open a card page to a record and set field values safely (with lookup + validation handling).',
    arguments: [
      { name: 'page', description: 'Numeric card page id (e.g. 21 = Customer Card) or its name.', required: true },
      { name: 'bookmark', description: 'Row bookmark of the record to edit (from a prior list read). Optional if opening a fresh/new card.', required: false },
      { name: 'fields', description: 'Fields to set, e.g. "Name = Contoso, Salesperson Code = JR". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Edit record on: ${opt(a, 'page', '<page>')}`,
      `Goal: set fields on a record of "${opt(a, 'page', '<page>')}"${has(a, 'fields') ? `: ${a['fields']}` : ''}.

Steps:
1. bc_open_page for the card${has(a, 'bookmark') ? ` (open the list and bc_navigate { action: "drill_down", bookmark: "${a['bookmark']}" } to reach this record, or open the card with the bookmark)` : ''}. Note the returned \`stateVersion\`.
2. bc_read_data (section "header") to see current field values, which fields are \`editable\`, and any \`options\`/\`selectedOption\` for enum fields or \`isLookup\` for related-table fields.
3. For each field to change:
   - Enum/option field: pick a value from its \`options\` array.
   - Lookup field (\`isLookup: true\`): call bc_lookup { field, search } to list valid values, then write the chosen code.
   - Then bc_write_data { fields: { "<caption>": "<value>" }, expectedStateVersion: <stateVersion> }.
4. If a write returns VALIDATION_ERROR, read the hint, correct the value (often via bc_lookup), and retry. Re-read stateVersion after any change.
5. Card edits persist on navigation; close with bc_close_page when done.

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_create_document',
    description: 'Create a new document (sales/purchase order, invoice) with header fields and line items.',
    arguments: [
      { name: 'page', description: 'Numeric document page id (e.g. 42 = Sales Order) or its name.', required: true },
      { name: 'header', description: 'Header fields, e.g. "Sell-to Customer No. = 10000". Optional.', required: false },
      { name: 'lines', description: 'Lines to add, e.g. "Item 1000 qty 5; Item 1001 qty 2". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Create document on: ${opt(a, 'page', '<page>')}`,
      `Goal: create a document on "${opt(a, 'page', '<page>')}"${has(a, 'header') ? ` with header ${a['header']}` : ''}${has(a, 'lines') ? ` and lines ${a['lines']}` : ''}.

Steps:
1. bc_open_page for the document page. It exposes a "header" section and a "lines" section (the sub-form repeater).
2. bc_execute_action { action: "New" } to start a fresh document (if not already on a blank one).
3. Header: bc_write_data { section: "header", fields: { ... } }. Set the primary key/party field first (e.g. Sell-to Customer No.) — it triggers defaulting of other header fields.
4. Lines (repeat per line): bc_execute_action { action: "New", section: "lines" } to add a draft row, then bc_write_data { section: "lines", bookmark: "<new-row-bookmark>", fields: { "Type": "Item", "No.": "...", "Quantity": "..." } }. Re-read the lines section (bc_read_data { section: "lines" }) to get the new row's bookmark and confirm defaulted values (description, price).
5. Watch for VALIDATION_ERROR (bad item/quantity) and BUSINESS_ERROR (e.g. credit limit) and surface them.
6. To post the finished document, chain into the bc_post_document workflow.

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_post_document',
    description: 'Post a sales/purchase document (or run a document action) and handle the confirm dialog + result.',
    arguments: [
      { name: 'page', description: 'Document page id (e.g. 42 = Sales Order) or name.', required: true },
      { name: 'bookmark', description: 'Bookmark of the document to post (from a list read). Optional if the document is already open.', required: false },
      { name: 'action', description: 'Action caption to invoke. Optional (defaults to "Post").', required: false },
    ],
    build: (a) => userPlaybook(
      `Post document on: ${opt(a, 'page', '<page>')}`,
      `Goal: run "${opt(a, 'action', 'Post')}" on a document of "${opt(a, 'page', '<page>')}".

Steps:
1. Open the document: bc_open_page, then ${has(a, 'bookmark') ? `bc_navigate { action: "drill_down", bookmark: "${a['bookmark']}" }` : 'navigate/drill down to the target document'}.
2. bc_execute_action { action: "${opt(a, 'action', 'Post')}" }. The action may sit under a "Related"/"Posting" group — if not found, the error lists the section that holds it; retry with that \`section\`.
3. If the response has \`requiresDialogResponse: true\`, answer the confirm dialog with bc_respond_dialog { dialogFormId, response: "yes" } (or "ok"). A posting choice dialog ("Ship and Invoice") may need a selection before confirming.
4. Check the result: a BUSINESS_ERROR means the post was rejected (surface the message). Success may open a posted document — its pageContextId appears in \`openedPages\`.
5. Do NOT retry a post blindly after an error; read the message first.

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_set_dimensions',
    description: 'Read or set dimensions on a document or card via the Dimensions sub-editor.',
    arguments: [
      { name: 'page', description: 'Host document/card page id or name (e.g. 42 = Sales Order, 21 = Customer Card).', required: true },
      { name: 'bookmark', description: 'Bookmark of the host record. Optional if already open.', required: false },
      { name: 'dimension', description: 'Dimension Code to set, e.g. "DEPARTMENT". Optional (omit to just read).', required: false },
      { name: 'value', description: 'Dimension Value Code to set, e.g. "ADM". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Dimensions on: ${opt(a, 'page', '<page>')}`,
      `Goal: ${has(a, 'dimension') ? `set dimension ${a['dimension']}${has(a, 'value') ? ` = ${a['value']}` : ''} on` : 'read the dimensions of'} a record of "${opt(a, 'page', '<page>')}".

Steps:
1. Open the host record: bc_open_page${has(a, 'bookmark') ? ` then drill down to bookmark "${a['bookmark']}"` : ''}.
2. bc_execute_action { action: "Dimensions" } (often under a "Related" section — pass that \`section\` if needed). The dimensions editor opens as a non-modal list page; its pageContextId is in \`openedPages\`.
3. bc_read_data on that dimensions pageContextId. Columns: "Dimension Code", "Dimension Value Code", "Dimension Value Name", "Value Posting".
${has(a, 'dimension') ? `4. Find (or add) the row for "${a['dimension']}". New rows use synthetic DraftRecord bookmarks and are writable immediately.
5. To choose a value, bc_lookup { field: "Dimension Value Code", search: "${opt(a, 'value', '')}" } to see valid codes, then bc_write_data targeting the "Dimension Value Code" column on that row's bookmark. An invalid code returns VALIDATION_ERROR.
6. Commit: bc_execute_action { action: "OK" } or bc_close_page on the dimensions page.` : '4. Report the current dimension rows.'}

${CORE_NOTE}`,
    ),
  },

  {
    name: 'bc_report',
    description: 'Run a Business Central report: fill its request page and/or capture the rendered output.',
    arguments: [
      { name: 'reportId', description: 'Numeric report id (e.g. 6 = Trial Balance, 1306 = Customer Statement).', required: true },
      { name: 'format', description: 'Capture format: "pdf", "excel", or "word". Optional (omit to only open the request page).', required: false },
      { name: 'parameters', description: 'Request-page parameters/filters to set, e.g. "Date Filter = 2026". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Run report ${opt(a, 'reportId', '<id>')}`,
      `Goal: run report ${opt(a, 'reportId', '<id>')}${has(a, 'format') ? ` and capture ${a['format']}` : ''}.

Steps:
${has(a, 'parameters')
        ? `1. bc_run_report { reportId: ${opt(a, 'reportId', '<id>')} } (no format) to open the request page. It returns a \`requestPage.pageContextId\`.
2. bc_write_data on that pageContextId to set parameters/filters: ${a['parameters']}.
3. Run it: bc_respond_dialog { dialogFormId: requestPage.formId, response: "ok" }${has(a, 'format') ? ' — note: inline output capture is only wired through the format path in step 4' : ''}.`
        : `1. If the report needs no parameters, ${has(a, 'format') ? `capture directly: bc_run_report { reportId: ${opt(a, 'reportId', '<id>')}, format: "${a['format']}" } → returns \`download.bytes\` (base64), contentType, fileName.` : `bc_run_report { reportId: ${opt(a, 'reportId', '<id>')} } opens the request page; fill it via bc_write_data on \`requestPage.pageContextId\` then bc_respond_dialog { response: "ok" }.`}`}
${has(a, 'format') ? `${has(a, 'parameters') ? '4' : '2'}. To capture output, bc_run_report { reportId: ${opt(a, 'reportId', '<id>')}, format: "${a['format']}" }. "pdf" is BC's default; "excel"/"word" require the report to have that layout (an error lists available formats). Set BC_REPORT_DIR to also save to disk.` : ''}
Note: a report is a processing/printing object — do not confuse it with a page. Use bc_open_page/bc_read_data for viewing data.`,
    ),
  },

  {
    name: 'bc_bulk_read',
    description: 'Bulk-read structured data via BC OData (Standard API v2.0) without opening any UI page.',
    arguments: [
      { name: 'entity', description: 'API entity name (camelCase), e.g. customers, items, salesOrders, generalLedgerEntries.', required: true },
      { name: 'filter', description: 'OData $filter, e.g. "city eq \'London\'", "amount gt 1000". Optional.', required: false },
      { name: 'select', description: 'Comma-separated fields to return, e.g. "number,displayName,city". Optional.', required: false },
      { name: 'orderby', description: 'OData $orderby, e.g. "displayName asc". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Bulk read: ${opt(a, 'entity', '<entity>')}`,
      `Goal: read "${opt(a, 'entity', '<entity>')}" in bulk via OData.

Steps:
1. Call bc_query {
     entity: "${opt(a, 'entity', '<entity>')}",
${has(a, 'filter') ? `     filter: "${a['filter']}",\n` : ''}${has(a, 'select') ? `     select: "${a['select']}",\n` : ''}${has(a, 'orderby') ? `     orderby: "${a['orderby']}",\n` : ''}     top: <n>   // defaults to 100; raise deliberately for larger scans
   }
2. bc_query is company-scoped automatically; pass \`company\` to target a specific company in a multi-company tenant (see bc_list_companies).
3. Use this for reporting/analysis/aggregation where you do not need the interactive page. For editing or actions, use bc_open_page + the page tools instead.
4. The special \`companies\` entity is a top-level list (not company-scoped) — query it to discover available companies.`,
    ),
  },

  {
    name: 'bc_run_wizard',
    description: 'Drive an assisted-setup / NavigatePage wizard step by step to completion.',
    arguments: [
      { name: 'page', description: 'Numeric wizard/NavigatePage page id or its name (e.g. an Assisted Setup guide).', required: true },
      { name: 'values', description: 'Values to enter across steps, e.g. "Company Name = Contoso; Country = US". Optional.', required: false },
    ],
    build: (a) => userPlaybook(
      `Run wizard: ${opt(a, 'page', '<page>')}`,
      `Goal: complete the wizard "${opt(a, 'page', '<page>')}"${has(a, 'values') ? ` entering ${a['values']}` : ''}.

Steps:
1. bc_open_page for the wizard. It opens as a NavigatePage; bc_read_data shows only the current step's fields.
2. Per step: bc_read_data to see the visible fields, bc_write_data to fill them${has(a, 'values') ? ` (from: ${a['values']})` : ''}, then bc_wizard_navigate { action: "next" }. Use "back" to revise a prior step.
3. The client owns the step counter — after "next"/"back" re-read to see the new step's fields.
4. On the final step, bc_wizard_navigate { action: "finish" } to complete (or "cancel" to abort). Check for BUSINESS_ERROR raised on finish.

${CORE_NOTE}`,
    ),
  },
];
