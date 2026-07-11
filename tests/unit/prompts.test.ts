import { describe, it, expect, vi } from 'vitest';
import { MCPHandler } from '../../src/mcp/handler.js';
import { PROMPTS } from '../../src/mcp/prompts.js';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function req(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

describe('PROMPTS registry', () => {
  it('every prompt has a unique bc_-prefixed name and a description', () => {
    const names = PROMPTS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PROMPTS) {
      expect(p.name).toMatch(/^bc_/);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it('build() with required args produces at least one non-empty user message', () => {
    for (const p of PROMPTS) {
      const args: Record<string, string> = {};
      for (const a of p.arguments) if (a.required) args[a.name] = 'X';
      const result = p.build(args);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[0]!.role).toBe('user');
      expect(result.messages[0]!.content.type).toBe('text');
      expect(result.messages[0]!.content.text.length).toBeGreaterThan(20);
    }
  });

  it('interpolates a provided required arg into the message text', () => {
    const findPage = PROMPTS.find(p => p.name === 'bc_find_page')!;
    const text = findPage.build({ query: 'customer list' }).messages[0]!.content.text;
    expect(text).toContain('customer list');
  });
});

describe('MCPHandler — prompts/list', () => {
  it('lists all prompts with name, description, and arguments', async () => {
    const handler = new MCPHandler([], makeLogger(), PROMPTS);
    const res = await handler.handleRequest(req('prompts/list'));
    const result = res.result as { prompts: Array<{ name: string; arguments: unknown[] }> };
    expect(result.prompts).toHaveLength(PROMPTS.length);
    expect(result.prompts.map(p => p.name)).toContain('bc_set_dimensions');
    const dims = result.prompts.find(p => p.name === 'bc_set_dimensions')!;
    expect(Array.isArray(dims.arguments)).toBe(true);
  });

  it('returns an empty list (and omits the capability) when no prompts are supplied', async () => {
    const handler = new MCPHandler([], makeLogger());
    const listRes = await handler.handleRequest(req('prompts/list'));
    expect((listRes.result as { prompts: unknown[] }).prompts).toEqual([]);
    const initRes = await handler.handleRequest(req('initialize'));
    const caps = (initRes.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(caps.prompts).toBeUndefined();
  });

  it('advertises the prompts capability on initialize when prompts are present', async () => {
    const handler = new MCPHandler([], makeLogger(), PROMPTS);
    const res = await handler.handleRequest(req('initialize'));
    const caps = (res.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(caps.prompts).toEqual({ listChanged: false });
  });
});

describe('MCPHandler — prompts/get', () => {
  const handler = new MCPHandler([], makeLogger(), PROMPTS);

  it('returns messages for a valid prompt with its required arg', async () => {
    const res = await handler.handleRequest(req('prompts/get', { name: 'bc_report', arguments: { reportId: '6' } }));
    const result = res.result as { description: string; messages: Array<{ content: { text: string } }> };
    expect(res.error).toBeUndefined();
    expect(result.messages[0]!.content.text).toContain('6');
  });

  it('rejects a missing required argument with -32602', async () => {
    const res = await handler.handleRequest(req('prompts/get', { name: 'bc_report', arguments: {} }));
    expect(res.result).toBeUndefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toMatch(/reportId/);
  });

  it('rejects an unknown prompt with -32602', async () => {
    const res = await handler.handleRequest(req('prompts/get', { name: 'bc_nope', arguments: {} }));
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toMatch(/Unknown prompt/);
  });

  it('rejects a missing prompt name with -32602', async () => {
    const res = await handler.handleRequest(req('prompts/get', {}));
    expect(res.error!.code).toBe(-32602);
  });
});
