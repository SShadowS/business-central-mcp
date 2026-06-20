import { z } from 'zod';
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
import type { RunReportOperation } from '../operations/run-report.js';
import type { WizardNavigateOperation } from '../operations/wizard-navigate.js';
import type { LookupOperation } from '../operations/lookup.js';
import type { QueryOperation } from '../operations/query.js';
import { createToolDefinition as openPageTool } from '../operations/open-page.tool.js';
import { createToolDefinition as readDataTool } from '../operations/read-data.tool.js';
import { createToolDefinition as writeDataTool } from '../operations/write-data.tool.js';
import { createToolDefinition as executeActionTool } from '../operations/execute-action.tool.js';
import { createToolDefinition as closePageTool } from '../operations/close-page.tool.js';
import { createToolDefinition as searchPagesTool } from '../operations/search-pages.tool.js';
import { createToolDefinition as navigateTool } from '../operations/navigate.tool.js';
import { createToolDefinition as respondDialogTool } from '../operations/respond-dialog.tool.js';
import { createToolDefinition as switchCompanyTool } from '../operations/switch-company.tool.js';
import { createToolDefinition as listCompaniesTool } from '../operations/list-companies.tool.js';
import { createToolDefinition as runReportTool } from '../operations/run-report.tool.js';
import { createToolDefinition as wizardNavigateTool } from '../operations/wizard-navigate.tool.js';
import { createToolDefinition as lookupTool } from '../operations/lookup.tool.js';
import { createToolDefinition as queryTool } from '../operations/query.tool.js';

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
  runReport: RunReportOperation;
  wizardNavigate: WizardNavigateOperation;
  lookup: LookupOperation;
  query: QueryOperation;
}

export function buildToolRegistry(ops: Operations): ToolDefinition[] {
  return [
    openPageTool(ops),
    readDataTool(ops),
    writeDataTool(ops),
    executeActionTool(ops),
    closePageTool(ops),
    searchPagesTool(ops),
    navigateTool(ops),
    respondDialogTool(ops),
    switchCompanyTool(ops),
    listCompaniesTool(ops),
    runReportTool(ops),
    wizardNavigateTool(ops),
    lookupTool(ops),
    queryTool(ops),
  ];
}
