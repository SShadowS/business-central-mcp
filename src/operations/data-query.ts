// src/operations/data-query.ts
//
// The bc_data_* tools: thin, typed front ends for BC's native MCP data query
// tools (BC 29+, decompiled `AlQueryToolCatalog`). BC answers each with text
// content; this turns the JSON ones into structured output and BC's isError
// answers into DataQueryError. Session-independent (uses BCMcpClient, not /csh).

import { ok, err, type Result } from '../core/result.js';
import { BCError, DataQueryError, ProtocolError } from '../core/errors.js';
import { BCMcpClient } from '../bcmcp/bc-mcp-client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../core/config.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import type { Logger } from '../core/logger.js';

/** ponytail: one ceiling for every BC MCP request; BC caps query rows (50) and
 * run time itself. Make it configurable if a real query needs longer. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Build the session-independent bc_data_* operation and the BC MCP client it
 * uses (the caller closes the client on shutdown). Auth follows bc_query: Bearer
 * from the API auth provider, Basic on-prem, never Basic on SaaS / OAuth. */
export function createDataQueryOperation(
  config: AppConfig,
  authProvider: IBCAuthProvider,
  logger: Logger,
  sessionCompany: () => string | undefined,
): { operation: DataQueryOperation; client: BCMcpClient } {
  const client = new BCMcpClient({
    mcpUrl: config.bc.mcpUrl,
    tenantId: config.bc.tenantId,
    appendTenantQuery: config.bc.appendTenantQuery,
    username: config.bc.username,
    password: config.bc.password,
    getAuthorization: async () => {
      if (typeof authProvider.getAccessToken !== 'function') return undefined;
      const token = await authProvider.getAccessToken();
      return token ? `Bearer ${token}` : undefined;
    },
    requireBearer: config.bc.authMode === 'SaasWeb' || config.bc.authMode === 'OAuth',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logger,
  });
  return { operation: new DataQueryOperation(client, sessionCompany, config.bc.odataCompanyName), client };
}

export interface FindTablesInput { searchText: string; searchMode: 'keyword' | 'semantic'; top?: number; company?: string }
export interface FindTablesOutput { company: string; tables: Array<{ tableId: number; tableName: string; score?: number }> }

export interface TableSchemaInput { tableId: number; fieldClass?: 'Normal' | 'FlowField' | 'FlowFilter'; nameContains?: string[]; company?: string }
export interface TableSchemaOutput { company: string; tableId: number; schema: string }

export interface TableRelationsInput { tableId: number; direction: 'outgoing' | 'incoming'; relatedToTableIds?: number[]; company?: string }
export interface TableRelationsOutput {
  company: string;
  tableId: number;
  tableName: string;
  outgoing?: unknown[];
  incoming?: unknown[];
  incomingTruncated?: boolean;
  incomingTotalCount?: number;
  hint?: string;
}

export interface DataQueryInput { queryText: string; returnData?: boolean; top?: number; skip?: number; company?: string }
export type DataQueryOutput =
  | { company: string; status: 'compiled'; columns: Array<{ name: string; type: string; aggregation?: string; dateMethod?: boolean }>; dataItems: Array<{ alias: string; tableId: number; tableName?: string }> }
  | { company: string; status: 'executed'; columns: string[]; rows: unknown[][]; rowCount: number; skip: number; top: number; totalCount?: number; hasMore: boolean };

export class DataQueryOperation {
  /** BC's default company for this user (`DefaultCompanyResolver`: personalization
   * company, else the first allowed). ponytail: cached for the process lifetime;
   * a changed personalization is picked up on restart. */
  private defaultCompany: Promise<string> | null = null;

  constructor(
    private readonly client: BCMcpClient,
    /** Company of the live /csh session, so bc_switch_company carries over. */
    private readonly sessionCompany: () => string | undefined,
    /** BC_ODATA_COMPANY: the configured company for session-independent reads. */
    private readonly configuredCompany: string | undefined,
  ) {}

