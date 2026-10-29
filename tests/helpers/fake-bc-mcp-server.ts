// tests/helpers/fake-bc-mcp-server.ts
//
// A REAL MCP server (the SDK's Server + StreamableHTTPServerTransport on
// node:http) standing in for BC 29's native MCP endpoint. Stateful sessions
// like BC (`Stateless = false`). Tool answers are scripted per test; the
// answer texts in tests come from live BC 29.1 captures.

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolScript = (args: Record<string, unknown>) => CallToolResult;

export interface FakeBCMcpServerOptions {
  /** Tools BC lists. Defaults to the data query tools + list_companies. */
  tools?: string[];
  /** Answer every initialize with this HTTP status instead (e.g. 412 feature gate). */
  initializeStatus?: number;
}

const DATA_QUERY_TOOLS =['bc_data_find_tables', 'bc_data_get_table_schema', 'bc_data_get_table_relations', 'bc_data_query'];

export class FakeBCMcpServer {
  readonly calls: Array<{ name: string; args: Record<string, unknown>; authorization: string | undefined; sessionId: string | undefined }> = [];
  readonly scripts = new Map<string, ToolScript>();
  initializeCount = 0;
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly http: HttpServer;
  private readonly tools: string[];

  private constructor(private readonly options: FakeBCMcpServerOptions) {
    this.tools = options.tools ?? [...DATA_QUERY_TOOLS, 'list_companies'];
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      });
    });
  }

  static async start(options: FakeBCMcpServerOptions = {}): Promise<FakeBCMcpServer> {
    const server = new FakeBCMcpServer(options);
    await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
    return server;
  }

  /** e.g. http://127.0.0.1:PORT/BC/mcp */
  get url(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/BC/mcp`;
  }

  /** Forget every session, like an NST restart or the 2h idle timeout. */
  expireSessions(): void {
    this.sessions.clear();
  }

  async stop(): Promise<void> {
    for (const t of this.sessions.values()) await t.close();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    if (!req.url?.startsWith('/BC/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const transport = this.sessions.get(sessionId);
      if (!transport) {
        // BC's answer for an unknown session (live BC 29.1).
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          .end('{"error":{"code":-32001,"message":"Session not found"},"id":"","jsonrpc":"2.0"}');
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }
    // No session id: an initialize.
    this.initializeCount++;
    if (this.options.initializeStatus) {
      res.writeHead(this.options.initializeStatus, { 'Content-Type': 'application/json' })
        .end('{"error":{"code":-32000,"message":"The MCP server feature is not enabled."}}');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { this.sessions.set(id, transport); },
    });
    const server = new Server({ name: 'Microsoft Dynamics 365 Business Central', version: '29.0.57071.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.map((name) => ({ name, inputSchema: { type: 'object' as const, properties: {} } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const headers = extra.requestInfo?.headers ?? {};
      this.calls.push({ name, args, authorization: headers['authorization'] as string | undefined, sessionId: extra.sessionId });
      const script = this.scripts.get(name);
      if (!script) return { isError: true, content: [{ type: 'text', text: `The tool ${name} was not found on this MCP server.` }] };
      return script(args);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}

export function text(...blocks: string[]): CallToolResult {
  return { content: blocks.map((t) => ({ type: 'text' as const, text: t })) };
}
