import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { TargetDescriptor } from '../operations/target-descriptor.js';

/**
 * File-backed record of mutating tool calls keyed by a caller-supplied
 * operationId (Stripe idempotency-key model, epic #17). One JSON file per id
 * under `{stateDir}/operations/`, so a restarted process still knows what an
 * earlier one sent.
 *
 * - `sent`: the call started and has not returned (or the process died mid-call).
 * - `completed`: the call returned; `result` is the tool's output value to replay
 *   (each transport renders it the way it rendered the first response).
 * - `unknown`: the call failed in a way that may have committed server-side
 *   (timeout, session loss, transport error).
 *
 * Retention (#29): `prune()` deletes `completed` entries older than
 * `completedTtlMs` (so replay is time-limited), `sent`/`unknown` entries older
 * than `inDoubtTtlMs` (long: these are the ones someone must investigate, and a
 * young `sent` entry is an in-flight call), and orphaned `*.tmp` files.
 */
export type OperationStatus = 'sent' | 'completed' | 'unknown';

export interface OperationEntry {
  operationId: string;
  tool: string;
  inputDigest: string;
  status: OperationStatus;
  result?: unknown;
  error?: { code?: string; message: string };
  /**
   * Set when settled: true only when the tool proved from BC's response that
   * re-running the same call cannot double-apply (see src/protocol/replay-safety.ts).
   * Always false for `unknown`.
   */
  replaySafe?: boolean;
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

export interface LedgerRetention {
  /** Age (from updatedAt) after which a `completed` entry is deleted and its id runs fresh again. */
  completedTtlMs: number;
  /** Age (from updatedAt) after which a `sent`/`unknown` entry is deleted. */
  inDoubtTtlMs: number;
}

export const DEFAULT_RETENTION: LedgerRetention = { completedTtlMs: 24 * 3_600_000, inDoubtTtlMs: 30 * 24 * 3_600_000 };
/** A temp file older than this was left by a process killed mid-write. */
const ORPHAN_TMP_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 3_600_000;

/**
 * Drop inline download bytes before storing a result: a replay returns the file
 * metadata (and savedPath when BC_DOWNLOAD_DIR is set), not megabytes of base64.
 * Each stripped entry gets a `NOT_REPLAYED` error so a replay never looks like a
 * successful capture (Download contract: bytes on every success, error otherwise).
 */
function stripDownloadBytes(result: unknown): unknown {
  const downloads = (result as { downloads?: unknown } | null | undefined)?.downloads;
  if (!Array.isArray(downloads)) return result;
  return {
    ...(result as object),
    downloads: downloads.map(d => {
      const { bytes, ...meta } = d as { bytes?: unknown; savedPath?: string };
      if (bytes === undefined) return meta;
      const where = meta.savedPath ? `the file was saved to ${meta.savedPath}` : 'the file was delivered only in the original response';
      return { ...meta, error: { code: 'NOT_REPLAYED', message: `Download bytes are not replayed from the operation ledger; ${where}. Re-run the action with a new operationId to fetch it again.` } };
    }),
  };
}

export class OperationLedger {
  private readonly dir: string;

  constructor(stateDir: string, private readonly retention: LedgerRetention = DEFAULT_RETENTION) {
    this.dir = join(stateDir, 'operations');
  }

  /**
   * Delete expired entries and orphaned temp files; returns how many files were
   * removed. Safe while other processes share the directory: every delete is
   * `force`, and a deleted `completed` entry only means the next call with that
   * id runs fresh (the TTL case).
   */
  async prune(now = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    let removed = 0;
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        let expired = false;
        if (name.endsWith('.tmp')) {
          expired = now - (await stat(path)).mtimeMs > ORPHAN_TMP_MS;
        } else if (name.endsWith('.json')) {
          const entry = JSON.parse(await readFile(path, 'utf8')) as OperationEntry;
          const ttl = entry.status === 'completed' ? this.retention.completedTtlMs : this.retention.inDoubtTtlMs;
          expired = now - Date.parse(entry.updatedAt) > ttl;
        }
        if (expired) {
          await rm(path, { force: true });
          removed++;
        }
      } catch (e) {
        // Vanished under a concurrent prune/settle, or unreadable: leave it.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      }
    }
    return removed;
  }

  /** Prune now and then hourly, on a timer that never keeps the process alive. */
  startPruning(logger: Pick<Logger, 'info' | 'warn'>): void {
    const run = (): void => {
      this.prune().then(
        n => { if (n > 0) logger.info(`Operation ledger: pruned ${n} expired file(s)`); },
        e => logger.warn(`Operation ledger prune failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    };
    run();
    setInterval(run, PRUNE_INTERVAL_MS).unref();
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

  async settle(operationId: string, update: Pick<OperationEntry, 'status' | 'result' | 'error' | 'replaySafe'>): Promise<void> {
    const current = await this.get(operationId);
    if (!current) throw new Error(`Operation ledger has no entry for ${operationId}`);
    const next: OperationEntry = { ...current, ...update, result: stripDownloadBytes(update.result), updatedAt: new Date().toISOString() };
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