  async findTables(input: FindTablesInput): Promise<Result<FindTablesOutput, BCError>> {
    return this.run(input.company, 'bc_data_find_tables', { searchText: input.searchText, searchMode: input.searchMode, top: input.top }, (r, company) => {
      const body = parseJson(r) as { tables?: FindTablesOutput['tables'] };
      return { company, tables: body.tables ?? [] };
    });
  }

  async getTableSchema(input: TableSchemaInput): Promise<Result<TableSchemaOutput, BCError>> {
    return this.run(input.company, 'bc_data_get_table_schema', { tableId: input.tableId, fieldClass: input.fieldClass, nameContains: input.nameContains }, (r, company) =>
      // Compact pipe-delimited text by design (BC's own token-saving format).
      ({ company, tableId: input.tableId, schema: textOf(r) }));
  }

  async getTableRelations(input: TableRelationsInput): Promise<Result<TableRelationsOutput, BCError>> {
    return this.run(input.company, 'bc_data_get_table_relations', { tableId: input.tableId, direction: input.direction, relatedToTableIds: input.relatedToTableIds }, (r, company) =>
      ({ company, ...(parseJson(r) as Omit<TableRelationsOutput, 'company'>) }));
  }

  async query(input: DataQueryInput): Promise<Result<DataQueryOutput, BCError>> {
    const args = { queryText: input.queryText, returnData: input.returnData, top: input.top, skip: input.skip };
    return this.run(input.company, 'bc_data_query', args, (r, company) => {
      const body = parseJson(r) as Record<string, unknown>;
      if (body.status === 'compiled') {
        return { company, status: 'compiled', columns: body.columns, dataItems: body.dataItems } as DataQueryOutput;
      }
      // Data page: { skip, top, rowCount, columns, rows, totalCount? } — totalCount only when skip = 0.
      const skip = body.skip as number;
      const top = body.top as number;
      const rowCount = body.rowCount as number;
      const totalCount = body.totalCount as number | undefined;
      const hasMore = totalCount !== undefined ? skip + rowCount < totalCount : rowCount === top;
      return { company, status: 'executed', columns: body.columns as string[], rows: body.rows as unknown[][], rowCount, skip, top, totalCount, hasMore };
    });
  }

  private async run<T>(
    company: string | undefined,
    tool: string,
    args: Record<string, unknown>,
    shape: (result: CallToolResult, company: string) => T,
  ): Promise<Result<T, BCError>> {
    try {
      const resolved = company ?? this.sessionCompany() ?? this.configuredCompany ?? await this.resolveDefaultCompany();
      const result = await this.client.callTool(tool, { ...dropUndefined(args), company: resolved });
      if (result.isError) return err(new DataQueryError(textOf(result) || `${tool} failed`, { tool }));
      return ok(shape(result, resolved));
    } catch (e) {
      if (e instanceof BCError) return err(e);
      return err(new ProtocolError(`${tool} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private resolveDefaultCompany(): Promise<string> {
    if (!this.defaultCompany) {
      const attempt = this.client.callTool('list_companies', {}).then((r) => {
        const companies = parseJson(r) as Array<{ Name: string; isDefault?: boolean }>;
        const name = (companies.find((c) => c.isDefault) ?? companies[0])?.Name;
        if (!name) throw new ProtocolError('BC lists no company this user can access.');
        return name;
      });
      this.defaultCompany = attempt;
      attempt.catch(() => { if (this.defaultCompany === attempt) this.defaultCompany = null; });
    }
    return this.defaultCompany;
  }
}

function dropUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

function textOf(result: CallToolResult): string {
  return result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
}

/** The JSON payload block. A data page answers with a summary line first and
 * the JSON second (`ExecuteQueryAsync`), so take the last block that parses. */
function parseJson(result: CallToolResult): unknown {
  const texts = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      return JSON.parse(t);
    } catch { /* try the previous block */ }
  }
  throw new ProtocolError('BC MCP tool returned no JSON content', { content: texts.join('\n').slice(0, 500) });
}
