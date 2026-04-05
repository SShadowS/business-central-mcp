import { z } from 'zod';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
  RespondDialogSchema,
  SwitchCompanySchema,
  ListCompaniesSchema,
  toMcpJsonSchema,
} from './schemas.js';
import type { OpenPageOperation } from '../operations/open-page.js';
import type { ReadDataOperation } from '../operations/read-data.js';
import type { WriteDataOperation } from '../operations/write-data.js';
import type { ExecuteActionOperation } from '../operations/execute-action.js';
import type { ClosePageOperation } from '../operations/close-page.js';
import type { SearchPagesOperation } from '../operations/search-pages.js';
import type { NavigateOperation } from '../operations/navigate.js';
import type { RespondDialogOperation } from '../operations/respond-dialog.js';
import type { SwitchCompanyOperation } from '../operations/switch-company.js';
import type { ListCompaniesOperation } from '../operations/list-companies.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
}

export interface Operations {
  openPage: OpenPageOperation;
  readData: ReadDataOperation;
  writeData: WriteDataOperation;
  executeAction: ExecuteActionOperation;
  closePage: ClosePageOperation;
  searchPages: SearchPagesOperation;
  navigate: NavigateOperation;
  respondDialog: RespondDialogOperation;
  switchCompany: SwitchCompanyOperation;
  listCompanies: ListCompaniesOperation;
}

