// tests/unit/bc-session-modal-tracking.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { BCEvent } from '../../src/protocol/types.js';
import { BCSession } from '../../src/session/bc-session.js';
import { ok } from '../../src/core/result.js';

class TrackingProbe extends (BCSession as any) {
  constructor() {
    super(
      {
        isConnected: true,
        sendRpc: async () => ({ ok: true, value: [] }),
        close: () => {},
        onMessage: () => () => {},
        spaInstanceId: '',
        nextSequenceNo: 1,
        lastClientAckSequenceNumber: 0,
      },
      { decode: () => [] },
      { encode: () => ({ method: '', params: [] }), encodeOpenSession: () => ({ method: '', params: [] }) },
      { info() {}, debug() {}, warn() {}, error() {} },
      'default',
      30000,
    );
  }
  feed(events: BCEvent[]): BCEvent[] {
    return (this as any).updateFormTracking(events);
  }
  stack(): string[] {
    return this.modalStackSnapshot();
  }
  open(): string[] {
    return Array.from(this.openFormIds);
  }
}

/** How BC reports a closed form: State=0 on its server: path (LogicalFormObserver). */
const closed = (formId: string, extra: Record<string, unknown> = {}): BCEvent =>
  ({ type: 'PropertyChanged', formId, controlPath: 'server:', changes: { State: 0, ...extra } });

describe('BCSession modal-stack tracking', () => {
  it('DialogOpened pushes to stack and openFormIds', () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    expect(s.stack()).toEqual(['M1']);
    expect(s.open()).toContain('M1');
  });

  it('State=0 on server: pops stack, removes from openFormIds and emits FormClosed after it', () => {
    const s = new TrackingProbe();
    const out = s.feed([
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M2', controlTree: {} },
      closed('M2'),
    ]);
    expect(s.stack()).toEqual(['M1']);
    expect(s.open()).not.toContain('M2');
    expect(out.map(e => e.type)).toEqual(['DialogOpened', 'DialogOpened', 'PropertyChanged', 'FormClosed']);
    expect(out[3]).toEqual({ type: 'FormClosed', formId: 'M2' });
  });

  it('State other than 0, or not on server:, is not a close', () => {
    const s = new TrackingProbe();
    const out = s.feed([
      { type: 'FormCreated', formId: 'F1', controlTree: {} },
      { type: 'PropertyChanged', formId: 'F1', controlPath: 'server:', changes: { State: 2 } },
      { type: 'PropertyChanged', formId: 'F1', controlPath: 'server:c[1]', changes: { State: 0 } },
    ]);
    expect(s.open()).toContain('F1');
    expect(out.some(e => e.type === 'FormClosed')).toBe(false);
  });

  it("a hosted part's State=0 on the host's server: path does not close the host", () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'FormCreated', formId: 'H', controlTree: { t: 'lf', ServerFormHandle: 'host-handle', Metadata: { sourceTableId: 18 } } }]);
    const out = s.feed([closed('H', { ServerFormHandle: 'part-handle' })]);
    expect(s.open()).toContain('H');
    expect(out.some(e => e.type === 'FormClosed')).toBe(false);
    s.feed([closed('H', { ServerFormHandle: 'host-handle' })]);
    expect(s.open()).not.toContain('H');
  });

  it('a close of an untracked or already-closed form emits no FormClosed', () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'FormCreated', formId: 'F1', controlTree: {} }]);
    const out = s.feed([closed('F1'), closed('F1'), closed('GHOST')]);
    expect(out.filter(e => e.type === 'FormClosed')).toEqual([{ type: 'FormClosed', formId: 'F1' }]);
  });

  it('FormCreated does not affect modal stack', () => {
    const s = new TrackingProbe();
    s.feed([
      { type: 'FormCreated', formId: 'F1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
    ]);
    expect(s.stack()).toEqual(['M1']);
    expect(s.open()).toEqual(expect.arrayContaining(['F1', 'M1']));
  });

  it('removeOpenForm clears both openFormIds and modalStack', () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    expect(s.stack()).toEqual(['M1']);
    (s as any).removeOpenForm('M1');
    expect(s.stack()).toEqual([]);
    expect(s.open()).not.toContain('M1');
  });
});

class ReconcileProbe extends (BCSession as any) {
  public sentInteractions: any[] = [];
  constructor() {
    super(
      {
        isConnected: true,
        sendRpc: async () => ({ ok: true, value: [] }),
        close: () => {},
        onMessage: () => () => {},
        spaInstanceId: '',
        nextSequenceNo: 1,
        lastClientAckSequenceNumber: 0,
      },
      { decode: () => [] },
      {
        encode: (interaction: any) => {
          this.sentInteractions.push(interaction);
          return { method: '', params: [] };
        },
        encodeOpenSession: () => ({ method: '', params: [] }),
      },
      { info() {}, debug() {}, warn() {}, error() {} },
      'default',
      30000,
    );
    (this as any)._initialized = true;
  }
  feed(events: any[]): void {
    (this as any).updateFormTracking(events);
  }
  stack(): string[] {
    return this.modalStackSnapshot();
  }
  reconcile(): Promise<any> {
    return (this as any).reconcileModalStack();
  }
}

