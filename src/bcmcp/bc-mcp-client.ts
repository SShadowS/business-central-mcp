// src/bcmcp/bc-mcp-client.ts
//
// MCP client for Business Central's NATIVE MCP server (BC 29+). The OData host
// serves it at `{odataUrl}/mcp` (decompiled `McpHostFactory`: same port, SSL and
// auth as OData). Transport is stateful Streamable HTTP (`HttpServerTransportOptions.
// Stateless = false`, 2h idle timeout); POST answers are SSE and BC refuses a
// client that accepts only JSON (406). Independent of the /csh WebSocket session.
//
// One unpinned BC MCP session (no `Company` header) serves every company: BC then
// declares a `company` argument on each tool and adds `list_companies`
// (`NavMcpPlatformSession.TryResolveCompany`, `ListCompaniesToolCatalog`), so the
// caller picks the company per call and bc_switch_company needs no reconnect.
//
// Verified live on BC 29.1 (Cronus291, run inside the container).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AuthenticationError, BCError, ConnectionError, DataQueryUnavailableError, OAuthNotConfiguredError, TimeoutError,
} from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { SERVER_VERSION } from '../core/version.js';

export interface BCMcpClientConfig {
  /** e.g. http://cronus291:7048/BC/mcp */
  mcpUrl: string;
  tenantId: string;
  /** Append ?tenant=<id> (on-prem). SaaS encodes the tenant in the path. */
  appendTenantQuery: boolean;
  username?: string;
  password?: string;
  /** Full Authorization header value (e.g. "Bearer …"); preferred over Basic. */
  getAuthorization?: () => Promise<string | undefined>;
  /** Never fall back to Basic (SaaS / OAuth): a missing token is an error. */
  requireBearer: boolean;
  /** Per-request timeout for one MCP request. */
  requestTimeoutMs: number;
  logger: Logger;
}

/** BC answers DELETE of a session slowly or not at all over some network paths;
 * shutdown must not hang on it. The session idles out server-side (2h) anyway. */
const TERMINATE_TIMEOUT_MS = 5000;

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  toolNames: ReadonlySet<string>;
}

export class BCMcpClient {
  private connection: Promise<Connection> | null = null;
  /** Authorization header for the next request, resolved before each call so a
   * token error (e.g. DEVICE_LOGIN_REQUIRED) surfaces with its type intact
   * instead of being wrapped by the transport. */
  private authorization: string | undefined;

  constructor(private readonly config: BCMcpClientConfig) {}

