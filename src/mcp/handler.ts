import type { ToolDefinition } from './tool-registry.js';
import type { PromptDefinition } from './prompts.js';
import type { Logger } from '../core/logger.js';
import { SessionLostError, BCError, UrlElicitationRequiredError, errorHint } from '../core/errors.js';
import { applyElicitationCapabilities, type ClientElicitationPort } from './elicitation-port.js';
import { SERVER_VERSION } from '../core/version.js';
import { IdempotencyGate, invalidOperationId, isAmbiguousFailure, type Failure } from './idempotency-gate.js';

export const URL_ELICITATION_JSONRPC_CODE = -32042;

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

/**
 * Format a BCError (or any error-like object with an optional code) into a
 * human-readable string suitable for MCP tool call output. When `errorHint`
 * returns a hint for the code, appends it on a second line.
 *
 * Examples:
 *   { code: 'VALIDATION_ERROR', message: 'bad' }
 *     -> "Error [VALIDATION_ERROR]: bad\nHint: Correct the field value(s)..."
 *   { code: 'PROTOCOL_ERROR', message: 'x' }
 *     -> "Error [PROTOCOL_ERROR]: x"   (no hint — PROTOCOL_ERROR has none)
 *   { message: 'y' }
 *     -> "Error: y"
 */
export function formatBcError(e: { code?: string; message: string }): string {
  const header = e.code ? `Error [${e.code}]: ${e.message}` : `Error: ${e.message}`;
  const hint = e.code ? errorHint(e.code) : undefined;
  return hint ? `${header}\nHint: ${hint}` : header;
}

export class MCPHandler {
  private initialized = false;
  private readonly elicitationPort: ClientElicitationPort | undefined;
  private readonly gate: IdempotencyGate | undefined;

  get isInitialized(): boolean {
    return this.initialized;
  }

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly logger: Logger,
    private readonly prompts: PromptDefinition[] = [],
    opts?: { elicitationPort?: ClientElicitationPort; gate?: IdempotencyGate },
  ) {
    this.elicitationPort = opts?.elicitationPort;
    this.gate = opts?.gate;
  }

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
          return this.handlePromptsList(request);
        case 'prompts/get':
          return this.handlePromptsGet(request);
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
    if (this.elicitationPort) {
      const elic = (request.params as { capabilities?: { elicitation?: unknown } } | undefined)
        ?.capabilities?.elicitation;
      applyElicitationCapabilities(this.elicitationPort, elic);
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'bc-mcp', version: SERVER_VERSION },
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          ...(this.prompts.length > 0 ? { prompts: { listChanged: false } } : {}),
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
          inputSchema: this.gate && !t.annotations.readOnlyHint ? withOperationId(t.inputSchema) : t.inputSchema,
          annotations: t.annotations,
        })),
      },
    };
  }

  private handlePromptsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        prompts: this.prompts.map(p => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        })),
      },
    };
  }

  private handlePromptsGet(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as { name?: string; arguments?: Record<string, string> } | undefined;
    if (!params?.name) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Missing prompt name' } };
    }
    const prompt = this.prompts.find(p => p.name === params.name);
    if (!prompt) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown prompt: ${params.name}` } };
    }
    const args = params.arguments ?? {};
    const missing = prompt.arguments
      .filter(a => a.required && !(typeof args[a.name] === 'string' && args[a.name]!.trim()))
      .map(a => a.name);
    if (missing.length > 0) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: `Missing required argument(s) for ${params.name}: ${missing.join(', ')}` },
      };
    }
    const result = prompt.build(args);
    return { jsonrpc: '2.0', id: request.id, result };
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

    const args: Record<string, unknown> = { ...((params.arguments ?? {}) as Record<string, unknown>) };
    const gated = this.gate !== undefined && !tool.annotations.readOnlyHint;
    const operationId = gated ? args['operationId'] : undefined;
    if (gated) delete args['operationId'];
    const badId = operationId === undefined ? undefined : invalidOperationId(operationId);
    if (badId) return toolError(request.id, `Input validation error: operationId ${badId}`);

    // Validate input via Zod
    const parseResult = tool.zodSchema.safeParse(args);
    if (!parseResult.success) {
      return toolError(request.id, `Input validation error: ${parseResult.error.message}`);
    }

    if (operationId === undefined) return (await this.runTool(tool, parseResult.data, request.id)).response;
    return this.runIdempotent(tool, operationId as string, parseResult.data, request.id);
  }

  /** Replay gate (epic #17): JSON-RPC adapter over the shared IdempotencyGate. */
  private async runIdempotent(tool: ToolDefinition, operationId: string, input: unknown, id: unknown): Promise<JsonRpcResponse> {
    const gated = await this.gate!.run(tool.name, operationId, input, () => this.runTool(tool, input, id));
    switch (gated.kind) {
      case 'ran': return gated.outcome.response;
      case 'replayed': return { jsonrpc: '2.0', id, result: successResult(gated.value) };
      case 'reused': return toolError(id, formatBcError({ code: 'OPERATION_ID_REUSED', message: gated.message }));
      case 'inDoubt':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: formatBcError({ code: 'OPERATION_IN_DOUBT', message: gated.message }) },
              { type: 'text', text: JSON.stringify(gated.state) },
            ],
            structuredContent: gated.state,
            isError: true,
          },
        };
    }
  }

  private async runTool(tool: ToolDefinition, input: unknown, id: unknown): Promise<ToolRun> {
    const outcome = await this.executeTool(tool, input, id);
    const { failure } = outcome;
    const result = outcome.response.result as { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> } | undefined;
    // An ambiguous failure of a mutating tool is exactly when the caller most
    // needs the verdict: the change may have committed, so a re-run is unsafe.
    if (failure && result && !tool.annotations.readOnlyHint && isAmbiguousFailure(failure.code)) {
      const state = { ...(result.structuredContent ?? (failure.code ? { code: failure.code } : {})), replaySafe: false };
      outcome.response.result = { ...result, content: [result.content[0]!, { type: 'text', text: JSON.stringify(state) }], structuredContent: state };
    }
    return outcome;
  }

  private async executeTool(tool: ToolDefinition, input: unknown, id: unknown): Promise<ToolRun> {
    try {
      const result = await tool.execute(input);
      // Result is a Result<T, BCError>
      const r = result as { ok: boolean; value?: unknown; error?: { message: string } };
      if (r.ok) return { response: { jsonrpc: '2.0', id, result: successResult(r.value) }, value: r.value };
      const errObj = r.error as { code?: string; message?: string } | undefined;
      const failure = { code: errObj?.code, message: errObj?.message ?? 'Unknown error' };
      if (errObj instanceof UrlElicitationRequiredError || errObj?.code === 'URL_ELICITATION_REQUIRED') {
        return { response: urlElicitationResponse(id, errObj as UrlElicitationRequiredError), failure };
      }
      const text = (errObj && typeof errObj.code === 'string')
        ? formatBcError(errObj as { code: string; message: string })
        : `Error: ${failure.message}`;
      return { response: toolError(id, text), failure };
    } catch (e) {
      if (e instanceof UrlElicitationRequiredError) {
        return { response: urlElicitationResponse(id, e), failure: { code: e.code, message: e.message } };
      }
      // BCError subclasses (BusinessValidationError, BusinessError, SessionLostError, etc.)
      if (e instanceof BCError) {
        const failure = { code: e.code, message: e.message };
        if (e instanceof SessionLostError) {
          this.logger.info(`Session recovered during ${tool.name}. Impacted contexts: ${e.impactedPageContextIds.join(', ') || 'none'}`);
          // Recovery state as data, not just prose, so an agent can tell which
          // pageContextIds died and whether the reconnect itself failed.
          const state = { code: e.code, impactedPageContextIds: e.impactedPageContextIds, reconnectFailed: e.reconnectFailed };
          return {
            response: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: formatBcError(e) }, { type: 'text', text: JSON.stringify(state) }],
                structuredContent: state,
                isError: true,
              },
            },
            failure,
          };
        }
        this.logger.error(`Tool ${tool.name} threw BCError [${e.code}]: ${e.message}`);
        return { response: toolError(id, formatBcError(e)), failure };
      }

      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Tool ${tool.name} failed: ${message}`);
      return { response: toolError(id, `Tool error: ${message}`), failure: { message } };
    }
  }
}

