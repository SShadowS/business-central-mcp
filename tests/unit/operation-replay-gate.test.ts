import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MCPHandler } from '../../src/mcp/handler.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import type { ToolDefinition } from '../../src/mcp/tool-registry.js';
import { BusinessValidationError, TimeoutError } from '../../src/core/errors.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function mutatingTool(execute: ToolDefinition['execute'], readOnly = false): ToolDefinition {
  return {
    name: readOnly ? 'bc_read' : 'bc_write',
    description: 'd',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    zodSchema: z.object({ value: z.string() }),
    execute,
    annotations: readOnly ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

describe('operationId replay gate', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-ledger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const call = (h: MCPHandler, args: Record<string, unknown>, name = 'bc_write') =>
    h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .then(r => r.result as ToolResult);

  it('replays the stored result for a repeated id + input without re-executing, across ledger instances', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: { posted: 'SO-1' } });
    const first = await call(new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) }), { value: 'x', operationId: 'op-1' });
    // A fresh handler + ledger over the same dir = a restarted process.
    const second = await call(new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) }), { value: 'x', operationId: 'op-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ value: 'x' }); // operationId stripped before the tool sees input
    expect(second).toEqual(first);
  });

  it('rejects a reused id with different input', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) });
    await call(h, { value: 'x', operationId: 'op-2' });
    const r = await call(h, { value: 'y', operationId: 'op-2' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('OPERATION_ID_REUSED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports an ambiguous failure as in doubt on retry, never re-executing', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: new TimeoutError('watchdog') });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) });
    await call(h, { value: 'x', operationId: 'op-3' });
    const r = await call(h, { value: 'x', operationId: 'op-3' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'OPERATION_IN_DOUBT', operationId: 'op-3', status: 'unknown', error: { code: 'TIMEOUT_ERROR' } });
  });

  it('frees the id after a definite failure so a retry executes again', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: new BusinessValidationError([{ field: 'x', description: 'bad' }]) })
      .mockResolvedValueOnce({ ok: true, value: { ok: 1 } });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) });
    expect((await call(h, { value: 'x', operationId: 'op-4' })).isError).toBe(true);
    expect((await call(h, { value: 'x', operationId: 'op-4' })).isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two concurrent calls with one id execute', async () => {
    let release!: () => void;
    const execute = vi.fn().mockImplementation(() => new Promise(res => { release = () => res({ ok: true, value: {} }); }));
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], { ledger: new OperationLedger(dir) });
    const a = call(h, { value: 'x', operationId: 'op-5' });
    // Let `a` win the claim first; otherwise `b` may claim, execute and hang on the never-released promise.
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const b = await call(h, { value: 'x', operationId: 'op-5' });
    expect(b.structuredContent).toMatchObject({ code: 'OPERATION_IN_DOUBT', status: 'sent' });
    release();
    expect((await a).isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('advertises operationId only on mutating tools and leaves read-only input untouched', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const h = new MCPHandler([mutatingTool(execute), mutatingTool(execute, true)], logger(), [], { ledger: new OperationLedger(dir) });
    const list = (await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    expect(list.tools.find(t => t.name === 'bc_write')!.inputSchema.properties).toHaveProperty('operationId');
    expect(list.tools.find(t => t.name === 'bc_read')!.inputSchema.properties).not.toHaveProperty('operationId');
  });

  it('digestInput ignores key order', () => {
    expect(digestInput({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(digestInput({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });
});
