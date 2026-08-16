// src/odata/odata-client.ts
//
// Thin OData v4 client for the BC Standard API v2.0.
// Completely independent of the WebSocket session.
// Auth: HTTP Basic (on-prem NavUserPassword) or Bearer (Entra / SaaS).
// Entry point: ODataClient.query(entity, opts).

import { ProtocolError } from '../core/errors.js';

export class ODataError extends ProtocolError {
  public readonly statusCode: number;
  public readonly bcErrorCode: string | undefined;
  constructor(message: string, statusCode: number, bcErrorCode?: string, context?: Record<string, unknown>) {
    super(message, context, 'ODATA_ERROR');
    this.statusCode = statusCode;
    this.bcErrorCode = bcErrorCode;
  }
}

export interface ODataQueryOptions {
  filter?: string;
  select?: string;
  top?: number;
  skip?: number;
  orderby?: string;
  expand?: string;
  count?: boolean;
  company?: string; // override company name for this query
}

export interface ODataQueryResult {
  rows: unknown[];
  count?: number;
  /** BC's @odata.nextLink — present when the server truncated the result
   * (e.g. top exceeds BC's max page size). Pagination is NOT auto-followed. */
  nextLink?: string;
  /** True when nextLink is present, i.e. more rows exist server-side. */
  hasMore: boolean;
}

export interface ODataClientConfig {
  odataUrl: string;   // e.g. http://cronus28:7048/BC or SaaS api.businesscentral.dynamics.com/v2.0/{tenant}/{env}
  tenantId: string;   // appended as ?tenant=<id> when appendTenantQuery is true
  username?: string;
  password?: string;
  /** Returns a full Authorization header value (e.g. "Bearer …"). Preferred over Basic. */
  getAuthorization?: () => Promise<string | undefined>;
  /** When false, skip ?tenant= (SaaS encodes tenant in the path). Default true. */
  appendTenantQuery?: boolean;
  defaultCompanyName?: string; // optional; if omitted, first company is used
  defaultTop?: number;         // cap applied when caller omits top (default: 100)
  requestTimeoutMs?: number;   // per-request timeout (default: 30 000 ms)
}

const DEFAULT_TOP = 100;

/**
 * OData client for the BC Standard API v2.0.
 *
 * Usage:
 *   const client = new ODataClient(config);
 *   const result = await client.query('customers', { top: 10 });
 *
 * Company resolution: on first query, GETs /api/v2.0/companies and picks
 * the configured company by name (or the first/only one). The resolved id
 * is cached for the lifetime of this client instance.
 */
export class ODataClient {
  private readonly baseApiUrl: string; // e.g. http://cronus28:7048/BC/api/v2.0
  private readonly tenantId: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly getAuthorization: (() => Promise<string | undefined>) | undefined;
  private readonly appendTenantQuery: boolean;
  private readonly defaultCompanyName: string | undefined;
  private readonly defaultTop: number;
  private cachedCompanyId: string | null = null;
  private companyResolutionPromise: Promise<string> | null = null;
  private readonly requestTimeoutMs: number;

  constructor(config: ODataClientConfig) {
    this.baseApiUrl = `${config.odataUrl.replace(/\/+$/, '')}/api/v2.0`;
    this.tenantId = config.tenantId;
    this.username = config.username;
    this.password = config.password;
    this.getAuthorization = config.getAuthorization;
    this.appendTenantQuery = config.appendTenantQuery !== false;
    this.defaultCompanyName = config.defaultCompanyName;
    this.defaultTop = config.defaultTop ?? DEFAULT_TOP;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  }

  private async resolveAuthorization(): Promise<string> {
    if (this.getAuthorization) {
      const header = await this.getAuthorization();
      if (header) return header;
    }
    // Empty username (OAuth mode) must not silently become Basic ":".
    if (this.username) {
      return `Basic ${Buffer.from(`${this.username}:${this.password ?? ''}`).toString('base64')}`;
    }
    throw new ODataError(
      'No OData credentials configured. Set BC_USERNAME/BC_PASSWORD (on-prem) or complete device-code sign-in (SaaS).',
      401,
    );
  }

