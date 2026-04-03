import type { ToolDefinition } from './tool-registry.js';
import type { Logger } from '../core/logger.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class MCPHandler {
  private initialized = false;

  get isInitialized(): boolean {
    return this.initialized;
  }

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly logger: Logger,
  ) {}

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);
        case 'notifications/initialized':
          return { jsonrpc: '2.0', id: request.id, result: {} };
        case 'tools/list':
          return this.handleToolsList(request);
        case 'tools/call':
          return await this.handleToolsCall(request);
        case 'resources/list':
          return { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        case 'resources/read':
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Resource not found' } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        case 'prompts/get':
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Prompt not found' } };
        default:
          return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
      }
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' },
      };
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    this.initialized = true;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'bc-mcp', version: '2.0.0' },
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
      },
    };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: this.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as { name?: string; arguments?: unknown } | undefined;
    if (!params?.name) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Missing tool name' } };
    }

    const tool = this.tools.find(t => t.name === params.name);
    if (!tool) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    }

    // Validate input via Zod
    const parseResult = tool.zodSchema.safeParse(params.arguments ?? {});
    if (!parseResult.success) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Input validation error: ${parseResult.error.message}` }],
          isError: true,
        },
      };
    }

    // Execute the tool
    try {
      const result = await tool.execute(parseResult.data);
      // Result is a Result<T, ProtocolError>
      const r = result as { ok: boolean; value?: unknown; error?: { message: string } };
      if (r.ok) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(r.value, null, 2) }],
          },
        };
      } else {
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `Error: ${r.error?.message ?? 'Unknown error'}` }],
            isError: true,
          },
        };
      }
    } catch (e) {
      this.logger.error(`Tool ${params.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        },
      };
    }
  }
}