describe('BCSession.reconcileModalStack', () => {
  it('aborts topmost first, then next-down, popping stack each time', async () => {
    const s = new ReconcileProbe();
    s.feed([
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M2', controlTree: {} },
    ]);
    expect(s.stack()).toEqual(['M1', 'M2']);

    // Stub invokeUnqueued -- simulate BC closing the modal we just aborted.
    // reconcileModalStack uses invokeUnqueued (queue-bypassing) because it
    // runs inside an already-enqueued task.
    (s as any).invokeUnqueued = vi.fn(async (interaction: any) => {
      s.feed([closed(interaction.formId)]);
      return ok([]);
    });

    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);

    const calls = (s as any).invokeUnqueued.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.formId)).toEqual(['M2', 'M1']);
    expect(calls.every((c: any) => c.systemAction === 320)).toBe(true);
  });

  it('returns error if Abort itself fails', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invokeUnqueued = vi.fn(async () => ({ ok: false, error: { message: 'BOOM' } }));
    const result = await s.reconcile();
    expect(result.ok).toBe(false);
  });

  it('force-pops if BC does NOT emit FormClosed for the aborted modal', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invokeUnqueued = vi.fn(async () => ok([])); // Abort succeeds but BC doesn't close
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]); // force-popped
  });

  it('returns ok with empty stack', async () => {
    const s = new ReconcileProbe();
    (s as any).invokeUnqueued = vi.fn();
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect((s as any).invokeUnqueued).not.toHaveBeenCalled();
  });
});

describe('BCSession invoke with auto-recovery', () => {
  it('retries once after reconcileModalStack on LogicalModalityViolation', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    let callCount = 0;
    (s as any).ws.sendRpc = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, error: { message: 'LogicalModalityViolationException: There is a dialog open' } };
      }
      return { ok: true, value: [] };
    });

    (s as any).reconcileModalStack = vi.fn(async () => {
      s.feed([closed('M1')]);
      return ok(undefined);
    });

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    expect((s as any).reconcileModalStack).toHaveBeenCalledTimes(1);
  });

  it('marks session dead and returns ModalReconcileError when retry fails again', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'LogicalModalityViolationException: persistent' },
    }));
    (s as any).reconcileModalStack = vi.fn(async () => ok(undefined));

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('ModalReconcileError');
    }
    expect((s as any).dead).toBe(true);
  });

  it('marks session dead with ModalReconcileError when reconciliation itself fails', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'LogicalModalityViolationException: stuck' },
    }));
    (s as any).reconcileModalStack = vi.fn(async () => ({ ok: false, error: { message: 'Abort failed' } }));

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('ModalReconcileError');
    }
    expect((s as any).dead).toBe(true);
  });

  it('non-modal-violation errors continue to bubble unchanged', async () => {
    const s = new ReconcileProbe();
    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'SomeOtherError: random' },
    }));
    (s as any).reconcileModalStack = vi.fn();

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(false);
    expect((s as any).reconcileModalStack).not.toHaveBeenCalled();
  });
});

describe('BCSession invoke + reconcile end-to-end (no stubs)', () => {
  it('completes recovery without deadlocking when reconcileModalStack runs for real', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    let sendCount = 0;
    (s as any).ws.sendRpc = vi.fn(async (_method: string, _params: unknown[]) => {
      sendCount += 1;
      if (sendCount === 1) {
        // First send: original interaction hits modal violation
        return { ok: false, error: { message: 'LogicalModalityViolationException: stale dialog' } };
      }
      if (sendCount === 2) {
        // Second send: the Abort from reconcileModalStack succeeds and BC
        // reports M1 closed (decoder injects State=0 -- see below).
        return { ok: true, value: [] };
      }
      // Third send: the retry of the original interaction.
      return { ok: true, value: [] };
    });

    // Decoder fakes M1's State=0 ONLY on the second sendRpc (the Abort
    // response) so reconcileModalStack pops M1. The first call doesn't reach
    // decode (sendRpc errored), and the third call doesn't need any events.
    (s as any).decoder.decode = vi.fn((_data: unknown) => {
      const decoded: any[] = [];
      if (sendCount === 2) {
        decoded.push(closed('M1'));
      }
      return decoded;
    });

    // Race the real invoke path against a 5s deadlock-detector. If the
    // promise queue self-deadlocks, the race rejects.
    const result = await Promise.race([
      s.invoke(
        { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
        () => true,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DEADLOCK: invoke did not complete within 5s')), 5000),
      ),
    ]);

    expect(result.ok).toBe(true);
    expect(sendCount).toBe(3); // original violation + abort + retry
    expect(s.stack()).toEqual([]);
  }, 10000);
});
