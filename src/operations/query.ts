// src/operations/query.ts
//
// bc_query operation: bulk/structured reads from BC via the Standard API v2.0
// (OData, port 7048). Completely independent of the WebSocket session.

import { ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import { ODataClient, type ODataClientConfig } from '../odata/odata-client.js';

export interface QueryInput {
  entity: string;
  filter?: string;
  select?: string;
  top?: number;
  orderby?: string;
  expand?: string;
  company?: string;
}

export interface QueryOutput {
  entity: string;
  rows: unknown[];
  rowCount: number;
  count?: number;
  cappedAt?: number; // present when top was auto-applied (not supplied by caller)
}

export class QueryOperation {
  private readonly client: ODataClient;
  private readonly defaultTop: number;

  constructor(config: ODataClientConfig) {
    this.defaultTop = config.defaultTop ?? 100;
    this.client = new ODataClient(config);
  }

  async execute(input: QueryInput): Promise<Result<QueryOutput, ProtocolError>> {
    const callerSuppliedTop = input.top !== undefined;

    try {
      const result = await this.client.query(input.entity, {
        filter: input.filter,
        select: input.select,
        top: input.top,
        orderby: input.orderby,
        expand: input.expand,
        company: input.company,
      });

      return ok({
        entity: input.entity,
        rows: result.rows,
        rowCount: result.rows.length,
        count: result.count,
        cappedAt: callerSuppliedTop ? undefined : this.defaultTop,
      });
    } catch (e) {
      if (e instanceof ProtocolError) {
        return err(e);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return err(new ProtocolError(`bc_query failed: ${msg}`));
    }
  }
}
