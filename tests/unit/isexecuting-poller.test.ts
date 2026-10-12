import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { watchLiveness, parseIsExecutingAnswer, type LivenessVerdict, type ProbeAnswer } from '../../src/session/isexecuting-poller.js';

const POLL = 1000;
const CONFIRM = 200;
const CEILING = 10_000;

function setup(answers: ProbeAnswer[] | (() => Promise<ProbeAnswer>)) {
  const verdicts: LivenessVerdict[] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const probe = vi.fn(
    queue ? async () => queue.shift() ?? 'true' : (answers as () => Promise<ProbeAnswer>),
  );
  const stop = watchLiveness({
    probe, pollIntervalMs: POLL, confirmDelayMs: CONFIRM, ceilingMs: CEILING,
    onVerdict: (v) => verdicts.push(v),
  });
  return { probe, verdicts, stop };
}

describe('watchLiveness', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not probe before the poll interval', async () => {
    const { probe, stop } = setup([]);
    await vi.advanceTimersByTimeAsync(POLL - 1);
    expect(probe).not.toHaveBeenCalled();
    stop();
  });

  it('keeps waiting while BC answers true', async () => {
    const { probe, verdicts, stop } = setup(['true', 'true', 'true', 'true']);
    await vi.advanceTimersByTimeAsync(POLL * 4 + 10);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(verdicts).toEqual([]);
    stop();
  });

  it('declares wedged only after a confirming second false', async () => {
    const { probe, verdicts } = setup(['false', 'false']);
    await vi.advanceTimersByTimeAsync(POLL + 10);
    expect(verdicts).toEqual([]); // a single false may be a response mid-flush
    await vi.advanceTimersByTimeAsync(CONFIRM);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(verdicts).toEqual(['wedged']);
  });

  it('a false followed by true is not wedged', async () => {
    const { verdicts, stop } = setup(['false', 'true', 'true']);
    await vi.advanceTimersByTimeAsync(POLL + CONFIRM + POLL + 10);
    expect(verdicts).toEqual([]);
    stop();
  });

  it('declares transport-dead when the probe errors', async () => {
    const { verdicts } = setup(['error']);
    await vi.advanceTimersByTimeAsync(POLL + 10);
    expect(verdicts).toEqual(['transport-dead']);
  });

  it('declares ceiling while BC is still executing', async () => {
    const { verdicts } = setup(() => Promise.resolve('true'));
    await vi.advanceTimersByTimeAsync(CEILING + 10);
    expect(verdicts).toEqual(['ceiling']);
  });

  it('emits at most one verdict', async () => {
    const { verdicts } = setup(['error', 'error', 'error']);
    await vi.advanceTimersByTimeAsync(CEILING + 10);
    expect(verdicts).toEqual(['transport-dead']);
  });

  it('stop() before any probe leaves no timers and no verdict', async () => {
    const { probe, verdicts, stop } = setup([]);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CEILING + 10);
    expect(probe).not.toHaveBeenCalled();
    expect(verdicts).toEqual([]);
  });

  it('a probe resolving after stop() produces no verdict', async () => {
    let resolveProbe!: (a: ProbeAnswer) => void;
    const { verdicts, stop } = setup(() => new Promise<ProbeAnswer>((r) => { resolveProbe = r; }));
    await vi.advanceTimersByTimeAsync(POLL + 10);
    stop();
    resolveProbe('error');
    await vi.advanceTimersByTimeAsync(CEILING);
    expect(verdicts).toEqual([]);
  });

  it('rejects a poll interval at or above the ceiling', () => {
    expect(() => watchLiveness({
      probe: async () => 'true', pollIntervalMs: CEILING, confirmDelayMs: CONFIRM, ceilingMs: CEILING,
      onVerdict: () => {},
    })).toThrow(/pollIntervalMs/);
  });
});

describe('parseIsExecutingAnswer', () => {
  it('reads every answer in the live Gate A capture', () => {
    const capture = JSON.parse(readFileSync(
      new URL('../../src/protocol/captures/isexecuting-concurrent-2026-07-24.json', import.meta.url), 'utf8',
    )) as Array<{ result: unknown }>;
    const answers = capture.map((c) => parseIsExecutingAnswer(c.result));
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) expect(['true', 'false']).toContain(a);
    expect(answers).toContain('true');
  });

  it('accepts PascalCase keys', () => {
    expect(parseIsExecutingAnswer([{ HandlerType: 'DN.IsExecutingHandler', Parameters: ['false'] }])).toBe('false');
  });

  it('returns error when no IsExecuting handler is present', () => {
    expect(parseIsExecutingAnswer([{ handlerType: 'DN.CallbackResponseProperties', parameters: [] }])).toBe('error');
    expect(parseIsExecutingAnswer(null)).toBe('error');
  });
});
