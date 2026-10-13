import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';

const HOUR = 3_600_000;
const retention = { completedTtlMs: 24 * HOUR, inDoubtTtlMs: 30 * 24 * HOUR };

describe('OperationLedger retention (#29)', () => {
  let dir: string;
  let ledger: OperationLedger;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-prune-')); ledger = new OperationLedger(dir, retention); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function entry(id: string, status: 'sent' | 'completed' | 'unknown'): Promise<void> {
    await ledger.claim(id, 'bc_write', 'd');
    if (status !== 'sent') await ledger.settle(id, { status, result: { ok: 1 } });
  }

  it('returns 0 when the operations directory does not exist', async () => {
    expect(await ledger.prune()).toBe(0);
  });

  it('expires completed entries after the TTL and sent/unknown only after the long retention', async () => {
    await entry('c', 'completed');
    await entry('s', 'sent');
    await entry('u', 'unknown');
    const now = Date.now();

    expect(await ledger.prune(now + 23 * HOUR)).toBe(0);
    expect(await ledger.prune(now + 25 * HOUR)).toBe(1);
    expect(await ledger.get('c')).toBeUndefined();
    // A young sent entry is an in-flight call: never deleted before the long retention.
    expect((await ledger.get('s'))?.status).toBe('sent');
    expect((await ledger.get('u'))?.status).toBe('unknown');

    expect(await ledger.prune(now + 29 * 24 * HOUR)).toBe(0);
    expect(await ledger.prune(now + 31 * 24 * HOUR)).toBe(2);
    expect(await ledger.get('s')).toBeUndefined();
    expect(await ledger.get('u')).toBeUndefined();
  });

  it('lets an expired id run fresh again', async () => {
    await entry('c', 'completed');
    await ledger.prune(Date.now() + 25 * HOUR);
    expect(await ledger.claim('c', 'bc_write', 'other')).toEqual({ claimed: true });
  });

  it('removes orphaned temp files only once they are a few minutes old', async () => {
    await entry('c', 'completed');
    const opsDir = join(dir, 'operations');
    const tmp = join(opsDir, 'abc.json.123.tmp');
    writeFileSync(tmp, '{');
    const now = Date.now();
    expect(await ledger.prune(now + 60_000)).toBe(0);
    utimesSync(tmp, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
    expect(await ledger.prune(now)).toBe(1);
    expect(readdirSync(opsDir).some(n => n.endsWith('.tmp'))).toBe(false);
  });

  it('skips unreadable entries instead of failing the sweep', async () => {
    await entry('c', 'completed');
    writeFileSync(join(dir, 'operations', 'broken.json'), 'not json');
    expect(await ledger.prune(Date.now() + 25 * HOUR)).toBe(1);
  });

  it('stores download metadata but not the inline bytes', async () => {
    await ledger.claim('d', 'bc_execute_action', 'd');
    const result = { replaySafe: true, downloads: [{ fileName: 'a.xlsx', contentType: 'x', sizeBytes: 3, style: 'Download', bytes: 'AAAA', savedPath: '/tmp/a.xlsx' }], externalUris: [] };
    await ledger.settle('d', { status: 'completed', result });
    const stored = (await ledger.get('d'))?.result as typeof result;
    expect(stored.downloads).toEqual([{ fileName: 'a.xlsx', contentType: 'x', sizeBytes: 3, style: 'Download', savedPath: '/tmp/a.xlsx' }]);
    const files = readdirSync(join(dir, 'operations'));
    expect(await readFile(join(dir, 'operations', files[0]!), 'utf8')).not.toContain('AAAA');
    // The caller's own result object is untouched.
    expect(result.downloads[0]!.bytes).toBe('AAAA');
  });
});
