import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationLedger, LEDGER_FORMAT_VERSION, digestInput } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const HOUR = 3_600_000;

describe('OperationLedger entry format version (#37)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-format-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const fileFor = (id: string) => join(dir, 'operations', `${createHash('sha256').update(id).digest('hex')}.json`);
  /** Write an entry as an older process would have (no `v`). */
  function writeRaw(id: string, fields: Record<string, unknown>): void {
    mkdirSync(join(dir, 'operations'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(fileFor(id), JSON.stringify({ operationId: id, tool: 'bc_write', inputDigest: digestInput({ value: 'x' }), createdAt: now, updatedAt: now, ...fields }));
  }
  const runGate = (id: string, exec = vi.fn().mockResolvedValue({ value: { fresh: true } })) =>
    new IdempotencyGate(new OperationLedger(dir), logger()).run('bc_write', id, { value: 'x' }, exec).then(o => ({ o, exec }));

  it('stamps the current version on claim and keeps it through settle', async () => {
    const ledger = new OperationLedger(dir);
    await ledger.claim('a', 'bc_write', 'd');
    expect(JSON.parse(readFileSync(fileFor('a'), 'utf8')).v).toBe(LEDGER_FORMAT_VERSION);
    await ledger.settle('a', { status: 'completed', result: { ok: 1 } });
    expect(JSON.parse(readFileSync(fileFor('a'), 'utf8')).v).toBe(LEDGER_FORMAT_VERSION);
  });

  it('unwraps a pre-#30 MCP envelope to the raw value and replays it without re-running', async () => {
    const value = { posted: 'SO-1', replaySafe: true, downloads: [{ fileName: 'a.xlsx', sizeBytes: 3, bytes: 'QUJD' }] };
    writeRaw('old-ok', { status: 'completed', replaySafe: true, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } });
    const { o, exec } = await runGate('old-ok');
    expect(exec).not.toHaveBeenCalled();
    expect(o.kind).toBe('replayed');
    const replayed = (o as { value: typeof value }).value;
    expect(replayed.posted).toBe('SO-1');
    expect(replayed.downloads[0]).not.toHaveProperty('bytes');
    expect((replayed.downloads[0] as unknown as { error: { code: string } }).error.code).toBe('NOT_REPLAYED');
  });

  it('replays an unversioned #30-era raw result as-is instead of marking it in doubt', async () => {
    const value = { fields: [{ name: 'Name', value: 'A' }], replaySafe: true, downloads: [{ fileName: 'a.xlsx', sizeBytes: 3, bytes: 'QUJD' }] };
    writeRaw('raw-ok', { status: 'completed', replaySafe: true, result: value });
    const { o, exec } = await runGate('raw-ok');
    expect(exec).not.toHaveBeenCalled();
    expect(o.kind).toBe('replayed');
    const replayed = (o as { value: typeof value }).value;
    expect(replayed.fields).toEqual(value.fields);
    expect(replayed.downloads[0]).not.toHaveProperty('bytes');
    // completed TTL, not the in-doubt one
    expect(await new OperationLedger(dir, { completedTtlMs: 24 * HOUR, inDoubtTtlMs: 30 * 24 * HOUR }).prune(Date.now() + 25 * HOUR)).toBe(1);
  });

  it.each([
    ['non-JSON envelope text', { status: 'completed', result: { content: [{ type: 'text', text: 'Posted.' }] } }],
    ['a newer format version', { v: LEDGER_FORMAT_VERSION + 1, status: 'completed', result: { posted: 'SO-1' } }],
  ])('treats %s as in doubt, never re-running or releasing it', async (_label, fields) => {
    writeRaw('odd', fields);
    const { o, exec } = await runGate('odd');
    expect(exec).not.toHaveBeenCalled();
    expect(o.kind).toBe('inDoubt');
    expect((o as { state: Record<string, unknown> }).state).toMatchObject({ code: 'OPERATION_IN_DOUBT', status: 'unknown', replaySafe: false, error: { code: 'LEDGER_FORMAT' } });
    expect(existsSync(fileFor('odd'))).toBe(true); // not released
  });

  it('keeps old sent/unknown entries in doubt', async () => {
    writeRaw('old-sent', { status: 'sent' });
    const { o, exec } = await runGate('old-sent');
    expect(exec).not.toHaveBeenCalled();
    expect((o as { state: Record<string, unknown> }).state).toMatchObject({ status: 'sent' });
  });

  it('prunes an unconvertible old completed entry on the long in-doubt retention, not the completed TTL', async () => {
    writeRaw('odd', { status: 'completed', result: { content: [{ type: 'text', text: 'Posted.' }] } });
    const ledger = new OperationLedger(dir, { completedTtlMs: 24 * HOUR, inDoubtTtlMs: 30 * 24 * HOUR });
    expect(await ledger.prune(Date.now() + 25 * HOUR)).toBe(0);
    expect(await ledger.prune(Date.now() + 31 * 24 * HOUR)).toBe(1);
  });
});
