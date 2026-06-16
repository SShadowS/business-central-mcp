import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { MCPHandler } from '../../src/mcp/handler.js';
import type { ToolDefinition } from '../../src/mcp/tool-registry.js';
import { BCError, SessionLostError, BusinessError, BusinessValidationError } from '../../src/core/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRequest(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

/** Build a minimal ToolDefinition with a controllable execute mock */
function makeTool(
  name: string,
  zodSchema: z.ZodType = z.object({}),
  execute: ToolDefinition['execute'] = vi.fn().mockResolvedValue({ ok: true, value: { result: 'ok' } }),
): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    zodSchema,
    execute,
  };
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — initialize', () => {
  it('returns protocolVersion, serverInfo, and capabilities', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('initialize'));
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBeTypeOf('string');
    expect(result.serverInfo).toMatchObject({ name: 'bc-mcp' });
    expect(result.capabilities).toMatchObject({
      tools: { listChanged: false },
      resources: expect.any(Object),
      prompts: expect.any(Object),
    });
  });

  it('sets isInitialized to true after the call', async () => {
    const handler = new MCPHandler([], makeLogger());
    expect(handler.isInitialized).toBe(false);
    await handler.handleRequest(makeRequest('initialize'));
    expect(handler.isInitialized).toBe(true);
  });

  it('preserves request id in response', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('initialize', undefined, 42));
    expect(res.id).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// notifications/initialized
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — notifications/initialized', () => {
  it('returns an empty result object', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('notifications/initialized'));
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
  });

  it('does not set isInitialized', async () => {
    const handler = new MCPHandler([], makeLogger());
    await handler.handleRequest(makeRequest('notifications/initialized'));
    expect(handler.isInitialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/list', () => {
  it('returns an empty tools array when no tools registered', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/list'));
    const result = res.result as { tools: unknown[] };
    expect(result.tools).toEqual([]);
  });

  it('maps each tool to {name, description, inputSchema}', async () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const tool = makeTool('bc_test');
    tool.inputSchema = schema;
    const handler = new MCPHandler([tool], makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/list'));
    const result = res.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toEqual({ name: 'bc_test', description: 'bc_test description', inputSchema: schema });
  });

  it('lists all registered tools', async () => {
    const tools = [makeTool('bc_a'), makeTool('bc_b'), makeTool('bc_c')];
    const handler = new MCPHandler(tools, makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/list'));
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.map(t => t.name)).toEqual(['bc_a', 'bc_b', 'bc_c']);
  });
});

