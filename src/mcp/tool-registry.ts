import { z } from 'zod';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
  toMcpJsonSchema,
} from './schemas.js';
import type { OpenPageOperation } from '../operations/open-page.js';
import type { ReadDataOperation } from '../operations/read-data.js';
import type { WriteDataOperation } from '../operations/write-data.js';
import type { ExecuteActionOperation } from '../operations/execute-action.js';
import type { ClosePageOperation } from '../operations/close-page.js';
import type { SearchPagesOperation } from '../operations/search-pages.js';
import type { NavigateOperation } from '../operations/navigate.js';

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
}

export function buildToolRegistry(ops: Operations): ToolDefinition[] {
  return [
    {
      name: 'bc_open_page',
      description: 'Opens a Business Central page by its page ID and returns its complete state including fields with current values, available actions, and data rows. This must be called before any other bc_ tool because it returns a pageContextId that all subsequent operations require. For Card pages (single-record views like Customer Card = page 21, Item Card = page 30), returns header fields with values and editability. For List pages (multi-record views like Customer List = page 22, Item List = page 31), returns repeater columns and data rows with bookmarks for navigation. Use bc_search_pages first if you do not know the page ID. Always call bc_close_page when done to free server resources.',
      inputSchema: toMcpJsonSchema(OpenPageSchema),
      zodSchema: OpenPageSchema,
      execute: (input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
    },
    {
      name: 'bc_read_data',
      description: 'Reads data rows from an already-open Business Central List page. Returns repeater rows with cell values and bookmarks. Optionally applies server-side filters by column name and value before reading, and selects specific columns to reduce output size. Requires a pageContextId from a prior bc_open_page call. Use this for refreshing data after actions, applying filters to narrow results, or reading specific columns. Do not use this for Card pages (single-record) -- Card page field values are already returned by bc_open_page. Filters use exact match by default; use BC filter syntax for ranges (e.g., "10000..20000") or wildcards (e.g., "*consulting*"). For Document pages with subpage sections (like Sales Order lines), use the `section` parameter (e.g., section: "lines") to read data from a specific section. Available sections are listed in the bc_open_page response. Default reads from the header section.',
      inputSchema: toMcpJsonSchema(ReadDataSchema),
      zodSchema: ReadDataSchema,
      execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
    },
    {
      name: 'bc_write_data',
      description: 'Writes field values on an already-open Business Central page. Accepts field names (matching the caption shown in the UI) and string values as key-value pairs. The server validates each field and returns the BC-confirmed value, which may differ from what was sent due to formatting or auto-completion (e.g., entering a partial customer name may resolve to the full name). Requires a pageContextId from bc_open_page. Fields must be editable -- read-only fields will return an error. Write fields one logical group at a time rather than all at once, as BC may trigger validation cascades that change dependent field values. For Document page line items, specify `section: "lines"` along with `rowIndex` (0-based position) or `bookmark` (stable row identifier from read results) to target a specific line. Fields are matched by caption name. Use bookmark for stable targeting after sorts or inserts.',
      inputSchema: toMcpJsonSchema(WriteDataSchema),
      zodSchema: WriteDataSchema,
      execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
    },
    {
      name: 'bc_execute_action',
      description: 'Executes a named action on an already-open Business Central page. Actions include standard operations like "New" (create record), "Delete" (remove record), "Post" (post document), "Release" (release document), and page-specific actions listed in the bc_open_page response. If the action triggers a confirmation dialog, the dialog details are returned in the response -- use a follow-up call with the dialog action to respond. Requires a pageContextId from bc_open_page. The action name must match a visible, enabled action caption from the page exactly (case-insensitive). Use `section` to disambiguate actions that exist on multiple sections (e.g., "Delete" on header vs lines). Specify `rowIndex` or `bookmark` to target a specific row for row-scoped actions.',
      inputSchema: toMcpJsonSchema(ExecuteActionSchema),
      zodSchema: ExecuteActionSchema,
      execute: (input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
    },
    {
      name: 'bc_close_page',
      description: 'Closes an open Business Central page and frees its server-side resources including the WebSocket form session. Always call this when done working with a page to prevent resource leaks. Requires a pageContextId from bc_open_page. After closing, the pageContextId is no longer valid for any operations. It is safe to call this even if the page encountered errors.',
      inputSchema: toMcpJsonSchema(ClosePageSchema),
      zodSchema: ClosePageSchema,
      execute: (input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
    },
    {
      name: 'bc_search_pages',
      description: 'Searches for Business Central pages by name using the built-in Tell Me search. Returns matching page names and types. Use this when you know what entity you need (e.g., "customer", "sales order", "item") but do not know the page ID. The search query matches against page captions and keywords. Results can then be used with bc_open_page. This does not require a pageContextId -- it works independently. Common pages: Customer Card (21), Customer List (22), Item Card (30), Item List (31), Sales Order (42), Vendor Card (26).',
      inputSchema: toMcpJsonSchema(SearchPagesSchema),
      zodSchema: SearchPagesSchema,
      execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
    },
    {
      name: 'bc_navigate',
      description: 'Navigates to a specific record on an open Business Central List page using its bookmark. With action "select", positions the cursor on the row without opening it -- use this before bc_execute_action to target a specific record. With action "drill_down", opens the record in its Card/Document page (e.g., drilling down from Customer List opens Customer Card) and returns the new page state with its own pageContextId. Bookmarks are returned in the rows from bc_open_page or bc_read_data. Requires a pageContextId from a List page opened via bc_open_page. Use `section` to navigate from a specific section\'s repeater (e.g., drill down from a line item). Use `field` to specify which cell to drill down or look up from.',
      inputSchema: toMcpJsonSchema(NavigateSchema),
      zodSchema: NavigateSchema,
      execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
    },
  ];
}
