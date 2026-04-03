import { z } from 'zod';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
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
      name: 'open_page',
      description: 'Open a Business Central page by ID. Returns page metadata, fields, actions, and data rows.',
      inputSchema: z.toJSONSchema(OpenPageSchema) as Record<string, unknown>,
      zodSchema: OpenPageSchema,
      execute: (input) => ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]),
    },
    {
      name: 'read_data',
      description: 'Read data rows from an open page. Optionally apply filters and select columns.',
      inputSchema: z.toJSONSchema(ReadDataSchema) as Record<string, unknown>,
      zodSchema: ReadDataSchema,
      execute: (input) => ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]),
    },
    {
      name: 'write_data',
      description: 'Write field values on an open page. Provide field names and values as key-value pairs.',
      inputSchema: z.toJSONSchema(WriteDataSchema) as Record<string, unknown>,
      zodSchema: WriteDataSchema,
      execute: (input) => ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]),
    },
    {
      name: 'execute_action',
      description: 'Execute a page action by name (e.g., "New", "Delete", "Post", "Release").',
      inputSchema: z.toJSONSchema(ExecuteActionSchema) as Record<string, unknown>,
      zodSchema: ExecuteActionSchema,
      execute: (input) => ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]),
    },
    {
      name: 'close_page',
      description: 'Close an open page and free its resources.',
      inputSchema: z.toJSONSchema(ClosePageSchema) as Record<string, unknown>,
      zodSchema: ClosePageSchema,
      execute: (input) => ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]),
    },
    {
      name: 'search_pages',
      description: 'Search for Business Central pages using Tell Me. Returns matching page names.',
      inputSchema: z.toJSONSchema(SearchPagesSchema) as Record<string, unknown>,
      zodSchema: SearchPagesSchema,
      execute: (input) => ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]),
    },
    {
      name: 'navigate',
      description: 'Navigate to a record by bookmark. Use action "drill_down" to open the record, or "select" to position cursor.',
      inputSchema: z.toJSONSchema(NavigateSchema) as Record<string, unknown>,
      zodSchema: NavigateSchema,
      execute: (input) => ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]),
    },
  ];
}
