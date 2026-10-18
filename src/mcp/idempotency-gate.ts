import type { Logger } from '../core/logger.js';
import { digestInput, type OperationLedger } from './operation-ledger.js';
import type { DescribeTarget, TargetDescriptor } from '../operations/target-descriptor.js';

/** Failures after which the mutation may or may not have reached BC. */
const AMBIGUOUS_FAILURE_CODES = new Set(['TIMEOUT_ERROR', 'SESSION_LOST', 'CONNECTION_ERROR', 'PROTOCOL_ERROR', 'ABORTED_ERROR']);
export const isAmbiguousFailure = (code: string | undefined): boolean => code === undefined || AMBIGUOUS_FAILURE_CODES.has(code);

export interface Failure { code?: string; message: string }

/** What one run of a tool produced: its output value, or a failure. */
export interface RunOutcome { value?: unknown; failure?: Failure }

export type GateOutcome<R extends RunOutcome> =
  | { kind: 'ran'; outcome: R }
  /** `value` is the stored output of the first run. */
  | { kind: 'replayed'; value: unknown }
  | { kind: 'reused'; message: string }
  | { kind: 'inDoubt'; message: string; state: Record<string, unknown> };

/**
 * Transport-neutral operationId replay gate (epic #17, #30). A known id with
 * the same tool and input returns the stored output without touching BC; with
 * different input (or tool) it is rejected; while its outcome is unresolved it
 * is reported as in doubt. Shared by MCPHandler and the REST routes, over one
 * ledger, so an id means the same operation on both transports.
 */
export class IdempotencyGate {
  constructor(
    private readonly ledger: OperationLedger,
    private readonly logger: Logger,
    private readonly describeTarget?: DescribeTarget,
    /** Count of frames sent to BC (`wireSendCount`); without it every ambiguous failure is assumed sent. */
    private readonly sendCount?: () => number,
  ) {}

  async run<R extends RunOutcome>(tool: string, operationId: string, input: unknown, exec: () => Promise<R>): Promise<GateOutcome<R>> {
    const inputDigest = digestInput(input);
    // Snapshot the target before the call runs: session loss mid-call wipes the
    // page contexts it would otherwise be read from. Best-effort; never blocks the call.
    let target: TargetDescriptor | undefined;
    try {
      target = this.describeTarget?.(input);
    } catch (e) {
      this.logger.warn(`Could not describe ${tool} target for operationId ${operationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const claim = await this.ledger.claim(operationId, tool, inputDigest, target);
    if (!claim.claimed) {
      const ex = claim.existing;
      if (ex.tool !== tool || ex.inputDigest !== inputDigest) {
        return { kind: 'reused', message: `operationId '${operationId}' was already used for a different ${ex.tool === tool ? 'input' : `tool (${ex.tool})`}.` };
      }
      if (ex.status === 'completed') {
        this.logger.info(`Replayed ${tool} result for operationId ${operationId}`);
        return { kind: 'replayed', value: ex.result };
      }
      return {
        kind: 'inDoubt',
        message: ex.status === 'sent'
          ? `operationId '${operationId}' is still in flight, or its process died before it returned.`
          : `operationId '${operationId}' failed in a way that may have committed server-side (${ex.error?.code ?? 'unknown error'}).`,
        state: { code: 'OPERATION_IN_DOUBT', operationId, status: ex.status, replaySafe: false, createdAt: ex.createdAt, ...(ex.error ? { error: ex.error } : {}), ...(ex.target ? { target: ex.target } : {}) },
      };
    }

    const sentBefore = this.sendCount?.();
    // Nothing reached BC (e.g. "Action not found"), so nothing can have committed.
    const neverSent = (): boolean => sentBefore !== undefined && this.sendCount!() === sentBefore;
    let outcome: R;
    try {
      outcome = await exec();
    } catch (e) {
      if (neverSent()) await this.ledger.release(operationId);
      else await this.ledger.settle(operationId, { status: 'unknown', replaySafe: false, error: { message: e instanceof Error ? e.message : String(e) } });
      throw e;
    }
    const { failure } = outcome;
    if (!failure) {
      const replaySafe = (outcome.value as { replaySafe?: unknown } | null | undefined)?.replaySafe === true;
      await this.ledger.settle(operationId, { status: 'completed', replaySafe, result: outcome.value });
    } else if (isAmbiguousFailure(failure.code) && !neverSent()) {
      await this.ledger.settle(operationId, { status: 'unknown', replaySafe: false, error: { code: failure.code, message: failure.message } });
    } else {
      // BC gave a definite answer (validation, business rule, sign-in...): nothing
      // committed, so free the id for a corrected retry.
      await this.ledger.release(operationId);
    }
    return { kind: 'ran', outcome };
  }
}

/** Shared operationId/Idempotency-Key shape check; returns an error message or undefined. */
export function invalidOperationId(operationId: unknown): string | undefined {
  return typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 200
    ? 'must be a non-empty string of at most 200 characters'
    : undefined;
}