  /**
   * Resolves the BC company id. Caches after first resolution.
   * Thread-safe: concurrent callers share one in-flight fetch.
   */
  async resolveCompanyId(): Promise<string> {
    if (this.cachedCompanyId !== null) return this.cachedCompanyId;
    if (this.companyResolutionPromise === null) {
      // Cache only the SUCCESS. On rejection, clear the in-flight promise so a
      // transient failure (network blip, 401, server-down) doesn't permanently
      // poison the client — the next call re-fetches.
      this.companyResolutionPromise = this._fetchCompanyId().then(
        id => {
          this.cachedCompanyId = id;
          return id;
        },
        err => {
          this.companyResolutionPromise = null;
          throw err;
        },
      );
    }
    return this.companyResolutionPromise;
  }

  private async _fetchCompanyId(): Promise<string> {
    const url = this._addTenant(`${this.baseApiUrl}/companies`);
    const data = await this._fetch<{ value: Array<{ id: string; name: string }> }>(url);

    const companies = data.value;
    if (!companies || companies.length === 0) {
      throw new ODataError('No companies found in BC environment', 404);
    }

    if (this.defaultCompanyName) {
      const match = companies.find(
        c => c.name.toLowerCase() === this.defaultCompanyName!.toLowerCase(),
      );
      if (!match) {
        const names = companies.map(c => c.name).join(', ');
        throw new ODataError(
          `Company "${this.defaultCompanyName}" not found. Available companies: ${names}`,
          404,
        );
      }
      return match.id;
    }

    // No company configured — use the first (and typically only) one
    const first = companies[0];
    if (!first) {
      throw new ODataError('No companies found in BC environment', 404);
    }
    return first.id;
  }

  /**
   * Query a Standard API v2.0 entity under the resolved company.
   *
   * GET /api/v2.0/companies(<id>)/<entity>?$filter=...&$select=...&$top=...
   *
   * top is capped to defaultTop (100) if not provided to prevent accidental
   * full-table scans. Pass top explicitly to override.
   */
  async query(entity: string, opts: ODataQueryOptions = {}): Promise<ODataQueryResult> {
    // Defense-in-depth: the MCP tool schema validates entity upstream, but a
    // caller bypassing it must not be able to inject '?'/'#'/'&'/'/' into the
    // URL path.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(entity)) {
      throw new ODataError(`Invalid entity name: ${entity}`, 400);
    }

    // The top-level `companies` entity is NOT company-scoped —
    // /companies(<id>)/companies is an invalid OData path. Query it directly
    // and skip company resolution (which would just re-query companies).
    const isCompaniesEntity = entity.toLowerCase() === 'companies';
    const companyId = isCompaniesEntity
      ? null
      : opts.company
        ? await this._resolveCompanyByName(opts.company)
        : await this.resolveCompanyId();

    // Build query string manually — URLSearchParams encodes '$' as '%24' which
    // breaks OData param names, and encodes spaces as '+' instead of '%20'.
    // We percent-encode values ourselves so OData operators ($filter etc.) are
    // preserved literally while user-supplied values are safely encoded.
    const parts: string[] = [];
    if (this.appendTenantQuery) {
      parts.push(`tenant=${encodeURIComponent(this.tenantId)}`);
    }

    const effectiveTop = opts.top ?? this.defaultTop;
    parts.push(`$top=${String(effectiveTop)}`);

    if (opts.filter) parts.push(`$filter=${encodeURIComponent(opts.filter)}`);
    // $select / $expand are comma-separated lists — encode each field name
    // individually and keep the commas literal, since BC's OData tokenizer
    // treats the list separator as a raw ',' (a %2C-encoded comma may not be
    // recognised as a separator).
    if (opts.select) parts.push(`$select=${encodeFieldList(opts.select)}`);
    if (opts.skip !== undefined) parts.push(`$skip=${String(opts.skip)}`);
    if (opts.orderby) parts.push(`$orderby=${encodeURIComponent(opts.orderby)}`);
    if (opts.expand) parts.push(`$expand=${encodeFieldList(opts.expand)}`);
    if (opts.count) parts.push(`$count=true`);

    const url = isCompaniesEntity
      ? `${this.baseApiUrl}/companies?${parts.join('&')}`
      : `${this.baseApiUrl}/companies(${companyId})/${entity}?${parts.join('&')}`;

    const data = await this._fetch<{ value: unknown[]; '@odata.count'?: number; '@odata.nextLink'?: string }>(url);

