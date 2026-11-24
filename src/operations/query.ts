// src/operations/query.ts
//
// bc_query operation: bulk/structured reads from BC via the Standard API v2.0
// (OData, port 7048). Completely independent of the WebSocket session.

import { ok, err, type Result } from '../core/result.js';
import { BCError, OAuthNotConfiguredError, ProtocolError } from '../core/errors.js';
import { ODataClient, type ODataClientConfig } from '../odata/odata-client.js';
import type { AppConfig } from '../core/config.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';

export interface QueryInput {
  entity: string;
  filter?: string;
  select?: string;
  top?: number;
  /** Rows to skip ($skip), for paging. */
  skip?: number;
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
  /** True when more rows match than were returned: read the next page with skip += rowCount. */
  hasMore: boolean;
}

/** Build the session-independent OData operation used by bc_query. */
export function createQueryOperation(config: AppConfig, authProvider: IBCAuthProvider): QueryOperation {
  return new QueryOperation({
    odataUrl: config.bc.odataUrl,
    tenantId: config.bc.tenantId,
    username: config.bc.username,
    password: config.bc.password,
    defaultCompanyName: config.bc.odataCompanyName,
    appendTenantQuery: config.bc.appendTenantQuery,
    getAuthorization: async () => {
      if (typeof authProvider.getAccessToken !== 'function') return undefined;
      const token = await authProvider.getAccessToken();
      return token ? `Bearer ${token}` : undefined;
    },
  }, {
    // SaasWeb AND OAuth: bc_query must never silently downgrade to Basic.
    // In OAuth mode a failed token acquisition would otherwise fall back to
    // leftover BC_USERNAME/BC_PASSWORD (leaking on-prem credentials to the
    // cloud API, or masking a broken OAuth config against on-prem).
    requireBearer: config.bc.authMode === 'SaasWeb' || config.bc.authMode === 'OAuth',
  });
}

export class QueryOperation {
  private readonly client: ODataClient;
  private readonly defaultTop: number;
  private readonly requireBearer: boolean;
  private readonly getAuthorization: ODataClientConfig['getAuthorization'];

  constructor(config: ODataClientConfig, opts: { requireBearer?: boolean } = {}) {
    this.defaultTop = config.defaultTop ?? 100;
    this.requireBearer = opts.requireBearer ?? false;
    this.getAuthorization = config.getAuthorization;
    this.client = new ODataClient(config);
  }

  async execute(input: QueryInput): Promise<Result<QueryOutput, BCError>> {
    const callerSuppliedTop = input.top !== undefined;

    // getAuthorization may throw DeviceLoginRequiredError (both here and
    // inside client.query) — the whole body sits in one try so the error
    // reaches the tool result with its code and hint intact.
    try {
      if (this.requireBearer) {
        const header = this.getAuthorization ? await this.getAuthorization() : undefined;
        if (!header) {
          return err(new OAuthNotConfiguredError(
            'bc_query on BC Online needs BC_CLIENT_ID: a multi-tenant public Entra app with '
            + 'delegated Dynamics 365 Business Central user_impersonation. '
            + 'If BC_CLIENT_ID is set, token acquisition failed — check the server logs.',
          ));
        }
      }

      // Ask for one row more than top: BC sends @odata.nextLink only past its own page size,
      // so top=3 over 5 rows came back without it (recorded flow, cronus29).
      const top = input.top ?? this.defaultTop;
      const result = await this.client.query(input.entity, {
        filter: input.filter,
        select: input.select,
        top: top + 1,
        skip: input.skip,
        orderby: input.orderby,
        expand: input.expand,
        company: input.company,
      });
      const rows = result.rows.slice(0, top);

      return ok({
        entity: input.entity,
        rows,
        rowCount: rows.length,
        count: result.count,
        cappedAt: callerSuppliedTop ? undefined : this.defaultTop,
        hasMore: result.rows.length > top || result.hasMore,
      });
    } catch (e) {
      if (e instanceof BCError) {
        return err(e);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return err(new ProtocolError(`bc_query failed: ${msg}`));
    }
  }
}
