import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import type { Download } from '../../src/services/download-service.js';

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

  it('stores download metadata but not the inline bytes, marking stripped entries NOT_REPLAYED', async () => {
    await ledger.claim('d', 'bc_execute_action', 'd');
    const tooLarge = { fileName: 'b.pdf', contentType: 'y', sizeBytes: 9, style: 'Download', error: { code: 'TOO_LARGE', message: 'big' } };
    const result = { replaySafe: true, downloads: <Download[]>[{ fileName: 'a.xlsx', contentType: 'x', sizeBytes: 3, style: 'Download', bytes: 'AAAA', savedPath: '/tmp/a.xlsx' }, tooLarge], externalUris: [] };
    await ledger.settle('d', { status: 'completed', result });
    const stored = (await ledger.get('d'))?.result as { downloads: Array<Record<string, unknown> & { error?: { code: string; message: string } }> };
    expect(stored.downloads[0]).toMatchObject({ fileName: 'a.xlsx', contentType: 'x', sizeBytes: 3, style: 'Download', savedPath: '/tmp/a.xlsx' });
    expect(stored.downloads[0]!.bytes).toBeUndefined();
    expect(stored.downloads[0]!.error?.code).toBe('NOT_REPLAYED');
    expect(stored.downloads[0]!.error?.message).toContain('/tmp/a.xlsx');
    // An entry that already carried an error (no bytes) is stored unchanged.
    expect(stored.downloads[1]).toEqual(tooLarge);
    const files = readdirSync(join(dir, 'operations'));
    expect(await readFile(join(dir, 'operations', files[0]!), 'utf8')).not.toContain('AAAA');
    // The caller's own result object is untouched.
    expect(result.downloads[0]!.bytes).toBe('AAAA');
  });
});
