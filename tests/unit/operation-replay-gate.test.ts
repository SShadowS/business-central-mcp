import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MCPHandler } from '../../src/mcp/handler.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import type { ToolDefinition } from '../../src/mcp/tool-registry.js';
import { BusinessValidationError, ProtocolError, SessionLostError, TimeoutError } from '../../src/core/errors.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const withGate = (ledger: OperationLedger) => ({ gate: new IdempotencyGate(ledger, logger()) });

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
    const first = await call(new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir))), { value: 'x', operationId: 'op-1' });
    // A fresh handler + ledger over the same dir = a restarted process.
    const second = await call(new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir))), { value: 'x', operationId: 'op-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ value: 'x' }); // operationId stripped before the tool sees input
    expect(second).toEqual(first);
  });

  it('records the tool\'s replaySafe verdict on the ledger entry; unknown outcomes are never replay-safe', async () => {
    const ledger = new OperationLedger(dir);
    const ok = vi.fn().mockResolvedValue({ ok: true, value: { replaySafe: true } });
    await call(new MCPHandler([mutatingTool(ok)], logger(), [], withGate(ledger)), { value: 'x', operationId: 'rs-1' });
    expect((await ledger.get('rs-1'))?.replaySafe).toBe(true);

    const noVerdict = vi.fn().mockResolvedValue({ ok: true, value: {} });
    await call(new MCPHandler([mutatingTool(noVerdict)], logger(), [], withGate(ledger)), { value: 'x', operationId: 'rs-2' });
    expect((await ledger.get('rs-2'))?.replaySafe).toBe(false);

    const timeout = vi.fn().mockResolvedValue({ ok: false, error: new TimeoutError('watchdog') });
    const h = new MCPHandler([mutatingTool(timeout)], logger(), [], withGate(ledger));
    await call(h, { value: 'x', operationId: 'rs-3' });
    expect((await ledger.get('rs-3'))?.replaySafe).toBe(false);
    const inDoubt = (await call(h, { value: 'x', operationId: 'rs-3' })).structuredContent as { error: { code: string; category: string } };
    expect(inDoubt.error).toMatchObject({ code: 'OPERATION_IN_DOUBT', category: 'state' });
  });

  it('puts replaySafe:false on the first response to an ambiguous failure, with or without operationId', async () => {
    const timeout = vi.fn().mockResolvedValue({ ok: false, error: new TimeoutError('watchdog') });
    const gated = await call(new MCPHandler([mutatingTool(timeout)], logger(), [], withGate(new OperationLedger(dir))), { value: 'x', operationId: 'af-1' });
    expect(gated.isError).toBe(true);
    // The verdict rides in the strict envelope's scalar `error.details`.
    expect((gated.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error)
      .toMatchObject({ code: 'TIMEOUT', details: { bcCode: 'TIMEOUT_ERROR', replaySafe: false } });
    expect(JSON.parse(gated.content[0]!.text).error.details.replaySafe).toBe(false);

    const lost = vi.fn().mockRejectedValue(new SessionLostError('dropped', ['pc:1']));
    const plain = await call(new MCPHandler([mutatingTool(lost)], logger(), []), { value: 'x' });
    expect((plain.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error)
      .toMatchObject({ code: 'SESSION_LOST', details: { impactedPageContextIds: '["pc:1"]', replaySafe: false } });

    // Definite failures and read-only tools carry an envelope but no replaySafe verdict.
    const invalid = vi.fn().mockResolvedValue({ ok: false, error: new BusinessValidationError([{ description: 'bad' }]) });
    const definite = (await call(new MCPHandler([mutatingTool(invalid)], logger(), []), { value: 'x' })).structuredContent as { error: { details: Record<string, unknown> } };
    expect(definite.error.details).not.toHaveProperty('replaySafe');
    const readTimeout = await call(new MCPHandler([mutatingTool(timeout, true)], logger(), []), { value: 'x' }, 'bc_read');
    expect((readTimeout.structuredContent as { error: { details: Record<string, unknown> } }).error.details).not.toHaveProperty('replaySafe');
  });

  it('rejects a reused id with different input', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir)));
    await call(h, { value: 'x', operationId: 'op-2' });
    const r = await call(h, { value: 'y', operationId: 'op-2' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('OPERATION_ID_REUSED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports an ambiguous failure as in doubt on retry, never re-executing', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: new TimeoutError('watchdog') });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir)));
    await call(h, { value: 'x', operationId: 'op-3' });
    const r = await call(h, { value: 'x', operationId: 'op-3' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as { error: { code: string; details: Record<string, unknown> } };
    expect(sc.error).toMatchObject({ code: 'OPERATION_IN_DOUBT', details: { operationId: 'op-3', status: 'unknown' } });
    expect(JSON.parse(sc.error.details.error as string).code).toBe('TIMEOUT_ERROR');
  });

  it('frees the id after a definite failure so a retry executes again', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: new BusinessValidationError([{ field: 'x', description: 'bad' }]) })
      .mockResolvedValueOnce({ ok: true, value: { ok: 1 } });
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir)));
    expect((await call(h, { value: 'x', operationId: 'op-4' })).isError).toBe(true);
    expect((await call(h, { value: 'x', operationId: 'op-4' })).isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two truly concurrent calls with one id execute', async () => {
    const releases: Array<() => void> = [];
    const execute = vi.fn().mockImplementation(() => new Promise(res => { releases.push(() => res({ ok: true, value: {} })); }));
    const h = new MCPHandler([mutatingTool(execute)], logger(), [], withGate(new OperationLedger(dir)));
    // Fire both before either claim settles: the loser must see the winner's complete entry.
    const a = call(h, { value: 'x', operationId: 'op-5' });
    const b = call(h, { value: 'x', operationId: 'op-5' });
    const loser = await Promise.race([a, b]);
    expect((loser.structuredContent as { error: { code: string; details: Record<string, unknown> } }).error)
      .toMatchObject({ code: 'OPERATION_IN_DOUBT', details: { status: 'sent' } });
    releases.forEach(r => r());
    await Promise.all([a, b]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never exposes a partially written entry while a claim is in flight', async () => {
    // Regression: claim() used writeFile(wx) = open then write, so a concurrent
    // claimer (or a restart after a mid-write crash) read '' and threw SyntaxError.
    const ledger = new OperationLedger(dir);
    const big = { args: { blob: 'x'.repeat(3_000_000) }, capturedAt: '' };
    for (let i = 0; i < 20; i++) {
      let done = false;
      const claim = ledger.claim(`op-race-${i}`, 't', 'd', big).finally(() => { done = true; });
      while (!done) {
        const seen = await ledger.get(`op-race-${i}`); // throws on a partial file
        if (seen) expect(seen.status).toBe('sent');
      }
      expect((await claim).claimed).toBe(true);
      expect((await ledger.claim(`op-race-${i}`, 't', 'd')).claimed).toBe(false);
    }
  });

  it('advertises operationId only on mutating tools and leaves read-only input untouched', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const h = new MCPHandler([mutatingTool(execute), mutatingTool(execute, true)], logger(), [], withGate(new OperationLedger(dir)));
    const list = (await h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    expect(list.tools.find(t => t.name === 'bc_write')!.inputSchema.properties).toHaveProperty('operationId');
    expect(list.tools.find(t => t.name === 'bc_read')!.inputSchema.properties).not.toHaveProperty('operationId');
  });

  it('releases the id when an ambiguous failure happened before any frame reached BC (#41)', async () => {
    const ledger = new OperationLedger(dir);
    let sent = 0;
    const gate = { gate: new IdempotencyGate(ledger, logger(), undefined, () => sent) };
    const lookupFails = vi.fn().mockResolvedValue({ ok: false, error: new ProtocolError('Action not found: Make Order') });
    await call(new MCPHandler([mutatingTool(lookupFails)], logger(), [], gate), { value: 'x', operationId: 'pre-1' });
    expect(await ledger.get('pre-1')).toBeUndefined();

    const sentThenFails = vi.fn().mockImplementation(async () => { sent++; return { ok: false, error: new ProtocolError('bad frame') }; });
    await call(new MCPHandler([mutatingTool(sentThenFails)], logger(), [], gate), { value: 'x', operationId: 'pre-2' });
    expect((await ledger.get('pre-2'))?.status).toBe('unknown');
  });

  it('digestInput ignores key order', () => {
    expect(digestInput({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(digestInput({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });
});
