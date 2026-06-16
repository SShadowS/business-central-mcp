// tests/unit/role-center-hydration.test.ts
//
// Unit tests for RoleCenterHydrationStrategy.
//
// Verified invoke sequence (from role-center-hydration.ts):
//   InvokeAction { type:'InvokeAction', formId:childFormId,
//                  controlPath:'server:', systemAction:30 }
//   -- wait for InvokeCompleted | PropertyChanged
//   If ok: repo.applyToPage(pageContextId, events)
//
// The strategy does NOT read anything from the repo before the invoke —
// it only calls repo.applyToPage() with the returned events.

import { describe, it, expect, vi } from 'vitest';
import { RoleCenterHydrationStrategy } from '../../src/services/strategies/role-center-hydration.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok, err } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeSession(returnEvents: BCEvent[] = []) {
  return {
    invoke: vi.fn(async () => ok(returnEvents)),
  };
}

function makeRepo(): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create('pc:rc', 'rc-root', { isModal: false, wizardState: null });
  return repo;
}

// ── invoke shape ────────────────────────────────────────────────────────────────

describe('RoleCenterHydrationStrategy — invoke shape', () => {
  it('calls session.invoke exactly once', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-1');

    expect(session.invoke).toHaveBeenCalledTimes(1);
  });

  it('sends InvokeAction type', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-2');

    const interaction = session.invoke.mock.calls[0]![0];
    expect(interaction.type).toBe('InvokeAction');
  });

  it('targets the supplied childFormId', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'cue-card-abc');

    const interaction = session.invoke.mock.calls[0]![0];
    expect(interaction.formId).toBe('cue-card-abc');
  });

  it('uses controlPath "server:" (form root)', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-3');

    const interaction = session.invoke.mock.calls[0]![0];
    expect(interaction.controlPath).toBe('server:');
  });

  it('sends systemAction 30 (Refresh)', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-4');

    const interaction = session.invoke.mock.calls[0]![0];
    expect(interaction.systemAction).toBe(30);
  });
});

// ── event predicate ─────────────────────────────────────────────────────────────

describe('RoleCenterHydrationStrategy — event predicate', () => {
  it('predicate accepts InvokeCompleted', async () => {
    let capturedPredicate: ((e: any) => boolean) | undefined;
    const session = {
      invoke: vi.fn(async (_int: any, pred: (e: any) => boolean) => {
        capturedPredicate = pred;
        return ok([] as BCEvent[]);
      }),
    };
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-pred');

    expect(capturedPredicate).toBeDefined();
    expect(capturedPredicate!({ type: 'InvokeCompleted' })).toBe(true);
  });

  it('predicate accepts PropertyChanged', async () => {
    let capturedPredicate: ((e: any) => boolean) | undefined;
    const session = {
      invoke: vi.fn(async (_int: any, pred: (e: any) => boolean) => {
        capturedPredicate = pred;
        return ok([] as BCEvent[]);
      }),
    };
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-prop');

    expect(capturedPredicate!({ type: 'PropertyChanged' })).toBe(true);
  });

  it('predicate rejects DataLoaded and other event types', async () => {
    let capturedPredicate: ((e: any) => boolean) | undefined;
    const session = {
      invoke: vi.fn(async (_int: any, pred: (e: any) => boolean) => {
        capturedPredicate = pred;
        return ok([] as BCEvent[]);
      }),
    };
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'child-form-reject');

    expect(capturedPredicate!({ type: 'DataLoaded' })).toBe(false);
    expect(capturedPredicate!({ type: 'FormCreated' })).toBe(false);
    expect(capturedPredicate!({ type: 'DialogOpened' })).toBe(false);
  });
});

// ── repo.applyToPage ────────────────────────────────────────────────────────────

describe('RoleCenterHydrationStrategy — repo.applyToPage', () => {
  it('calls repo.applyToPage with the returned events on success', async () => {
    const returnedEvents: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'child-form-5', controlPath: 'server:c[0]', changes: { StringValue: '7' } } as BCEvent,
    ];
    const session = makeSession(returnedEvents);
    const repo = makeRepo();
    const applyToPage = vi.spyOn(repo, 'applyToPage');

    const strategy = new RoleCenterHydrationStrategy(session as any, repo);
    await strategy.hydrate('pc:rc', 'child-form-5');

    expect(applyToPage).toHaveBeenCalledTimes(1);
    expect(applyToPage).toHaveBeenCalledWith('pc:rc', returnedEvents);
  });

  it('passes the correct pageContextId (not the childFormId) to applyToPage', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const applyToPage = vi.spyOn(repo, 'applyToPage');

    const strategy = new RoleCenterHydrationStrategy(session as any, repo);
    await strategy.hydrate('pc:rc', 'some-child-form');

    const [calledPcId] = applyToPage.mock.calls[0]!;
    expect(calledPcId).toBe('pc:rc');
    expect(calledPcId).not.toBe('some-child-form');
  });

  it('does not call repo.applyToPage when invoke returns err()', async () => {
    const session = {
      invoke: vi.fn(async () => err(new Error('BC unavailable'))),
    };
    const repo = makeRepo();
    const applyToPage = vi.spyOn(repo, 'applyToPage');

    const strategy = new RoleCenterHydrationStrategy(session as any, repo);
    await strategy.hydrate('pc:rc', 'child-form-err');

    expect(applyToPage).not.toHaveBeenCalled();
  });
});

// ── error resilience ────────────────────────────────────────────────────────────

describe('RoleCenterHydrationStrategy — error resilience', () => {
  it('does not throw when invoke returns err()', async () => {
    const session = {
      invoke: vi.fn(async () => err(new Error('session dead'))),
    };
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await expect(strategy.hydrate('pc:rc', 'child-err')).resolves.toBeUndefined();
  });

  it('accepts any childFormId string (does not validate against repo)', async () => {
    // The strategy doesn't validate childFormId against the repo — it just
    // passes it as formId. Confirm it does not throw for an unknown form.
    const session = makeSession();
    const repo = new PageContextRepository(); // empty — pcId also unknown
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    // Even with an unknown pcId the invoke still fires; applyToPage is a no-op on unknown pcId.
    await expect(strategy.hydrate('unknown-pc', 'unknown-child')).resolves.toBeUndefined();
    expect(session.invoke).toHaveBeenCalledTimes(1);
  });
});

// ── different childFormIds ──────────────────────────────────────────────────────

describe('RoleCenterHydrationStrategy — different callers', () => {
  it('hydrate can be called multiple times with different childFormIds', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const strategy = new RoleCenterHydrationStrategy(session as any, repo);

    await strategy.hydrate('pc:rc', 'cf-1');
    await strategy.hydrate('pc:rc', 'cf-2');
    await strategy.hydrate('pc:rc', 'cf-3');

    expect(session.invoke).toHaveBeenCalledTimes(3);
    const formIds = session.invoke.mock.calls.map((c: any) => c[0].formId);
    expect(formIds).toEqual(['cf-1', 'cf-2', 'cf-3']);
  });
});