// ---------------------------------------------------------------------------
// tools/call — routing and validation
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/call: missing / unknown tool', () => {
  it('returns error -32602 when params.name is absent', async () => {
    const handler = new MCPHandler([makeTool('bc_x')], makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/call', {}));
    expect(res.error).toMatchObject({ code: -32602, message: expect.stringContaining('Missing tool name') });
    expect(res.result).toBeUndefined();
  });

  it('returns error -32602 when params is undefined', async () => {
    const handler = new MCPHandler([makeTool('bc_x')], makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/call'));
    expect(res.error).toMatchObject({ code: -32602 });
  });

  it('returns error -32602 when tool name is not found', async () => {
    const handler = new MCPHandler([makeTool('bc_x')], makeLogger());
    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_unknown' }));
    expect(res.error).toMatchObject({ code: -32602, message: expect.stringContaining('bc_unknown') });
    expect(res.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tools/call — Zod validation failure
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/call: zod validation failure', () => {
  it('returns isError:true with validation message when input does not match schema', async () => {
    const schema = z.object({ requiredField: z.string() });
    const execute = vi.fn();
    const tool = makeTool('bc_strict', schema, execute);
    const handler = new MCPHandler([tool], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_strict', arguments: { wrongField: 123 } }));
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Input validation error');
    // execute must NOT have been called
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats missing arguments as empty object for zod (passes z.object({}))', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const tool = makeTool('bc_empty', z.object({}), execute);
    const handler = new MCPHandler([tool], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_empty' /* no arguments key */ }));
    expect(res.error).toBeUndefined();
    const result = res.result as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({});
  });
});

// ---------------------------------------------------------------------------
// tools/call — happy path
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/call: success', () => {
  it('returns text content with JSON-stringified value and no isError on ok result', async () => {
    const payload = { pageContextId: 'session:page:1', fields: [{ name: 'No_', value: '1000' }] };
    const execute = vi.fn().mockResolvedValue({ ok: true, value: payload });
    const handler = new MCPHandler([makeTool('bc_open', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_open', arguments: {} }));
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it('passes validated (parsed) arguments to execute', async () => {
    const schema = z.object({ pageId: z.number() });
    const execute = vi.fn().mockResolvedValue({ ok: true, value: null });
    const tool = makeTool('bc_typed', schema, execute);
    const handler = new MCPHandler([tool], makeLogger());

    await handler.handleRequest(makeRequest('tools/call', { name: 'bc_typed', arguments: { pageId: 27 } }));
    expect(execute).toHaveBeenCalledWith({ pageId: 27 });
  });
});

// ---------------------------------------------------------------------------
// tools/call — err result (returned, not thrown)
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/call: err result', () => {
  it('returns isError:true with formatted BCError when err has a code', async () => {
    const errObj = { code: 'VALIDATION_ERROR', message: 'Name is required.' };
    const execute = vi.fn().mockResolvedValue({ ok: false, error: errObj });
    const handler = new MCPHandler([makeTool('bc_w', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_w', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error [VALIDATION_ERROR]: Name is required.');
    // VALIDATION_ERROR has a registered hint
    expect(result.content[0].text).toContain('Hint:');
  });

  it('returns "Error: <message>" when err has no code', async () => {
    const errObj = { message: 'something went wrong' };
    const execute = vi.fn().mockResolvedValue({ ok: false, error: errObj });
    const handler = new MCPHandler([makeTool('bc_w2', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_w2', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: something went wrong');
  });

  it('returns "Unknown error" fallback when err object has no message', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: {} });
    const handler = new MCPHandler([makeTool('bc_w3', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_w3', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown error');
  });
});

// ---------------------------------------------------------------------------
// tools/call — thrown exceptions
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — tools/call: thrown BCError', () => {
  it('returns isError:true with formatBcError output when execute throws BCError subclass', async () => {
    const bcErr = new BusinessError({ bcText: 'Cannot post invoice.', severity: 'Error', source: 'message' });
    const execute = vi.fn().mockRejectedValue(bcErr);
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_post', z.object({}), execute)], logger);

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_post', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error [BUSINESS_ERROR]');
    expect(result.content[0].text).toContain('Cannot post invoice.');
    // Non-SessionLost BCError should log at error level
    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs at info level (not error) when execute throws SessionLostError', async () => {
    const sessionErr = new SessionLostError('Session died', ['ctx:1', 'ctx:2']);
    const execute = vi.fn().mockRejectedValue(sessionErr);
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_op', z.object({}), execute)], logger);

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_op', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error [SESSION_LOST]');
    expect(result.content[0].text).toContain('Session died');
    // SessionLostError -> info, not error
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ctx:1'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('includes hint for SessionLostError', async () => {
    const sessionErr = new SessionLostError('gone', []);
    const execute = vi.fn().mockRejectedValue(sessionErr);
    const handler = new MCPHandler([makeTool('bc_gone', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_gone', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.content[0].text).toContain('Hint:');
    expect(result.content[0].text).toContain('bc_open_page');
  });

  it('includes impacted context ids in logger message for SessionLostError', async () => {
    const sessionErr = new SessionLostError('lost', ['pcA', 'pcB']);
    const execute = vi.fn().mockRejectedValue(sessionErr);
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_x', z.object({}), execute)], logger);

    await handler.handleRequest(makeRequest('tools/call', { name: 'bc_x', arguments: {} }));
    const logCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(logCall).toContain('pcA');
    expect(logCall).toContain('pcB');
  });

  it('logs "none" when SessionLostError has no impacted context ids', async () => {
    const sessionErr = new SessionLostError('lost', []);
    const execute = vi.fn().mockRejectedValue(sessionErr);
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_y', z.object({}), execute)], logger);

    await handler.handleRequest(makeRequest('tools/call', { name: 'bc_y', arguments: {} }));
    const logCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(logCall).toContain('none');
  });

  it('returns isError:true with "Tool error:" prefix for non-BCError thrown', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('disk full'));
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_z', z.object({}), execute)], logger);

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_z', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool error: disk full');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('handles non-Error throws (string) gracefully', async () => {
    const execute = vi.fn().mockRejectedValue('raw string error');
    const handler = new MCPHandler([makeTool('bc_str', z.object({}), execute)], makeLogger());

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_str', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('raw string error');
  });

  it('forwards BusinessValidationError as BCError with VALIDATION_ERROR code', async () => {
    const validationErr = new BusinessValidationError([{ description: 'Name too long', field: 'Name' }]);
    const execute = vi.fn().mockRejectedValue(validationErr);
    const logger = makeLogger();
    const handler = new MCPHandler([makeTool('bc_val', z.object({}), execute)], logger);

    const res = await handler.handleRequest(makeRequest('tools/call', { name: 'bc_val', arguments: {} }));
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error [VALIDATION_ERROR]');
    expect(result.content[0].text).toContain('Name too long');
    expect(logger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resources/list
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — resources/list', () => {
  it('returns an empty resources array', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('resources/list'));
    expect(res.error).toBeUndefined();
    expect((res.result as { resources: unknown[] }).resources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resources/read
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — resources/read', () => {
  it('returns error -32601 Resource not found', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('resources/read', { uri: 'bc://anything' }));
    expect(res.result).toBeUndefined();
    expect(res.error).toMatchObject({ code: -32601, message: expect.stringContaining('not found') });
  });
});

// ---------------------------------------------------------------------------
// prompts/list
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — prompts/list', () => {
  it('returns an empty prompts array', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('prompts/list'));
    expect(res.error).toBeUndefined();
    expect((res.result as { prompts: unknown[] }).prompts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// prompts/get
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — prompts/get', () => {
  it('returns error -32601 Prompt not found', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('prompts/get', { name: 'no-such-prompt' }));
    expect(res.result).toBeUndefined();
    expect(res.error).toMatchObject({ code: -32601, message: expect.stringContaining('not found') });
  });
});

// ---------------------------------------------------------------------------
// Unknown method
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — unknown method', () => {
  it('returns -32601 with method name in message', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('totally/unknown'));
    expect(res.error).toMatchObject({ code: -32601, message: expect.stringContaining('totally/unknown') });
  });

  it('preserves request id on unknown method', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('no/method', undefined, 'req-99'));
    expect(res.id).toBe('req-99');
    expect(res.error?.code).toBe(-32601);
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC envelope invariants
// ---------------------------------------------------------------------------

describe('MCPHandler.handleRequest — JSON-RPC envelope', () => {
  it('always returns jsonrpc:"2.0"', async () => {
    const handler = new MCPHandler([], makeLogger());
    for (const method of ['initialize', 'tools/list', 'resources/list', 'unknown']) {
      const res = await handler.handleRequest(makeRequest(method, undefined, method));
      expect(res.jsonrpc).toBe('2.0');
    }
  });

  it('echoes null id correctly', async () => {
    const handler = new MCPHandler([], makeLogger());
    const res = await handler.handleRequest(makeRequest('initialize', undefined, null));
    expect(res.id).toBeNull();
  });
});
