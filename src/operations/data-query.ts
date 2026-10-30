// src/operations/data-query.ts
//
// The bc_data_* tools: thin, typed front ends for BC's native MCP data query
// tools (BC 29+, decompiled `AlQueryToolCatalog`). BC answers each with text
// content; this turns the JSON ones into structured output and BC's isError
// answers into DataQueryError. Session-independent (uses BCMcpClient, not /csh).

import { ok, err, type Result } from '../core/result.js';
import { BCError, DataQueryError, ProtocolError } from '../core/errors.js';
import { parseJsonBlock, textOf, type BCMcpToolRunner } from '../bcmcp/bc-mcp-tools.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
  constructor(private readonly runner: BCMcpToolRunner) {}

  async findTables(input: FindTablesInput): Promise<Result<FindTablesOutput, BCError>> {
    return this.run(input.company, 'bc_data_find_tables', { searchText: input.searchText, searchMode: input.searchMode, top: input.top }, (r, company) => {
      const body = parseJsonBlock(r) as { tables?: FindTablesOutput['tables'] };
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
      ({ company, ...(parseJsonBlock(r) as Omit<TableRelationsOutput, 'company'>) }));
  }

  async query(input: DataQueryInput): Promise<Result<DataQueryOutput, BCError>> {
    const args = { queryText: input.queryText, returnData: input.returnData, top: input.top, skip: input.skip };
    return this.run(input.company, 'bc_data_query', args, (r, company) => {
      const body = parseJsonBlock(r) as Record<string, unknown>;
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
      const { result, company: resolved } = await this.runner.call(company, tool, args);
      if (result.isError) return err(new DataQueryError(textOf(result) || `${tool} failed`, { tool }));
      return ok(shape(result, resolved));
    } catch (e) {
      if (e instanceof BCError) return err(e);
      return err(new ProtocolError(`${tool} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