/** One tool run: the JSON-RPC response, plus the raw output value or the failure. */
interface ToolRun { response: JsonRpcResponse; value?: unknown; failure?: Failure }

/** A successful tool result. A replay renders the stored value the same way (minus stripped download bytes). */
function successResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const OPERATION_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Optional idempotency key (e.g. a UUID you generate). Retrying with the same operationId and the same '
    + 'arguments returns the first call\'s stored result instead of running the change again, so a retry after a '
    + 'dropped connection or timeout cannot double-post. Reusing it with different arguments is rejected '
    + '(OPERATION_ID_REUSED). If the first call\'s outcome is unknown, the retry returns OPERATION_IN_DOUBT: '
    + 'check the record\'s state before acting again under a new operationId. Every result of this tool carries '
    + 'replaySafe: true means BC\'s response proved that re-running the same call (even under a new operationId, '
    + 'after an unknown outcome) cannot apply the change twice -- the write was echoed as an absolute value, or '
    + 'the form it acted on is closed so BC rejects a re-run; false means a re-run may double-apply or nothing '
    + 'proved otherwise, so read the record back before retrying. Replay is time-limited: a completed entry is '
    + 'kept for BC_OPERATION_TTL (default 24h), after which the same operationId runs the call again; check with '
    + 'bc_get_operation before a late retry. A replayed result carries download metadata (fileName, contentType, '
    + 'sizeBytes, savedPath) but not the file bytes.',
};

function withOperationId(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  return { ...schema, properties: { ...properties, operationId: OPERATION_ID_SCHEMA } };
}

function toolError(id: unknown, text: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

function urlElicitationResponse(id: unknown, e: UrlElicitationRequiredError): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: URL_ELICITATION_JSONRPC_CODE,
      message: e.message,
      data: { elicitations: e.elicitations },
    },
  };
}
