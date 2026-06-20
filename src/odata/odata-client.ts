// src/odata/odata-client.ts
//
// Thin OData v4 client for the BC Standard API v2.0 (port 7048).
// Completely independent of the WebSocket session — uses HTTP Basic auth.
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
}

export interface ODataClientConfig {
  odataUrl: string;   // e.g. http://cronus28:7048/BC
  tenantId: string;   // appended as ?tenant=<id>
  username: string;
  password: string;
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
  private readonly authHeader: string;
  private readonly defaultCompanyName: string | undefined;
  private readonly defaultTop: number;
  private cachedCompanyId: string | null = null;
  private companyResolutionPromise: Promise<string> | null = null;
  private readonly requestTimeoutMs: number;

  constructor(config: ODataClientConfig) {
    this.baseApiUrl = `${config.odataUrl.replace(/\/+$/, '')}/api/v2.0`;
    this.tenantId = config.tenantId;
    this.authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    this.defaultCompanyName = config.defaultCompanyName;
    this.defaultTop = config.defaultTop ?? DEFAULT_TOP;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  }

  /**
   * Resolves the BC company id. Caches after first resolution.
   * Thread-safe: concurrent callers share one in-flight fetch.
   */
  async resolveCompanyId(): Promise<string> {
    if (this.cachedCompanyId !== null) return this.cachedCompanyId;
    if (this.companyResolutionPromise === null) {
      this.companyResolutionPromise = this._fetchCompanyId().then(id => {
        this.cachedCompanyId = id;
        return id;
      });
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
    const companyId = opts.company
      ? await this._resolveCompanyByName(opts.company)
      : await this.resolveCompanyId();

    // Build query string manually — URLSearchParams encodes '$' as '%24' which
    // breaks OData param names, and encodes spaces as '+' instead of '%20'.
    // We percent-encode values ourselves so OData operators ($filter etc.) are
    // preserved literally while user-supplied values are safely encoded.
    const parts: string[] = [`tenant=${encodeURIComponent(this.tenantId)}`];

    const effectiveTop = opts.top ?? this.defaultTop;
    parts.push(`$top=${String(effectiveTop)}`);

    if (opts.filter) parts.push(`$filter=${encodeURIComponent(opts.filter)}`);
    if (opts.select) parts.push(`$select=${encodeURIComponent(opts.select)}`);
    if (opts.skip !== undefined) parts.push(`$skip=${String(opts.skip)}`);
    if (opts.orderby) parts.push(`$orderby=${encodeURIComponent(opts.orderby)}`);
    if (opts.expand) parts.push(`$expand=${encodeURIComponent(opts.expand)}`);
    if (opts.count) parts.push(`$count=true`);

    const url = `${this.baseApiUrl}/companies(${companyId})/${entity}?${parts.join('&')}`;

    const data = await this._fetch<{ value: unknown[]; '@odata.count'?: number }>(url);

    return {
      rows: data.value ?? [],
      count: data['@odata.count'],
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
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}tenant=${encodeURIComponent(this.tenantId)}`;
  }

  private async _fetch<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: this.authHeader,
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
      throw new ODataError(
        'BC OData authentication failed (401). Check BC_USERNAME and BC_PASSWORD. ' +
        'Note: cloud/SaaS BC requires OAuth — Basic auth only works in on-premise NavUserPassword environments.',
        401,
        bcCode,
      );
    }

    const detail = bcMessage ? ` BC says: ${bcMessage}` : '';
    throw new ODataError(
      `BC OData returned ${response.status} for ${url.replace(/\?.*$/, '')}.${detail}`,
      response.status,
      bcCode,
      { url, bcErrorCode: bcCode, bcMessage },
    );
  }
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

  try {
    const parsed = new URL(bcBaseUrl);
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