export function buildToolRegistry(ops: Operations): ToolDefinition[] {
  return [
    {
      name: 'bc_open_page',
      description: `Opens a Business Central page by its numeric page ID and returns its complete state: fields with current values and editability, available actions, data rows with bookmarks, and section metadata. This is the entry point for all Business Central operations -- it returns a pageContextId that every other bc_ tool requires as input. Use bc_search_pages first if you do not know the page ID for an entity.

Card pages (single-record views like Customer Card=21, Item Card=30) return header fields with values. List pages (multi-record views like Customer List=22, Item List=31) return repeater columns, data rows, and bookmarks for navigation. Document pages (Sales Order=42, Purchase Order=50) return both header fields and a "lines" section with line item rows.

Typical workflow: bc_open_page -> bc_read_data (filter/refresh) -> bc_write_data (edit fields) -> bc_execute_action (post/release/delete) -> bc_close_page. Always call bc_close_page when done to free server resources. Do NOT call this if the page is already open -- reuse the existing pageContextId instead.

Optional bookmark parameter opens a Card page to a specific record (e.g., open Customer Card for customer "10000"). Bookmarks come from bc_read_data or bc_open_page list row results.

Example: { "pageId": 22 } opens Customer List. { "pageId": 21, "bookmark": "XXXX" } opens Customer Card for a specific customer.`,
      inputSchema: toMcpJsonSchema(OpenPageSchema),
      zodSchema: OpenPageSchema,
      execute: (input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
    },
    {
      name: 'bc_read_data',
      description: `Reads data rows from an already-open Business Central List or Document page. Returns repeater rows with cell values and bookmarks for navigation. Requires a pageContextId obtained from a prior bc_open_page call. Use this to refresh data after write/action operations, apply server-side filters, select specific columns, or read from a specific page section.

Do NOT use this for Card pages (single-record views) -- Card field values are already returned by bc_open_page. Use this only for pages that have repeater sections (lists, document lines).

Filtering: Pass an array of { column, value } objects in the filters parameter. Column names must match the displayed column caption. Values use BC filter syntax: exact match ("10000"), ranges ("10000..20000"), wildcards ("*consulting*"), or expressions (">1000"). Multiple filters combine with AND logic.

Column selection: Pass a columns array with column caption names to return only those columns, reducing output size. Omit to return all columns.

Section targeting: For Document pages (Sales Order, Purchase Order), use section: "lines" to read line item rows instead of header data. Available section names are listed in the bc_open_page response under sections.

Examples:
- Read all customers: { "pageContextId": "abc" }
- Filter by city: { "pageContextId": "abc", "filters": [{ "column": "City", "value": "London" }] }
- Read only No. and Name: { "pageContextId": "abc", "columns": ["No.", "Name"] }
- Read Sales Order lines: { "pageContextId": "abc", "section": "lines" }
- Filter with range: { "pageContextId": "abc", "filters": [{ "column": "No.", "value": "10000..20000" }] }`,
      inputSchema: toMcpJsonSchema(ReadDataSchema),
      zodSchema: ReadDataSchema,
      execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
    },
    {
      name: 'bc_write_data',
      description: `Writes one or more field values on an already-open Business Central page. Pass a fields object with caption-name keys and string values. BC validates each field and returns the server-confirmed value, which may differ from input due to formatting, auto-completion, or lookups (e.g., entering a partial customer name resolves to the full match). Requires a pageContextId from bc_open_page.

Fields must be editable -- writing to a read-only field returns an error. Write related fields together in one call (e.g., quantity and unit price), but avoid writing unrelated groups together because BC validation cascades may change dependent fields in unexpected order. Check the returned confirmed values to see what BC actually stored.

For Document page line items (Sales Order lines, Purchase Order lines), specify section: "lines" to write to the lines repeater. Use rowIndex (0-based row position) or bookmark (stable row identifier from bc_read_data results) to target a specific line. Prefer bookmark over rowIndex when rows may have been reordered or inserted since the last read.

Do NOT use this for triggering actions like Post, Delete, or Release -- use bc_execute_action instead. Do NOT use this for navigating to records -- use bc_navigate instead.

Examples:
- Write to Card header: { "pageContextId": "abc", "fields": { "Name": "Contoso Ltd", "Address": "123 Main St" } }
- Write to Sales Order line: { "pageContextId": "abc", "section": "lines", "rowIndex": 0, "fields": { "Quantity": "5", "Unit Price": "100" } }
- Write with bookmark targeting: { "pageContextId": "abc", "section": "lines", "bookmark": "XXXX", "fields": { "Description": "Consulting Services" } }`,
      inputSchema: toMcpJsonSchema(WriteDataSchema),
      zodSchema: WriteDataSchema,
      execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
    },
    {
      name: 'bc_execute_action',
      description: `Executes a named action on an already-open Business Central page. Actions include standard operations (New, Delete, Refresh, Edit, Post, Release) and page-specific actions visible in the bc_open_page response under each section's actions array. Requires a pageContextId from bc_open_page. The action name is matched case-insensitively against the action caption.

If the action triggers a confirmation dialog or modal page, the response includes a dialogsOpened array with the dialog's formId and details. When requiresDialogResponse is true, you must follow up with bc_respond_dialog to confirm or cancel. Always check the response for dialogs before proceeding.

Row-scoped actions (Delete, Edit on a list row) require targeting a specific row. Use rowIndex (0-based) or bookmark to specify which row the action applies to. For Document pages, use section to disambiguate between header and line actions (e.g., "Delete" on header deletes the whole document, "Delete" on "lines" deletes one line).

Do NOT use this for writing field values -- use bc_write_data. Do NOT use this to open records from a list -- use bc_navigate with drill_down action instead.

Examples:
- Create new record: { "pageContextId": "abc", "action": "New" }
- Delete a specific row: { "pageContextId": "abc", "action": "Delete", "bookmark": "XXXX" }
- Post a Sales Order: { "pageContextId": "abc", "action": "Post" }
- Delete a document line: { "pageContextId": "abc", "action": "Delete", "section": "lines", "rowIndex": 2 }`,
      inputSchema: toMcpJsonSchema(ExecuteActionSchema),
      zodSchema: ExecuteActionSchema,
      execute: (input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
    },
    {
      name: 'bc_close_page',
      description: `Closes an open Business Central page and frees its server-side resources including the WebSocket form session. Always call this when you are finished working with a page to prevent resource leaks on the BC server. Requires a pageContextId from bc_open_page.

After closing, the pageContextId becomes invalid -- any subsequent bc_read_data, bc_write_data, bc_execute_action, or bc_navigate calls using it will fail. It is safe to call this even if prior operations on the page encountered errors. If you opened a drill-down page via bc_navigate (which returns a new pageContextId), close both the drill-down page and the original list page when done.

Do NOT call this in the middle of a multi-step workflow -- finish all reads, writes, and actions on the page first. Do NOT call this to "reset" a page; use bc_read_data to refresh data instead.`,
      inputSchema: toMcpJsonSchema(ClosePageSchema),
      zodSchema: ClosePageSchema,
      execute: (input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
    },
    {
      name: 'bc_search_pages',
      description: `Searches for Business Central pages by name using the built-in Tell Me search feature. Returns matching page names, types, and IDs that can be passed to bc_open_page. Use this when you know what business entity you need to work with (e.g., "customer", "sales order", "item", "vendor", "general ledger") but do not know the numeric page ID.

This is the only bc_ tool that does NOT require a pageContextId -- it works independently as a discovery step before bc_open_page. The search query matches against page captions and keywords using fuzzy matching, so partial names work (e.g., "cust" finds Customer List, Customer Card, etc.).

Do NOT use this if you already know the page ID -- call bc_open_page directly. Do NOT use this to search for data within a page -- use bc_read_data with filters instead.

Common pages for reference: Customer List (22), Customer Card (21), Item List (31), Item Card (30), Sales Order (42), Sales Orders (9305), Vendor Card (26), Vendor List (27), Chart of Accounts (16), General Ledger Entries (20), Purchase Order (50).

Example: { "query": "sales order" }`,
      inputSchema: toMcpJsonSchema(SearchPagesSchema),
      zodSchema: SearchPagesSchema,
      execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
    },
    {
      name: 'bc_navigate',
      description: `Navigates to a specific record on an open Business Central List or Document page using its bookmark. Supports three actions: "select" positions the cursor on a row without opening it, "drill_down" opens the record in its Card/Document page, and "lookup" triggers the lookup action on a specific field. Requires a pageContextId from bc_open_page and a bookmark from row data returned by bc_open_page or bc_read_data.

Action "select" (default): Positions the cursor on the specified row. Use this before bc_execute_action when you need to target a specific record for an action like Delete. Does NOT open the record or return new data -- it only moves the selection.

Action "drill_down": Opens the record's detail page (e.g., drilling down from Customer List opens Customer Card, drilling down from Sales Orders opens Sales Order). Returns a NEW pageContextId for the opened Card/Document page with its full state. The original List page remains open. Remember to bc_close_page both pages when done.

Action "lookup": Triggers a lookup on a specific field (specified via the field parameter) to open the related entity's list for selection.

Section and field targeting: Use section (e.g., "lines") to navigate within a Document page's subpage repeater. Use field to specify which column to drill down or look up from (e.g., field: "No." to drill down on the item number column).

Do NOT use this for Card pages -- it only works on pages with repeater rows. Do NOT confuse "select" with "drill_down": select just moves the cursor, drill_down opens a new page.

Examples:
- Select a row: { "pageContextId": "abc", "bookmark": "XXXX", "action": "select" }
- Drill down to Card: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down" }
- Drill down on a line item field: { "pageContextId": "abc", "bookmark": "XXXX", "action": "drill_down", "section": "lines", "field": "No." }`,
      inputSchema: toMcpJsonSchema(NavigateSchema),
      zodSchema: NavigateSchema,
      execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
    },
    {
      name: 'bc_respond_dialog',
      description: `Responds to an open Business Central dialog or confirmation prompt. Dialogs are triggered by bc_execute_action or bc_write_data when BC requires user confirmation (e.g., "Do you want to post?", "Delete this record?", validation warnings). When those tools return a dialogsOpened array with requiresDialogResponse: true, you MUST call this tool to continue the workflow.

The dialogFormId comes from the dialogsOpened array in the triggering tool's response. The response parameter accepts: "ok" (confirm/accept), "cancel" (dismiss/abort), "yes" or "no" (answer a yes/no question), "abort" (force-close), or "close" (close a modal information page). Choose the response that matches the dialog's intent -- confirmation dialogs typically need "yes", acceptance dialogs need "ok".

After responding, check the changedSections array in the result to see which page sections were affected. For example, posting a Sales Order may change all sections. If the dialog response triggers another dialog (chained confirmations), the response will include a new dialogsOpened array -- respond to each dialog in sequence.

Do NOT call this without a preceding dialog -- there is no dialog to respond to unless dialogsOpened was returned by bc_execute_action or bc_write_data. Do NOT guess the dialogFormId -- always use the exact value from the dialogsOpened response.

Example: { "pageContextId": "abc", "dialogFormId": "dialog-123", "response": "yes" }`,
      inputSchema: toMcpJsonSchema(RespondDialogSchema),
      zodSchema: RespondDialogSchema,
      execute: (input) => ops.respondDialog.execute(input as Parameters<typeof ops.respondDialog.execute>[0]),
    },
    {
      name: 'bc_switch_company',
      description: `Switch to a different company within the current Business Central session. All currently open pages will be invalidated and their pageContextIds will become unusable -- you must call bc_open_page to re-open any pages you need in the new company context.

Use bc_list_companies first to see the available company names and verify the target company exists. The companyName must be an exact match. After switching, all subsequent bc_open_page, bc_read_data, bc_write_data, and bc_execute_action calls will operate against the new company's data.

Do NOT switch companies in the middle of a multi-step workflow (e.g., between creating a Sales Order and posting it). Complete all operations in the current company first, then switch.

Example: { "companyName": "CRONUS International Ltd." }`,
      inputSchema: toMcpJsonSchema(SwitchCompanySchema),
      zodSchema: SwitchCompanySchema,
      execute: (input) => ops.switchCompany.execute(input as Parameters<typeof ops.switchCompany.execute>[0]),
    },
    {
      name: 'bc_list_companies',
      description: `List all companies available in the current Business Central environment. Returns an array of company names along with the currently active company name. Use this before bc_switch_company to verify the target company exists and to discover available companies.

This tool opens the BC Companies system page internally, reads all entries, and closes it. It does not affect your currently open pages or session state. No parameters are required.

Do NOT use this if you already know the company name -- call bc_switch_company directly. If you need to work with data in a specific company, use bc_switch_company followed by bc_open_page.`,
      inputSchema: toMcpJsonSchema(ListCompaniesSchema),
      zodSchema: ListCompaniesSchema,
      execute: () => ops.listCompanies.execute(),
    },
  ];
}