    const nextLink = data['@odata.nextLink'];
    return {
      rows: data.value ?? [],
      count: data['@odata.count'],
      nextLink,
      hasMore: nextLink !== undefined,
    };
  }

  private async _resolveCompanyByName(name: string): Promise<string> {
    // Temporarily bypass cache if a per-query override company is specified
    const url = this._addTenant(`${this.baseApiUrl}/companies`);
    const data = await this._fetch<{ value: Array<{ id: string; name: string }> }>(url);
    const match = (data.value ?? []).find(
      c => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (!match) {
      const names = (data.value ?? []).map(c => c.name).join(', ');
      throw new ODataError(
        `Company "${name}" not found. Available: ${names}`,
        404,
      );
    }
    return match.id;
  }

  private _addTenant(url: string): string {
    if (!this.appendTenantQuery) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}tenant=${encodeURIComponent(this.tenantId)}`;
  }

  private async _fetch<T>(url: string): Promise<T> {
    // Resolved outside the network try so auth failures (notably
    // DeviceLoginRequiredError on mid-flight token expiry) keep their code
    // and context instead of being relabeled as network errors.
    const authorization = await this.resolveAuthorization();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new ODataError(
        `Network error reaching BC OData endpoint: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    }

    if (response.ok) {
      return response.json() as Promise<T>;
    }

    // Non-2xx — parse BC error body if possible
    let bcCode: string | undefined;
    let bcMessage: string | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      bcCode = body.error?.code;
      bcMessage = body.error?.message;
    } catch {
      // response body is not JSON — ignore
    }

    if (response.status === 401) {
      const oauthHint = this.getAuthorization
        ? 'The OAuth access token was rejected. Re-run device-code sign-in (delete STATE_DIR/oauth-tokens.json) and complete https://microsoft.com/devicelogin.'
        : 'Check BC_USERNAME and BC_PASSWORD. Cloud/SaaS BC uses device-code — pass a businesscentral.dynamics.com URL and complete the sign-in code the tool returns.';
      throw new ODataError(
        `BC OData authentication failed (401). ${oauthHint}`,
        401,
        bcCode,
      );
    }

    const pathOnly = url.replace(/\?.*$/, '');
    const detail = bcMessage ? ` BC says: ${bcMessage}` : '';
    throw new ODataError(
      `BC OData returned ${response.status} for ${pathOnly}.${detail}`,
      response.status,
      bcCode,
      // Keep only the path in context — the query string carries tenant=... and
      // user filter values which must not leak into logs.
      { url: pathOnly, bcErrorCode: bcCode, bcMessage },
    );
  }
}

/**
 * Encodes a comma-separated OData field list ($select / $expand) by encoding
 * each field name individually and rejoining with literal commas. This keeps
 * the list separator as a raw ',' for BC's OData tokenizer while still safely
 * encoding any special characters within a field name.
 */
function encodeFieldList(list: string): string {
  return list
    .split(',')
    .map(f => encodeURIComponent(f.trim()))
    .join(',');
}

/**
 * Derives the OData base URL from the WS base URL by injecting port 7048.
 *
 * Examples:
 *   http://cronus28/BC         -> http://cronus28:7048/BC
 *   http://cronus28:80/BC      -> http://cronus28:7048/BC
 *   http://host:7048/BC        -> http://host:7048/BC  (already correct, no-op)
 *
 * If BC_ODATA_URL env var is set it takes precedence over any derivation.
 */
export function deriveODataUrl(bcBaseUrl: string): string {
  const explicit = process.env.BC_ODATA_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  // Imported lazily via a relative import at the top would create a cycle
  // (config -> odata-client -> saas-url; config already imports saas-url).
  // Inline the SaaS host check so this function stays a pure URL rewrite.
  try {
    const parsed = new URL(bcBaseUrl);
    if (/^(?:[a-z0-9-]+\.)?businesscentral\.dynamics\.com$/i.test(parsed.hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `https://api.businesscentral.dynamics.com/v2.0/${parts[0]}/${parts[1]}`;
      }
    }
    // Only inject 7048 if the port is NOT already 7048
    if (parsed.port !== '7048') {
      parsed.port = '7048';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    // bcBaseUrl is not a valid URL — best-effort string manipulation
    const withPort = bcBaseUrl.replace(/(https?:\/\/[^/:]+)(:\d+)?/, '$1:7048');
    return withPort.replace(/\/+$/, '');
  }
}
