// src/bcmcp/bc-mcp-tools.ts
//
// Shared plumbing for operations that front BC's native MCP tools (bc_data_*,
// bc_api_*): per-call company resolution and helpers that read BC's text
// answers. BC answers with text content, often a sentence wrapped around JSON.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ProtocolError } from '../core/errors.js';
import { BCMcpClient } from './bc-mcp-client.js';
import type { AppConfig } from '../core/config.js';
import type { IBCAuthProvider } from '../connection/auth/auth-provider.js';
import type { Logger } from '../core/logger.js';

/** ponytail: one ceiling for every BC MCP request; BC caps rows (50) and query
 * run time itself. Make it configurable if a real call needs longer. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Build the session-independent BC MCP client and the runner the bc_data_* and
 * bc_api_* operations share (the caller closes the client on shutdown). Auth
 * follows bc_query: Bearer from the API auth provider, Basic on-prem, never
 * Basic on SaaS / OAuth. */
export function createBCMcpRuntime(
  config: AppConfig,
  authProvider: IBCAuthProvider,
  logger: Logger,
  sessionCompany: () => string | undefined,
): { client: BCMcpClient; runner: BCMcpToolRunner } {
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
  return { client, runner: new BCMcpToolRunner(client, sessionCompany, config.bc.odataCompanyName) };
}

export class BCMcpToolRunner {
  /** BC's default company for this user (`DefaultCompanyResolver`: personalization
   * company, else the first allowed). ponytail: cached for the process lifetime;
   * a changed personalization is picked up on restart. */
  private defaultCompany: Promise<string> | null = null;

  constructor(
    readonly client: BCMcpClient,
    /** Company of the live /csh session, so bc_switch_company carries over. */
    private readonly sessionCompany: () => string | undefined,
    /** BC_ODATA_COMPANY: the configured company for session-independent reads. */
    private readonly configuredCompany: string | undefined,
  ) {}

  /**
   * Call a BC MCP tool in a company: the explicit one, else the /csh session
   * company, else BC_ODATA_COMPANY, else BC's default for the user. BC's
   * session is unpinned, so every tool takes `company`
   * (`NavMcpPlatformSession.TryResolveCompany`).
   */
  async call(company: string | undefined, tool: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; company: string }> {
    const resolved = company ?? this.sessionCompany() ?? this.configuredCompany ?? await this.resolveDefaultCompany();
    const result = await this.client.callTool(tool, { ...dropUndefined(args), company: resolved });
    return { result, company: resolved };
  }

  private resolveDefaultCompany(): Promise<string> {
    if (!this.defaultCompany) {
      const attempt = this.client.callTool('list_companies', {}).then((r) => {
        const companies = parseJsonBlock(r) as Array<{ Name: string; isDefault?: boolean }>;
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

export function textOf(result: CallToolResult): string {
  return result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
}

/** The JSON payload block. A data page answers with a summary line first and
 * the JSON second (`ExecuteQueryAsync`), so take the last block that parses. */
export function parseJsonBlock(result: CallToolResult): unknown {
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

/**
 * JSON embedded in prose, e.g. "Here are ...:\n[...]" or
 * "Here is the action schema you requested:\n{...}\n\nNote: ...": parse from the
 * first line that opens JSON, dropping trailing paragraphs until it parses.
 */
export function extractEmbeddedJson(text: string): unknown {
  const start = text.search(/^[[{]/m);
  if (start < 0) throw new ProtocolError('BC MCP tool returned no JSON content', { content: text.slice(0, 500) });
  let candidate = text.slice(start).trimEnd();
  for (;;) {
    try {
      return JSON.parse(candidate);
    } catch {
      const cut = candidate.lastIndexOf('\n\n');
      if (cut < 0) throw new ProtocolError('BC MCP tool returned malformed JSON', { content: text.slice(0, 500) });
      candidate = candidate.slice(0, cut).trimEnd();
    }
  }
}
