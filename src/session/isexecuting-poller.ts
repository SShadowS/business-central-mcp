/**
 * Liveness watchdog for an in-flight invoke, driven by BC's `IsExecuting`
 * interaction (design: docs/superpowers/specs/2026-07-24-long-running-ops-design.md).
 *
 * BC answers IsExecuting out of band while another interaction is blocked
 * (decompiled `CallbackHandler.cs` handles it before `EnterProcessing`), so a
 * long-running post or report can be told apart from a hung invoke instead of
 * being killed by a fixed wall-clock timeout. Verified live 2026-07-24
 * (Gate A, `scripts/gate-a-isexecuting.ts`): concurrent answers in 1-4 ms,
 * tracking real server processing state, no sequence corruption.
 *
 * Verdicts (each emitted at most once):
 * - `wedged`: BC says it is NOT processing, twice, `confirmDelayMs` apart, yet
 *   the invoke has not returned -- the known hung-invoke BC bug. The confirming
 *   probe exists because Gate A showed IsExecuting flips to false BEFORE a large
 *   response frame is flushed; one `false` can be a completed op mid-delivery.
 * - `transport-dead`: the probe itself failed or timed out.
 * - `ceiling`: `ceilingMs` elapsed, even though BC still reports `true`.
 */

export type ProbeAnswer = 'true' | 'false' | 'error';
export type LivenessVerdict = 'wedged' | 'transport-dead' | 'ceiling';

export interface LivenessOptions {
  probe: () => Promise<ProbeAnswer>;
  pollIntervalMs: number;
  confirmDelayMs: number;
  ceilingMs: number;
  onVerdict: (verdict: LivenessVerdict) => void;
}

/** Starts watching; returns `stop`, which cancels all timers and late verdicts. */
export function watchLiveness(opts: LivenessOptions): () => void {
  if (opts.pollIntervalMs >= opts.ceilingMs) {
    throw new Error(`pollIntervalMs (${opts.pollIntervalMs}) must be below ceilingMs (${opts.ceilingMs})`);
  }
  let done = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (verdict?: LivenessVerdict) => {
    if (done) return;
    done = true;
    clearTimeout(pollTimer);
    clearTimeout(ceilingTimer);
    if (verdict) opts.onVerdict(verdict);
  };

  const tick = async (sawFalse: boolean) => {
    const answer = await opts.probe().catch((): ProbeAnswer => 'error');
    if (done) return;
    if (answer === 'error') return finish('transport-dead');
    if (answer === 'false') {
      if (sawFalse) return finish('wedged');
      pollTimer = setTimeout(() => void tick(true), opts.confirmDelayMs);
      return;
    }
    pollTimer = setTimeout(() => void tick(false), opts.pollIntervalMs);
  };

  const ceilingTimer = setTimeout(() => finish('ceiling'), opts.ceilingMs);
  pollTimer = setTimeout(() => void tick(false), opts.pollIntervalMs);
  return () => finish();
}

/**
 * Extract the `DN.IsExecutingHandler` answer from a decompressed Invoke
 * response (handler array). BC serialises it as `parameters: ["true"|"false"]`;
 * casing of the keys varies, so both are accepted.
 */
export function parseIsExecutingAnswer(response: unknown): ProbeAnswer {
  if (!Array.isArray(response)) return 'error';
  for (const h of response) {
    if (!h || typeof h !== 'object') continue;
    const o = h as Record<string, unknown>;
    if ((o['handlerType'] ?? o['HandlerType']) !== 'DN.IsExecutingHandler') continue;
    const params = (o['parameters'] ?? o['Parameters']) as unknown[] | undefined;
    const v = Array.isArray(params) ? String(params[0]).toLowerCase() : '';
    if (v === 'true' || v === 'false') return v;
  }
  return 'error';
}