  /**
   * Call one of BC's MCP tools. Reconnects once when BC reports the session
   * gone (HTTP 404 "Session not found": idle timeout or NST restart). Retrying
   * is safe for the read-only tools this client is used for.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.authorization = await this.resolveAuthorization();
    try {
      return await this.callOnce(name, args);
    } catch (e) {
      if (!(e instanceof StreamableHTTPError && e.code === 404)) throw this.mapError(e);
      this.config.logger.info('BC MCP session expired; reconnecting');
      await this.reset();
      try {
        return await this.callOnce(name, args);
      } catch (retryError) {
        throw this.mapError(retryError);
      }
    }
  }

  /** Close the BC MCP session (best effort, bounded). */
  async close(): Promise<void> {
    const pending = this.connection;
    this.connection = null;
    if (!pending) return;
    let connection: Connection;
    try {
      connection = await pending;
    } catch {
      return;
    }
    try {
      await connection.transport.terminateSession();
    } catch (e) {
      this.config.logger.debug('bcmcp', `BC MCP session terminate failed:${e instanceof Error ? e.message : String(e)}`);
    }
    await connection.client.close();
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const { client, toolNames } = await this.connect();
    if (!toolNames.has(name)) {
      throw new DataQueryUnavailableError(
        `BC's MCP server does not offer ${name}. Turn on "Data Query Tools (Preview)" in the MCP Server Configuration `
        + '(Server Features). BC reads the setting when a session starts.',
        'tools-disabled',
        { tool: name, offered: [...toolNames] },
      );
    }
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.config.requestTimeoutMs });
    return result as CallToolResult;
  }

  private connect(): Promise<Connection> {
    if (!this.connection) {
      const attempt = this.open();
      this.connection = attempt;
      // A failed connect must not stick: the next call tries again.
      attempt.catch(() => { if (this.connection === attempt) this.connection = null; });
    }
    return this.connection;
  }

  private async open(): Promise<Connection> {
    const url = new URL(this.config.mcpUrl);
    if (this.config.appendTenantQuery) url.searchParams.set('tenant', this.config.tenantId);
    const transport = new StreamableHTTPClientTransport(url, { fetch: (input, init) => this.fetchWithAuth(input, init) });
    const client = new Client({ name: 'business-central-mcp', version: SERVER_VERSION });
    try {
      await client.connect(transport, { timeout: this.config.requestTimeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: this.config.requestTimeoutMs });
      this.config.logger.info(`BC MCP session ${transport.sessionId} (protocol ${transport.protocolVersion}): ${tools.length} tools`);
      return { client, transport, toolNames: new Set(tools.map((t) => t.name)) };
    } catch (e) {
      await client.close().catch(() => {});
      throw this.mapConnectError(e);
    }
  }

  private async reset(): Promise<void> {
    const pending = this.connection;
    this.connection = null;
    if (pending) await pending.then((c) => c.client.close(), () => {});
  }

  private fetchWithAuth(input: string | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.authorization) headers.set('Authorization', this.authorization);
    const signal = init?.method === 'DELETE' ? AbortSignal.timeout(TERMINATE_TIMEOUT_MS) : init?.signal;
    return fetch(input, { ...init, headers, signal });
  }

  private async resolveAuthorization(): Promise<string | undefined> {
    const header = this.config.getAuthorization ? await this.config.getAuthorization() : undefined;
    if (header) return header;
    if (this.config.requireBearer) {
      throw new OAuthNotConfiguredError(
        'The BC data query tools on BC Online need BC_CLIENT_ID: a multi-tenant public Entra app with '
        + 'delegated Dynamics 365 Business Central user_impersonation. '
        + 'If BC_CLIENT_ID is set, token acquisition failed — check the server logs.',
      );
    }
    if (this.config.username === undefined) return undefined;
    return `Basic ${Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64')}`;
  }

  /** Connect-time HTTP statuses name a missing or switched-off server. */
  private mapConnectError(e: unknown): BCError {
    if (e instanceof StreamableHTTPError) {
      if (e.code === 404) {
        return new DataQueryUnavailableError(
          `BC has no MCP endpoint at ${this.config.mcpUrl}. It needs BC 29+ with McpServicesEnabled and ODataServicesEnabled `
          + 'on the server instance (set BC_MCP_URL if the endpoint lives elsewhere).',
          'endpoint-missing',
          { status: 404 },
        );
      }
      // McpFeatureGate: the "MCP Server" Copilot capability is not active.
      if (e.code === 412) {
        return new DataQueryUnavailableError(
          `BC's MCP server is turned off: ${e.message}. Enable it on the Copilot & agent capabilities page.`,
          'mcp-disabled',
          { status: 412 },
        );
      }
    }
    return this.mapError(e);
  }

  private mapError(e: unknown): BCError {
    if (e instanceof BCError) return e;
    if (e instanceof StreamableHTTPError) {
      if (e.code === 401 || e.code === 403) return new AuthenticationError(`BC MCP server rejected the credentials: ${e.message}`, { status: e.code });
      return new ConnectionError(`BC MCP request failed: ${e.message}`, { status: e.code });
    }
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
      return new TimeoutError(`BC MCP request timed out after ${this.config.requestTimeoutMs}ms`);
    }
    const message = e instanceof Error ? e.message : String(e);
    return new ConnectionError(`BC MCP request failed: ${message}`);
  }
}
