import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TargetDescriptor } from '../operations/target-descriptor.js';

/**
 * File-backed record of mutating tool calls keyed by a caller-supplied
 * operationId (Stripe idempotency-key model, epic #17). One JSON file per id
 * under `{stateDir}/operations/`, so a restarted process still knows what an
 * earlier one sent.
 *
 * - `sent`: the call started and has not returned (or the process died mid-call).
 * - `completed`: the call returned; `result` is the MCP tool result to replay.
 * - `unknown`: the call failed in a way that may have committed server-side
 *   (timeout, session loss, transport error).
 *
 * ponytail: no expiry; entries accumulate until STATE_DIR/operations is pruned by hand.
 */
export type OperationStatus = 'sent' | 'completed' | 'unknown';

export interface OperationEntry {
  operationId: string;
  tool: string;
  inputDigest: string;
  status: OperationStatus;
  result?: unknown;
  error?: { code?: string; message: string };
  /** What the call targeted, captured before it ran (survives session loss). */
  target?: TargetDescriptor;
  createdAt: string;
  updatedAt: string;
}

/** Order-independent SHA-256 of a JSON value (object keys sorted recursively). */
export function digestInput(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

export class OperationLedger {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'operations');
  }

  async get(operationId: string): Promise<OperationEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(operationId), 'utf8')) as OperationEntry;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  /**
   * Atomically claim an id as `sent`. Returns the existing entry instead when
   * the id is already taken (by this or another process), so two concurrent
   * calls with one id can never both execute.
   */
  async claim(operationId: string, tool: string, inputDigest: string, target?: TargetDescriptor): Promise<{ claimed: true } | { claimed: false; existing: OperationEntry }> {
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const entry: OperationEntry = { operationId, tool, inputDigest, status: 'sent', ...(target ? { target } : {}), createdAt: now, updatedAt: now };
    // Write the full entry to a private temp file, then publish it with link():
    // atomic create-if-absent (EEXIST when taken), so a concurrent claimer or a
    // restart after a crash never reads an empty/truncated entry.
    const path = this.pathFor(operationId);
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    try {
      await link(tmp, path);
      return { claimed: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = await this.get(operationId);
      if (!existing) throw new Error(`Operation ledger entry ${operationId} vanished during claim`);
      return { claimed: false, existing };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async settle(operationId: string, update: Pick<OperationEntry, 'status' | 'result' | 'error'>): Promise<void> {
    const current = await this.get(operationId);
    if (!current) throw new Error(`Operation ledger has no entry for ${operationId}`);
    const next: OperationEntry = { ...current, ...update, updatedAt: new Date().toISOString() };
    const path = this.pathFor(operationId);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, path);
  }

  /** Drop an entry whose call provably changed nothing, so the id can be reused. */
  async release(operationId: string): Promise<void> {
    await rm(this.pathFor(operationId), { force: true });
  }

  // Hash the id: it is caller-controlled and must never become a path segment.
  private pathFor(operationId: string): string {
    return join(this.dir, `${createHash('sha256').update(operationId).digest('hex')}.json`);
  }
}
