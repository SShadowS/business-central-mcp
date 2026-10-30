// src/operations/api-actions.ts
//
// The bc_api_* tools: typed front ends for the API tools of BC's native MCP
// server (BC 29+, decompiled `DynamicToolDecoratorCatalog` over `ODataToolCatalog`).
// BC exposes every installed API page/query the user can read as a List action
// (`DiscoverReadOnlyObjects`), and Create/Modify/Delete/bound actions only for
// API objects an admin adds to the MCP configuration with those permissions.
// Action names are `<Verb>_<EntitySet>_<PAG|QRY><id>`, e.g. List_Customers_PAG30009,
// Create_Customer_PAG30009.

import { ok, err, type Result } from '../core/result.js';
import { ApiActionError, BCError, InputValidationError, ProtocolError } from '../core/errors.js';
import { extractEmbeddedJson, parseJsonBlock, textOf, type BCMcpToolRunner } from '../bcmcp/bc-mcp-tools.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const API_ACTION_TYPES = ['List', 'Create', 'Modify', 'Delete', 'BoundAction', 'UnboundAction'] as const;
export type ApiActionType = typeof API_ACTION_TYPES[number];

export interface ApiSearchInput { searchText: string; actionTypes?: ApiActionType[]; top?: number; company?: string }
export interface ApiSearchOutput { company: string; actions: string[] }

export interface ApiDescribeInput { actionName: string; company?: string }
export interface ApiDescribeOutput { company: string; name: string; description: string; schema: Record<string, unknown> }

export interface ApiListInput { actionName: string; filter?: string; select?: string; orderby?: string; top?: number; skip?: number; company?: string }
export interface ApiListOutput { company: string; actionName: string; rows: unknown[]; rowCount: number; totalCount?: number; hasMore: boolean }

export interface ApiInvokeInput { actionName: string; parameters: Record<string, unknown>; company?: string }
export interface ApiInvokeOutput { company: string; actionName: string; result?: unknown; replaySafe: boolean }

/** BC's default page size for a List action ("default/recommended: 10"). */
const LIST_DEFAULT_TOP = 10;

export class ApiActionsOperation {
  constructor(private readonly runner: BCMcpToolRunner) {}

  async search(input: ApiSearchInput): Promise<Result<ApiSearchOutput, BCError>> {
    const args = {
      SearchText: input.searchText,
      // Keyword only: semantic search needs BC's Copilot metadata search, which
      // on-prem answers "Semantic search is not enabled".
      SearchMode: 'keyword',
      ActionType: input.actionTypes ?? [...API_ACTION_TYPES],
      Top: input.top,
    };
    return this.run(input.company, 'bc_actions_search', args, (r, company) => {
      const text = textOf(r);
      // "No matching Business Central actions found. ..." is a normal (non-error) answer.
      if (!/^\s*[[{]/m.test(text)) return { company, actions: [] };
      return { company, actions: extractEmbeddedJson(text) as string[] };
    });
  }

  async describe(input: ApiDescribeInput): Promise<Result<ApiDescribeOutput, BCError>> {
    return this.run(input.company, 'bc_actions_describe', { ActionName: input.actionName }, (r, company) => {
      // "Here is the action schema you requested:\n{name, description, schema}\n\nNote: ..."
      const body = extractEmbeddedJson(textOf(r)) as { name: string; description: string; schema: Record<string, unknown> };
      return { company, name: body.name, description: body.description, schema: body.schema };
    });
  }

  async list(input: ApiListInput): Promise<Result<ApiListOutput, BCError>> {
    if (!input.actionName.startsWith('List_')) {
      return err(new InputValidationError([{ path: 'actionName', message: 'bc_api_list runs List_* actions only; use bc_api_invoke for Create/Modify/Delete and bound actions.' }]));
    }
    const params = { filter: input.filter, select: input.select, orderby: input.orderby, top: input.top, skip: input.skip };
    return this.invokeRaw(input.company, input.actionName, params, (r, company) => {
      // "Returned 2 of 5 total records. ..." then { "@odata.count": 5, "value": [...] }
      const body = parseJsonBlock(r) as { value?: unknown[]; '@odata.count'?: number };
      const rows = body.value ?? [];
      const totalCount = body['@odata.count'];
      const top = input.top ?? LIST_DEFAULT_TOP;
      const hasMore = totalCount !== undefined ? (input.skip ?? 0) + rows.length < totalCount : rows.length === top;
      return { company, actionName: input.actionName, rows, rowCount: rows.length, totalCount, hasMore };
    });
  }

  async invoke(input: ApiInvokeInput): Promise<Result<ApiInvokeOutput, BCError>> {
    if (input.actionName.startsWith('List_')) {
      return err(new InputValidationError([{ path: 'actionName', message: 'Read List_* actions with bc_api_list (read-only); bc_api_invoke is for actions that change data.' }]));
    }
    return this.invokeRaw(input.company, input.actionName, input.parameters, (r, company) => {
      // Create/Modify answer the record (with its new @odata.etag); Delete answers nothing.
      const text = textOf(r).trim();
      return { company, actionName: input.actionName, result: text ? parseJsonBlock(r) : undefined, replaySafe: isReplaySafe(input.actionName) };
    });
  }

  /** bc_actions_invoke takes the action's parameters as a JSON string. */
  private invokeRaw<T>(company: string | undefined, actionName: string, params: Record<string, unknown>, shape: (r: CallToolResult, company: string) => T) {
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    return this.run(company, 'bc_actions_invoke', { ActionName: actionName, RequestParameters: JSON.stringify(defined) }, shape);
  }

  private async run<T>(
    company: string | undefined,
    tool: string,
    args: Record<string, unknown>,
    shape: (result: CallToolResult, company: string) => T,
  ): Promise<Result<T, BCError>> {
    try {
      const { result, company: resolved } = await this.runner.call(company, tool, args);
      if (result.isError) return err(apiError(textOf(result), tool));
      return ok(shape(result, resolved));
    } catch (e) {
      if (e instanceof BCError) return err(e);
      return err(new ProtocolError(`${tool} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

/**
 * Whether re-running the same invoke can apply it twice. Verified live on BC 29.1:
 * a repeated Modify carries the now-stale If-Match etag and BC refuses it
 * (Request_EntityChanged); a repeated Delete finds no record
 * (BadRequest_ResourceNotFound). A repeated Create makes a second record, and a
 * bound/unbound action (e.g. Post) proves nothing.
 */
export function isReplaySafe(actionName: string): boolean {
  return actionName.startsWith('Modify_') || actionName.startsWith('Delete_');
}

/** BC's OData errors arrive as `{"error":{"code","message"}}` text. */
function apiError(text: string, tool: string): ApiActionError {
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (body.error?.message) {
      return new ApiActionError(`${body.error.code ? `${body.error.code}: ` : ''}${body.error.message}`, { tool, odataCode: body.error.code });
    }
  } catch { /* plain-text error */ }
  return new ApiActionError(text || `${tool} failed`, { tool });
}
