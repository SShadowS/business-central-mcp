import type { ToolDefinition } from './tool-registry.js';
import type { PromptDefinition } from './prompts.js';
import type { Logger } from '../core/logger.js';
import { SessionLostError, BCError, UrlElicitationRequiredError, errorHint } from '../core/errors.js';
import { applyElicitationCapabilities, type ClientElicitationPort } from './elicitation-port.js';
import { SERVER_VERSION } from '../core/version.js';
import { IdempotencyGate, invalidOperationId, isAmbiguousFailure, type Failure } from './idempotency-gate.js';
import { bcErrorResult } from './error-envelope.js';
import type { ErrorBody } from '@sshadows/bc-toolbox-envelope';
import type { SkillDefinition } from './skills.js';
import { SKILL_TTL_MS, SKILL_CACHE_SCOPE, findSkillResource } from './skills.js';

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
  private readonly skills: SkillDefinition[];

  get isInitialized(): boolean {
    return this.initialized;
  }

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly logger: Logger,
    private readonly prompts: PromptDefinition[] = [],
    opts?: { elicitationPort?: ClientElicitationPort; gate?: IdempotencyGate; skills?: SkillDefinition[] },
  ) {
    this.elicitationPort = opts?.elicitationPort;
    this.gate = opts?.gate;
    this.skills = opts?.skills ?? [];
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
          return this.handleResourcesList(request);
        case 'resources/read':
          return this.handleResourcesRead(request);
        case 'prompts/list':
          return this.handlePromptsList(request);
        case 'prompts/get':
          return this.handlePromptsGet(request);
        case 'skills/list':
          return this.handleSkillsList(request);
        case 'skills/get':
          return this.handleSkillsGet(request);
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
          ...(this.skills.length > 0
            ? { extensions: { 'io.modelcontextprotocol/skills': { directoryRead: false } } }
            : {}),
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
          outputSchema: t.outputSchema,
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

  private handleResourcesList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resources: this.skills.map(s => ({
          uri: s.entry.uri,
          name: `${s.entry.frontmatter.name}/SKILL.md`,
          mimeType: 'text/markdown',
        })),
      },
    };
  }

  private handleResourcesRead(request: JsonRpcRequest): JsonRpcResponse {
    const uri = (request.params as { uri?: string } | undefined)?.uri;
    const hit = uri ? findSkillResource(this.skills, uri) : undefined;
    if (!hit || !uri) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Resource not found' } };
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        contents: [{ uri, mimeType: 'text/markdown', text: hit.text }],
        ttlMs: SKILL_TTL_MS,
        cacheScope: SKILL_CACHE_SCOPE,
      },
    };
  }

  private handleSkillsList(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        skills: this.skills.map(s => s.entry),
        ttlMs: SKILL_TTL_MS,
        cacheScope: SKILL_CACHE_SCOPE,
      },
    };
  }

  private handleSkillsGet(request: JsonRpcRequest): JsonRpcResponse {
    const uri = (request.params as { uri?: string } | undefined)?.uri;
    if (!uri) return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Missing skill uri' } };
    const skill = this.skills.find(s => s.entry.uri === uri);
    if (!skill) return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `Unknown skill: ${uri}` } };
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { resultType: 'complete', skill: skill.entry, ttlMs: SKILL_TTL_MS, cacheScope: SKILL_CACHE_SCOPE },
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

    const args: Record<string, unknown> = { ...((params.arguments ?? {}) as Record<string, unknown>) };
    const gated = this.gate !== undefined && !tool.annotations.readOnlyHint;
    const operationId = gated ? args['operationId'] : undefined;
    if (gated) delete args['operationId'];
    const badId = operationId === undefined ? undefined : invalidOperationId(operationId);
    if (badId) return bcErrorResult(request.id, tool.name, { code: 'INPUT_VALIDATION_ERROR', message: `operationId ${badId}` });

    // Validate input via Zod
    const parseResult = tool.zodSchema.safeParse(args);
    if (!parseResult.success) {
      return bcErrorResult(request.id, tool.name, { code: 'INPUT_VALIDATION_ERROR', message: parseResult.error.message });
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
      case 'reused': return bcErrorResult(id, tool.name, { code: 'OPERATION_ID_REUSED', message: gated.message });
      case 'inDoubt':
        return bcErrorResult(id, tool.name, { code: 'OPERATION_IN_DOUBT', message: gated.message }, {
          operationId: String(gated.state.operationId),
          status: String(gated.state.status),
          createdAt: Number(gated.state.createdAt) || 0,
          ...(gated.state.target ? { target: JSON.stringify(gated.state.target) } : {}),
          ...(gated.state.error ? { error: JSON.stringify(gated.state.error) } : {}),
        });
    }
  }

  private async runTool(tool: ToolDefinition, input: unknown, id: unknown): Promise<ToolRun> {
    const outcome = await this.executeTool(tool, input, id);
    const { failure } = outcome;
    const result = outcome.response.result as { content: Array<{ type: string; text: string }>; structuredContent?: ErrorBody } | undefined;
    // An ambiguous failure of a mutating tool is exactly when the caller most
    // needs the verdict: the change may have committed, so a re-run is unsafe.
    // The result is already an error envelope; stamp the verdict into its
    // scalar-only `error.details` (a sibling of `error` would break the strict body).
    if (failure && result?.structuredContent?.error && !tool.annotations.readOnlyHint && isAmbiguousFailure(failure.code)) {
      const body = result.structuredContent;
      body.error.details = { ...body.error.details, replaySafe: false };
      result.content = [{ type: 'text', text: JSON.stringify(body, null, 2) }];
    }
    return outcome;
  }

  private async executeTool(tool: ToolDefinition, input: unknown, id: unknown): Promise<ToolRun> {
    try {
      const result = await tool.execute(input);
      // Result is a Result<T, BCError>
      const r = result as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
      if (r.ok) return { response: { jsonrpc: '2.0', id, result: successResult(r.value) }, value: r.value };
      const errObj = r.error;
      const failure = { code: errObj?.code, message: errObj?.message ?? 'Unknown error' };
      if (errObj instanceof UrlElicitationRequiredError || errObj?.code === 'URL_ELICITATION_REQUIRED') {
        return { response: urlElicitationResponse(id, errObj as UrlElicitationRequiredError), failure };
      }
      // Pass the error INSTANCE when it is a BCError so detailsFor's instanceof
      // branches carry the rich scalar fields; a plain object carries only its code.
      const like = errObj instanceof BCError ? errObj : { code: errObj?.code, message: failure.message };
      return { response: bcErrorResult(id, tool.name, like), failure };
    } catch (e) {
      if (e instanceof UrlElicitationRequiredError) {
        return { response: urlElicitationResponse(id, e), failure: { code: e.code, message: e.message } };
      }
      // BCError subclasses (BusinessValidationError, BusinessError, SessionLostError, etc.)
      if (e instanceof BCError) {
        const failure = { code: e.code, message: e.message };
        if (e instanceof SessionLostError) {
          // SessionLost is a recovered state, not a server fault: log at info.
          // The impacted pageContextIds + reconnectFailed ride in error.details.
          this.logger.info(`Session recovered during ${tool.name}. Impacted contexts: ${e.impactedPageContextIds.join(', ') || 'none'}`);
        } else {
          this.logger.error(`Tool ${tool.name} threw BCError [${e.code}]: ${e.message}`);
        }
        return { response: bcErrorResult(id, tool.name, e), failure };
      }

      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Tool ${tool.name} failed: ${message}`);
      return { response: bcErrorResult(id, tool.name, { message }), failure: { message } };
    }
  }
}

/** One tool run: the JSON-RPC response, plus the raw output value or the failure. */
interface ToolRun { response: JsonRpcResponse; value?: unknown; failure?: Failure }

/**
 * A successful tool result. The JSON text stays for human/legacy readers; the
 * same value is also attached as `structuredContent` so it validates against the
 * tool's advertised `outputSchema`. A replay renders the stored value the same
 * way (minus stripped download bytes). All 16 tool outputs are objects; the
 * guard keeps the function total for a non-object or array value.
 */
function successResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  const base = { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...base, structuredContent: value as Record<string, unknown> }
    : base;
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
