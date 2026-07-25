# Multi-Row Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `bc_execute_action` act on multiple selected rows (batch delete, multi-post, apply-entries) by sending BC a full selection set instead of a single row, with the selection and action delivered atomically.

**Architecture:** `SetCurrentRowInteraction` gains an optional `rowsToSelect[]`; the encoder emits the set (single-row stays byte-identical). `NavigationService.selectRows` sends the set with the anchor as `rowsToSelect[0]`. `bc_execute_action` gains a `bookmarks[]` input; when present it resolves a selection descriptor, and `ActionService` sends the selection + the action as ONE queue entry via a new `BCSession.invokeSequence`, so a concurrent operation cannot interleave. A stale anchor bookmark (BC throws `InvalidBookmarkException`) maps to a typed `InvalidBookmarkError`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest, live BC28 integration (Cronus28/Cronus281).

## Global Constraints

- ESM project — every relative import ends in `.js`. Verified by `npx tsc --noEmit`.
- Windows dev host — Git-bash with Windows paths; never `2>nul`; no emojis in source.
- Run `npx tsc --noEmit` after every task; run `npx vitest run` (unit + protocol) before every commit.
- No stubs/mocks/skeletons in shipped code.
- Breaking output-shape changes allowed (pre-release). This feature adds only an input field and internal behavior; no output DTO changes.
- Stage ONLY the files a task changes, BY PATH. NEVER `git add -A` / `git add .` / `git add -u`.
- **Anchor invariant (load-bearing):** the current-row anchor sent to BC MUST be a member of `rowsToSelect`. `NavigationService.selectRows` sets the anchor to `bookmarks[0]`, so it holds by construction; a defensive assert guards misuse. Reason: `DeleteAction.InvokeCore` ignores the selection and deletes only the current row when the current row is NOT in `SelectedRows` (decompiled `DeleteAction.cs`).
- **Anchor-vs-non-anchor bookmark semantics (verified from decompiled source):** the anchor bookmark is validated by `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.Initialize` and throws `InvalidBookmarkException` if it is not in BC's loaded rows. Non-anchor bookmarks (`SelectRowsInteraction.UpdateSelectionOnDefaultViewPort`) are matched only against `LoadedRows` and silently skipped if absent. Loaded rows != visible viewport.
- **`BC_MAX_SELECTION`** env var, default 100 — max bookmarks per call.
- `selectAll: true` is OUT OF SCOPE (decompiled `DeleteAction.cs` shows it drives a different, much larger paged-deletion path).

---

## File Structure

```
edit  src/core/config.ts                       BC_MAX_SELECTION on BCConfig
edit  src/protocol/types.ts                     rowsToSelect? on SetCurrentRowInteraction
edit  src/protocol/interaction-encoder.ts       emit rowsToSelect ?? [key]
edit  src/core/errors.ts                         InvalidBookmarkError (INVALID_BOOKMARK) + hint
edit  src/session/rpc-error-classifier.ts        isInvalidBookmarkError(message) pure helper
edit  src/session/bc-session.ts                  invokeSequence(interactions[], expect)
edit  src/services/navigation-service.ts         selectRows + selectRow delegate + anchor assert + InvalidBookmark mapping
edit  src/services/action-service.ts             optional selection descriptor on executeAction (invokeSequence path)
edit  src/operations/execute-action.ts           bookmarks[] input, validation, resolve selection descriptor
edit  src/mcp/schemas.ts                         ExecuteActionSchema: bookmarks[] + refinement
edit  src/operations/execute-action.tool.ts      description + input_examples
edit  CLAUDE.md                                  Row-Targeting Actions section: multi-row form
new   tests/unit/multi-row-encoder.test.ts
new   tests/unit/invalid-bookmark-classifier.test.ts
new   tests/unit/invoke-sequence.test.ts
new   tests/unit/select-rows.test.ts
new   tests/unit/execute-action-bookmarks.test.ts
new   tests/integration/multi-row-selection.test.ts
```

---

### Task 1: Config — BC_MAX_SELECTION

**Files:**
- Modify: `src/core/config.ts` (add to `BCConfig` interface ~`:3-21` and the `bc:` literal in `loadConfig` ~`:83-107`)
- Test: `tests/unit/config.test.ts` (append)

**Interfaces:**
- Produces: `BCConfig.maxSelection: number`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/config.test.ts`:

```typescript
describe('max selection', () => {
  const KEYS = ['BC_MAX_SELECTION', 'BC_BASE_URL'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); KEYS.forEach(k => delete process.env[k]); });
  afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('defaults BC_MAX_SELECTION to 100', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    expect(loadConfig().bc.maxSelection).toBe(100);
  });
  it('reads BC_MAX_SELECTION from env', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_MAX_SELECTION = '25';
    expect(loadConfig().bc.maxSelection).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts -t "max selection"`
Expected: FAIL — `maxSelection` undefined.

- [ ] **Step 3: Implement**

In `src/core/config.ts` add to the `BCConfig` interface (after `downloadLimits`):

```typescript
  /** Max bookmarks accepted in one multi-row selection (bc_execute_action bookmarks[]). */
  maxSelection: number;
```

In `loadConfig`'s `bc:` object literal (after the `downloadLimits` block):

```typescript
      maxSelection: optionalEnvInt('BC_MAX_SELECTION', 100),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts -t "max selection"`
Expected: PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/unit/config.test.ts
git commit -m "feat(config): BC_MAX_SELECTION for multi-row selection"
```

---

### Task 2: Protocol type + encoder — rowsToSelect

**Files:**
- Modify: `src/protocol/types.ts` (`SetCurrentRowInteraction` at `:252-257`)
- Modify: `src/protocol/interaction-encoder.ts` (`case 'SetCurrentRow'` at `:180-181`)
- Test: `tests/unit/multi-row-encoder.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface SetCurrentRowInteraction {
    readonly type: 'SetCurrentRow';
    readonly formId: string;
    readonly controlPath: string;
    readonly key: string;               // anchor / current row; MUST be a member of rowsToSelect
    readonly rowsToSelect?: string[];   // defaults to [key]
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/multi-row-encoder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import type { SetCurrentRowInteraction, EncodeContext } from '../../src/protocol/types.js';

const ctx: EncodeContext = {
  callbackId: 'cb1', sequenceNo: 'spa#1', lastClientAckSequenceNumber: -1,
  openFormIds: new Set(['f1']),
  session: { sessionId: 's', sessionKey: 'k', company: 'c', tenantId: 't', spaInstanceId: 'spa' },
};

function invocationOf(enc: ReturnType<InteractionEncoder['encode']>) {
  return (enc.params[0] as { interactionsToInvoke: Array<{ interactionName: string; namedParameters: string }> }).interactionsToInvoke[0];
}

describe('SetCurrentRow encoding', () => {
  const encoder = new InteractionEncoder('28.0.0.0');

  it('single-row (no rowsToSelect) is byte-identical to the legacy payload', () => {
    const i: SetCurrentRowInteraction = { type: 'SetCurrentRow', formId: 'f1', controlPath: 'server:c[0]', key: 'BK1' };
    const inv = invocationOf(encoder.encode(i, ctx));
    expect(inv.interactionName).toBe('SetCurrentRowAndRowsSelection');
    expect(JSON.parse(inv.namedParameters)).toEqual({ key: 'BK1', selectAll: false, rowsToSelect: ['BK1'], unselectAll: true, rowsToUnselect: [] });
  });

  it('multi-row emits the full RowsToSelect set with key as anchor', () => {
    const i: SetCurrentRowInteraction = { type: 'SetCurrentRow', formId: 'f1', controlPath: 'server:c[0]', key: 'A', rowsToSelect: ['A', 'B', 'C'] };
    const inv = invocationOf(encoder.encode(i, ctx));
    expect(JSON.parse(inv.namedParameters)).toEqual({ key: 'A', selectAll: false, rowsToSelect: ['A', 'B', 'C'], unselectAll: true, rowsToUnselect: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/multi-row-encoder.test.ts`
Expected: FAIL — TypeScript error (rowsToSelect not on the type) and/or the multi-row assertion fails.

- [ ] **Step 3: Implement**

In `src/protocol/types.ts`, `SetCurrentRowInteraction` — add the field:

```typescript
export interface SetCurrentRowInteraction extends BaseInteraction {
  readonly type: 'SetCurrentRow';
  readonly formId: string;
  readonly controlPath: string;
  readonly key: string;
  /** Full selection set. Defaults to [key]. key MUST be a member. */
  readonly rowsToSelect?: string[];
}
```

In `src/protocol/interaction-encoder.ts`, `case 'SetCurrentRow'` — emit the set:

```typescript
      case 'SetCurrentRow':
        return { interactionName: 'SetCurrentRowAndRowsSelection', formId: interaction.formId, controlPath: interaction.controlPath, namedParameters: JSON.stringify({ key: interaction.key, selectAll: false, rowsToSelect: interaction.rowsToSelect ?? [interaction.key], unselectAll: true, rowsToUnselect: [] }), callbackId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/multi-row-encoder.test.ts`
Expected: PASS (2 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/types.ts src/protocol/interaction-encoder.ts tests/unit/multi-row-encoder.test.ts
git commit -m "feat(protocol): rowsToSelect on SetCurrentRow; encoder emits the set"
```

---

### Task 3: InvalidBookmarkError + classifier

**Files:**
- Modify: `src/core/errors.ts` (add class + hint near `StaleContextError` `:122-144`)
- Modify: `src/session/rpc-error-classifier.ts` (add pure helper)
- Test: `tests/unit/invalid-bookmark-classifier.test.ts`

**Interfaces:**
- Produces:
  - `class InvalidBookmarkError extends BCError` with `code === 'INVALID_BOOKMARK'`
  - `isInvalidBookmarkError(message: string): boolean` in rpc-error-classifier

- [ ] **Step 1: Write the failing test**

Create `tests/unit/invalid-bookmark-classifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isInvalidBookmarkError } from '../../src/session/rpc-error-classifier.js';
import { InvalidBookmarkError, errorHint } from '../../src/core/errors.js';

describe('isInvalidBookmarkError', () => {
  it('matches a BC InvalidBookmarkException message', () => {
    expect(isInvalidBookmarkError('...Microsoft.Dynamics...InvalidBookmarkException: bad bookmark')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isInvalidBookmarkError('LogicalModalityViolationException')).toBe(false);
    expect(isInvalidBookmarkError('some other error')).toBe(false);
  });
});

describe('InvalidBookmarkError', () => {
  it('carries code INVALID_BOOKMARK and re-read guidance', () => {
    const e = new InvalidBookmarkError('BK9');
    expect(e.code).toBe('INVALID_BOOKMARK');
    expect(e.message).toMatch(/loaded|re-read/i);
    expect(errorHint('INVALID_BOOKMARK')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/invalid-bookmark-classifier.test.ts`
Expected: FAIL — neither symbol exists.

- [ ] **Step 3: Implement**

In `src/session/rpc-error-classifier.ts`, add:

```typescript
/**
 * True when an RPC error message is BC's InvalidBookmarkException — the anchor
 * bookmark passed to SetCurrentRowAndRowsSelection is not in BC's loaded rows.
 * Pure; unit-tested without session state.
 */
export function isInvalidBookmarkError(message: string): boolean {
  return message.includes('InvalidBookmarkException');
}
```

In `src/core/errors.ts`, after `StaleContextError` (before the `ERROR_HINTS` const):

```typescript
export class InvalidBookmarkError extends BCError {
  public readonly bookmark: string;
  constructor(bookmark: string, context?: Record<string, unknown>) {
    super(
      `Bookmark "${bookmark}" is no longer in BC's loaded rows. Re-read the section with bc_read_data to get current bookmarks, then retry.`,
      'INVALID_BOOKMARK',
      context,
    );
    this.bookmark = bookmark;
  }
}
```

Add to the `ERROR_HINTS` record:

```typescript
  INVALID_BOOKMARK: 'The anchor bookmark is no longer loaded in BC. Re-read the section with bc_read_data and retry with a current bookmark.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/invalid-bookmark-classifier.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts src/session/rpc-error-classifier.ts tests/unit/invalid-bookmark-classifier.test.ts
git commit -m "feat(errors): InvalidBookmarkError + isInvalidBookmarkError classifier"
```

---

### Task 4: BCSession.invokeSequence

**Files:**
- Modify: `src/session/bc-session.ts` (add public method near `invoke` `:143-166`)
- Test: `tests/unit/invoke-sequence.test.ts`

**Interfaces:**
- Consumes: the existing private `invokeUnqueued`, `enqueue`, `withTimeout`.
- Produces:
  ```typescript
  // Sends several interactions in ONE queue entry, in order; merges all their
  // events; aborts on the first error. Atomic against other operations.
  invokeSequence(interactions: BCInteraction[], expect: EventPredicate, timeoutMs?: number): Promise<Result<BCEvent[], ProtocolError>>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/invoke-sequence.test.ts`. This drives a real `BCSession` with a fake `BCWebSocket` so we can assert order + single-queue-entry atomicity:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import type { BCInteraction } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

// Minimal fake WS: records sendRpc order, resolves each with an InvokeCompleted-shaped payload.
function fakeWs(sendOrder: string[]) {
  let seq = 0;
  return {
    nextSequenceNo: 'spa#1',
    lastClientAckSequenceNumber: -1,
    spaInstanceId: 'spa',
    isConnected: true,
    onMessage: () => () => {},
    setRequestHandler: undefined,
    async sendRpc(_method: string, params: unknown[]) {
      const inv = (params[0] as { interactionsToInvoke: Array<{ interactionName: string }> }).interactionsToInvoke[0];
      sendOrder.push(inv.interactionName);
      // Return a decoded-friendly empty array (EventDecoder yields [] -> we push a synthetic InvokeCompleted below).
      return ok([{ handlerType: 'DN.CallbackResponseProperties', parameters: [{ CompletedInteractions: [{ CallbackId: 'x' }] }] }]);
    },
    closeWs: () => {},
  } as never;
}

describe('BCSession.invokeSequence', () => {
  it('sends interactions in order within a single queue entry and merges events', async () => {
    const order: string[] = [];
    const session = new BCSession(fakeWs(order), new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger, 'default');
    // set credentials so encode does not throw
    (session as unknown as { sessionId: string }).sessionId = 's';
    (session as unknown as { sessionKey: string }).sessionKey = 'k';
    (session as unknown as { company: string }).company = 'c';
    (session as unknown as { _initialized: boolean })._initialized = true;

    const a: BCInteraction = { type: 'SetCurrentRow', formId: 'f', controlPath: 'p', key: 'A', rowsToSelect: ['A', 'B'] };
    const b: BCInteraction = { type: 'InvokeAction', formId: 'f', controlPath: 'p/cr/c[0]', systemAction: 20 };
    const res = await session.invokeSequence([a, b], (e) => e.type === 'InvokeCompleted');
    expect(res.ok).toBe(true);
    expect(order).toEqual(['SetCurrentRowAndRowsSelection', 'InvokeAction']);
  });
});
```

Note: adjust the fake `sendRpc` return so `EventDecoder.decode` yields at least one `InvokeCompleted` event (inspect `src/protocol/event-decoder.ts` for the exact `CallbackResponseProperties` -> `InvokeCompleted` shape and match it; the decoder emits `InvokeCompleted` from `CompletedInteractions`). If matching the decoder shape proves fiddly, have the fake return the raw shape the decoder expects from a real Invoke response captured via `console.error` in a one-off run.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/invoke-sequence.test.ts`
Expected: FAIL — `invokeSequence` is not a function.

- [ ] **Step 3: Implement**

In `src/session/bc-session.ts`, add after `invoke` (around `:166`):

```typescript
  /**
   * Send several interactions as ONE queued task, in order, merging all their
   * events. Aborts and returns the first error. Because it occupies a single
   * queue entry, no other operation's invoke can interleave between the
   * interactions — used for select-then-act atomicity (multi-row selection).
   * Intermediate interactions settle on InvokeCompleted; the final one settles
   * on the caller's `expect` predicate.
   */
  async invokeSequence(
    interactions: BCInteraction[],
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    if (interactions.length === 0) return ok([]);
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    try {
      return await this.enqueue(() => this.withTimeout((async () => {
        const all: BCEvent[] = [];
        for (let i = 0; i < interactions.length; i++) {
          const isLast = i === interactions.length - 1;
          const predicate: EventPredicate = isLast ? expect : (e) => e.type === 'InvokeCompleted';
          const r = await this.invokeUnqueued(interactions[i]!, predicate, effectiveTimeout);
          if (isErr(r)) return r;
          all.push(...r.value);
        }
        return ok(all);
      })(), effectiveTimeout + 5000, `InvokeSequence(${interactions.length})`));
    } catch (e) {
      if (e instanceof TimeoutError) return err(new ProtocolError(e.message));
      throw e;
    }
  }
```

Confirm `err`, `ok`, `isErr`, `TimeoutError`, `BCInteraction`, `BCEvent`, `EventPredicate`, `Result`, `ProtocolError` are already imported at the top of the file (they are — `invoke` uses them).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/invoke-sequence.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → clean, and `npx vitest run tests/unit` still green (no regression in existing bc-session tests).

- [ ] **Step 5: Commit**

```bash
git add src/session/bc-session.ts tests/unit/invoke-sequence.test.ts
git commit -m "feat(session): invokeSequence for atomic select-then-act"
```

---

### Task 5: NavigationService.selectRows + InvalidBookmark mapping

**Files:**
- Modify: `src/services/navigation-service.ts` (add `selectRows`, make `selectRow` delegate; import `InvalidBookmarkError`, `isInvalidBookmarkError`)
- Test: `tests/unit/select-rows.test.ts`

**Interfaces:**
- Consumes: `isInvalidBookmarkError` (Task 3), `InvalidBookmarkError` (Task 3).
- Produces:
  ```typescript
  selectRow(pageContextId, bookmark, sectionId?)                 // delegates to selectRows([bookmark])
  selectRows(pageContextId, bookmarks: string[], sectionId?): Promise<Result<PageContext, ProtocolError | InvalidBookmarkError>>
  // Builds one SetCurrentRow interaction: key = bookmarks[0], rowsToSelect = bookmarks.
  // Maps an InvalidBookmarkException RPC error to InvalidBookmarkError(bookmarks[0]).
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/select-rows.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NavigationService } from '../../src/services/navigation-service.js';
import { ok, err, isErr } from '../../src/core/result.js';
import { ProtocolError, InvalidBookmarkError } from '../../src/core/errors.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function harness(invokeImpl: (interaction: any) => Promise<any>) {
  const sent: any[] = [];
  const session = { invoke: vi.fn(async (i: any, _p: any) => { sent.push(i); return invokeImpl(i); }) } as never;
  const ctx = {
    rootFormId: 'f1',
    sections: new Map([['header', {}]]),
    generation: 1,
  };
  const repo = {
    get: vi.fn(() => ctx),
    applyToPage: vi.fn(),
  } as never;
  // resolveSection is imported by the service; to avoid mocking it, we drive a real
  // ctx shaped so resolveSection returns a repeater. Simpler: the test asserts the
  // interaction the service SENDS, so we stub resolveSection via the ctx the repo returns.
  return { session, repo, sent };
}

describe('NavigationService.selectRows', () => {
  it('sends key = bookmarks[0] and rowsToSelect = the full set', async () => {
    // This test requires a ctx whose resolveSection yields a repeater at a known controlPath.
    // Build it against the real resolveSection using a captured page-context fixture, OR
    // assert via a spy on session.invoke that the SetCurrentRow interaction carries
    // key === 'A' and rowsToSelect === ['A','B','C'].
    // (Implementer: construct the minimal ctx that resolveSection accepts — see
    // tests/unit/execute-action-branches.test.ts for the established ctx-shaping pattern.)
    expect(true).toBe(true); // placeholder replaced during implementation per the note below
  });
});
```

**Implementer note for Step 1:** the real assertions this test must make (replace the placeholder):
1. `selectRows(pcId, ['A','B','C'])` sends a single `SetCurrentRow` interaction with `key === 'A'` and `rowsToSelect === ['A','B','C']` (spy on `session.invoke`).
2. `selectRow(pcId, 'X')` delegates and sends `key === 'X'`, `rowsToSelect === ['X']`.
3. When `session.invoke` returns `err(new ProtocolError('...InvalidBookmarkException...'))`, `selectRows` returns `err` whose value is an `InvalidBookmarkError` with `.bookmark === 'A'` and `.code === 'INVALID_BOOKMARK'`.
4. `selectRows(pcId, [])` returns a `ProtocolError` ("at least one bookmark") without calling `session.invoke`.

Build the `ctx`/repo/resolveSection shape by copying the established pattern in `tests/unit/execute-action-branches.test.ts` (read it first) so `resolveSection(ctx, sectionId)` yields `{ form: { formId, root, rows }, repeater: { controlPath } }`. Do NOT mock `resolveSection` — shape a real ctx.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/select-rows.test.ts`
Expected: FAIL — `selectRows` not a function.

- [ ] **Step 3: Implement**

In `src/services/navigation-service.ts`:
- Add imports: `import { ProtocolError, InvalidBookmarkError } from '../core/errors.js';` (ProtocolError already imported — extend the line), `import { isInvalidBookmarkError } from '../session/rpc-error-classifier.js';`.
- Replace the existing `selectRow` body with a delegate and add `selectRows`:

```typescript
  /** Select a single row by bookmark (positions the cursor without opening). */
  async selectRow(pageContextId: string, bookmark: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    return this.selectRows(pageContextId, [bookmark], sectionId);
  }

  /**
   * Select N rows. The anchor (current row) is bookmarks[0] — which is always a
   * member of the set, satisfying BC's "current row must be in SelectedRows"
   * requirement for selection-consuming actions (DeleteAction etc.). Non-anchor
   * bookmarks not in BC's loaded rows are silently skipped by BC; a stale ANCHOR
   * makes BC throw InvalidBookmarkException, mapped here to InvalidBookmarkError.
   */
  async selectRows(pageContextId: string, bookmarks: string[], sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    if (bookmarks.length === 0) return err(new ProtocolError('selectRows requires at least one bookmark.'));
    const anchor = bookmarks[0]!;
    // Anchor-membership invariant (defensive; holds by construction here).
    if (!bookmarks.includes(anchor)) return err(new ProtocolError('Internal: anchor not in selection set.'));

    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater'));

    const interaction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow',
      formId: resolved.form.formId,
      controlPath: resolved.repeater.controlPath,
      key: anchor,
      rowsToSelect: bookmarks,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(result)) {
      if (isInvalidBookmarkError(result.error.message)) {
        return err(new InvalidBookmarkError(anchor, { pageContextId }));
      }
      return result;
    }
    this.repo.applyToPage(pageContextId, result.value);
    return ok(this.repo.get(pageContextId)!);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/select-rows.test.ts`
Expected: PASS (4 assertions). Then `npx tsc --noEmit` clean, and `npx vitest run tests/unit` green — existing tests that call `selectRow` (drill-down, execute-action) must still pass since `selectRow` now delegates to `selectRows([bookmark])` which sends an identical single-element payload.

- [ ] **Step 5: Commit**

```bash
git add src/services/navigation-service.ts tests/unit/select-rows.test.ts
git commit -m "feat(navigation): selectRows with anchor-membership + InvalidBookmark mapping"
```

---

### Task 6: ActionService — optional selection descriptor (atomic path)

**Files:**
- Modify: `src/services/action-service.ts` (`executeAction` + the private `invokeAction`)
- Test: `tests/unit/execute-action-branches.test.ts` (extend — it already tests ActionService construction)

**Interfaces:**
- Consumes: `BCSession.invokeSequence` (Task 4), `SetCurrentRowInteraction` (Task 2).
- Produces:
  ```typescript
  // executeAction gains an optional selection descriptor. When present, the
  // selection interaction and the action interaction are sent as ONE queue entry
  // via invokeSequence (atomic). When absent, behavior is unchanged (single invoke).
  executeAction(pageContextId, actionName, sectionId?, selection?: { formId: string; controlPath: string; bookmarks: string[] }): Promise<Result<ActionResult, ProtocolError>>
  ```

- [ ] **Step 1: Write the failing test**

Read `tests/unit/execute-action-branches.test.ts` first to reuse its ActionService harness. Add a test asserting that when `executeAction` is called with a `selection`, the session receives the selection interaction and the action interaction in ONE `invokeSequence` call (spy `session.invokeSequence`), in that order; and when called WITHOUT selection, it uses `session.invoke` exactly as before (spy asserts invokeSequence NOT called).

```typescript
it('routes select+action through invokeSequence when a selection is given', async () => {
  // harness ActionService with a session spy exposing invoke + invokeSequence
  // call executeAction(pcId, 'Delete', 'header', { formId:'f', controlPath:'server:c[0]', bookmarks:['A','B'] })
  // assert session.invokeSequence called once with [SetCurrentRow(key:'A',rowsToSelect:['A','B']), InvokeAction(...)] in order
  // assert session.invoke NOT called for the action
});
it('uses a single invoke when no selection is given (unchanged path)', async () => {
  // executeAction(pcId, 'Refresh') -> session.invoke called, invokeSequence NOT called
});
```

Fill the harness bodies against the real ActionService construction and the ctx-shaping the existing tests already use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/execute-action-branches.test.ts -t "invokeSequence"`
Expected: FAIL — executeAction ignores the selection arg / no such behavior.

- [ ] **Step 3: Implement**

In `src/services/action-service.ts`:
- Import `SetCurrentRowInteraction` from `../protocol/types.js` (extend the existing type import).
- Change `executeAction`'s signature to accept the optional selection and thread it into `invokeAction`. Read the current `executeAction` (`:50`) and `invokeAction` (`:214`) bodies; `invokeAction` builds the `InvokeActionInteraction` and calls `this.session.invoke(actionInteraction, expect)`. Modify `invokeAction` so that when a `selection` is supplied it builds the `SetCurrentRowInteraction` and calls `this.session.invokeSequence([selectInteraction, actionInteraction], expect)` instead:

```typescript
// in invokeAction, where it currently does `const result = await this.session.invoke(actionInteraction, expect);`
let result;
if (selection) {
  const selectInteraction: SetCurrentRowInteraction = {
    type: 'SetCurrentRow',
    formId: selection.formId,
    controlPath: selection.controlPath,
    key: selection.bookmarks[0]!,
    rowsToSelect: selection.bookmarks,
  };
  result = await this.session.invokeSequence([selectInteraction, actionInteraction], expect);
} else {
  result = await this.session.invoke(actionInteraction, expect);
}
```

Thread the `selection` param from `executeAction(pageContextId, actionName, sectionId, selection?)` down to `invokeAction`. Keep `executeSystemAction`, `executeOnCue`, `drillDown` unchanged (no selection).

Note: the `InvalidBookmarkException` from the selection half surfaces through `invokeSequence`'s error as a ProtocolError message; the execute-action operation (Task 7) maps it via `isInvalidBookmarkError` — OR, simpler, do the mapping here in ActionService when `selection` is set and the error matches. Choose ONE place: do it in the operation (Task 7) so ActionService stays selection-agnostic about error typing. Leave ActionService returning the raw ProtocolError.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/execute-action-branches.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean; `npx vitest run tests/unit` green.

- [ ] **Step 5: Commit**

```bash
git add src/services/action-service.ts tests/unit/execute-action-branches.test.ts
git commit -m "feat(action-service): atomic select+action via invokeSequence"
```

---

### Task 7: execute-action operation — bookmarks[] input + validation

**Files:**
- Modify: `src/operations/execute-action.ts`
- Test: `tests/unit/execute-action-bookmarks.test.ts`

**Interfaces:**
- Consumes: `ActionService.executeAction(..., selection?)` (Task 6), `isInvalidBookmarkError` (Task 3), `InvalidBookmarkError` (Task 3), `BC_MAX_SELECTION` via injected config.
- Produces: `ExecuteActionInput.bookmarks?: string[]`.

**Design notes:**
- `bookmarks` is mutually exclusive with `bookmark`, `rowIndex`, and `cue`.
- Validation before any BC traffic: empty array or empty-string element → error; `> maxSelection` → error; duplicates de-duplicated order-preserving; a current-row-only action (Edit/View/DrillDown/New) with `bookmarks` → error.
- The operation needs `maxSelection` and the list of current-row-only action names. Inject `maxSelection` via the constructor (add a param) so the operation stays testable. For the current-row-only check, resolve the action's systemAction; if the action name maps to one of Edit/View/DrillDown/New (reuse `ActionService`'s name→systemAction map — expose a helper `resolveSystemAction(name): number | undefined` on ActionService, or duplicate the small set of names in the operation with a comment pointing at ROW_TARGETING minus Delete). Simplest: add `ActionService.isCurrentRowOnlyAction(name: string): boolean` returning true for edit/view/drilldown/new (NOT delete — delete consumes the selection).
- Resolve the selection descriptor (formId, controlPath, deduped bookmarks) by resolving the section's repeater (reuse `resolveSection`), then pass `{ formId, controlPath, bookmarks }` to `executeAction`.
- Map an `InvalidBookmarkError` from the sequence: after `executeAction` returns err, if `isInvalidBookmarkError(err.message)`, return `err(new InvalidBookmarkError(bookmarks[0]))`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/execute-action-bookmarks.test.ts` asserting (harness ExecuteActionOperation with spies, per the existing execute-action tests):
1. `bookmarks` + `bookmark` → ProtocolError naming the conflict; no BC traffic.
2. `bookmarks` + `rowIndex` → error. 3. `bookmarks` + `cue` → error.
3. `bookmarks: []` → error. `bookmarks: ['A','']` → error.
4. `bookmarks` of length `maxSelection + 1` → error.
5. `bookmarks: ['A','B','A']` → executeAction receives selection with deduped `['A','B']` (order preserved).
6. `bookmarks` with action `'Edit'` (current-row-only) → error, no BC traffic.
7. `bookmarks: ['A','B']` with action `'Delete'` → executeAction called with `selection.bookmarks === ['A','B']`.
8. When executeAction errs with an InvalidBookmarkException message → operation returns `InvalidBookmarkError` (code INVALID_BOOKMARK).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/execute-action-bookmarks.test.ts`
Expected: FAIL — `bookmarks` unrecognized.

- [ ] **Step 3: Implement**

- Add `bookmarks?: string[]` to `ExecuteActionInput`.
- Add `maxSelection` to the constructor (new last param; update composition roots in Task 8's wiring — NOTE: this changes the ctor arity, breaking `server.ts`/`stdio-server.ts`, fixed in Task 8). Alternatively inject via a small options object; a plain number param is fine.
- In `execute()`, before the existing `input.cue` branch, add validation + selection resolution for `bookmarks`:
  - reject `bookmarks` alongside `bookmark`/`rowIndex`/`cue`.
  - reject empty / empty-string / over-max.
  - dedupe order-preserving.
  - if the action is current-row-only (`this.actionService.isCurrentRowOnlyAction(input.action)`), reject.
  - resolve the section's repeater → `{ formId, controlPath }`; if no repeater, reject.
  - call `this.actionService.executeAction(pcId, action, section, { formId, controlPath, bookmarks: deduped })`.
  - classify business errors, buildOutput, capture downloads (same tail as the existing action path). On an `isInvalidBookmarkError` err, return `InvalidBookmarkError`.
- Leave the existing single `bookmark`/`rowIndex` `positionRow` path UNCHANGED (no regression).

Add `isCurrentRowOnlyAction` to `ActionService`:

```typescript
/** Edit/View/DrillDown/New act on the current row only — they do NOT consume a multi-row selection. */
isCurrentRowOnlyAction(name: string): boolean {
  const sa = SYSTEM_ACTION_NAMES.get(name.toLowerCase());
  return sa === SystemAction.Edit || sa === SystemAction.View || sa === SystemAction.DrillDown || sa === SystemAction.New;
}
```

(Confirm the exact `SYSTEM_ACTION_NAMES` map key casing in action-service.ts and match it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/execute-action-bookmarks.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — expect errors ONLY in `src/server.ts` / `src/stdio-server.ts` (ExecuteActionOperation ctor arity changed), fixed in Task 8. Confirm no other file errors.

- [ ] **Step 5: Commit**

```bash
git add src/operations/execute-action.ts src/services/action-service.ts tests/unit/execute-action-bookmarks.test.ts
git commit -m "feat(execute-action): bookmarks[] multi-row selection with validation"
```

---

### Task 8: Schema, tool description, composition wiring

**Files:**
- Modify: `src/mcp/schemas.ts` (`ExecuteActionSchema` `:47-56`)
- Modify: `src/operations/execute-action.tool.ts` (description + input_examples)
- Modify: `src/server.ts`, `src/stdio-server.ts` (pass `config.bc.maxSelection` to `ExecuteActionOperation`)

- [ ] **Step 1: Write the failing test**

Add to an appropriate schema test (or create `tests/unit/execute-action-schema.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { ExecuteActionSchema } from '../../src/mcp/schemas.js';

describe('ExecuteActionSchema bookmarks', () => {
  it('accepts bookmarks[] with an action', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Delete', bookmarks: ['A', 'B'] }).success).toBe(true);
  });
  it('rejects bookmarks together with bookmark', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', action: 'Delete', bookmarks: ['A'], bookmark: 'A' }).success).toBe(false);
  });
  it('rejects bookmarks together with cue', () => {
    expect(ExecuteActionSchema.safeParse({ pageContextId: 'p', cue: 'X', section: 's', bookmarks: ['A'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/execute-action-schema.test.ts`
Expected: FAIL — schema lacks `bookmarks` / the refinement.

- [ ] **Step 3: Implement**

In `src/mcp/schemas.ts`, `ExecuteActionSchema`: add the field and extend the refinement:

```typescript
  bookmarks: z.array(z.string().min(1)).optional().describe('Stable row identifiers for a MULTI-ROW action (batch delete, apply-entries). The first bookmark is the anchor/current row. Mutually exclusive with bookmark, rowIndex, and cue. Bookmarks must come from a bc_read_data of the same section and must still be loaded. Only actions that consume a selection (e.g. Delete) act on all rows; Edit/View/DrillDown/New use the anchor only and are rejected with bookmarks[].'),
```

Extend the existing `.refine(...)` (which enforces action-XOR-cue) with additional refinements, or chain `.superRefine`:

```typescript
.superRefine((d, ctx) => {
  if (d.bookmarks && (d.bookmark !== undefined || d.rowIndex !== undefined || d.cue !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bookmarks[] is mutually exclusive with bookmark, rowIndex, and cue.' });
  }
})
```

(Keep the existing `!!d.action !== !!d.cue` refine.)

Update `src/operations/execute-action.tool.ts`: add a sentence and an input_example for multi-row Delete (`{ pageContextId, action: 'Delete', bookmarks: ['<bk1>','<bk2>'] }`), noting only selection-consuming actions act on all rows.

In `src/server.ts` and `src/stdio-server.ts` `buildServices`, pass `config.bc.maxSelection` as the new last arg to `new ExecuteActionOperation(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/execute-action-schema.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — now FULLY clean (composition roots fixed). `npx vitest run` full suite → 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/schemas.ts src/operations/execute-action.tool.ts src/server.ts src/stdio-server.ts tests/unit/execute-action-schema.test.ts
git commit -m "feat(execute-action): bookmarks[] schema, tool docs, composition wiring"
```

---

### Task 9: Integration verification (Cronus28)

**Files:**
- Create: `tests/integration/multi-row-selection.test.ts`

**Interfaces:** uses `integrationPool` (`tests/integration/helpers/session-pool.ts`) and the operations built with a stub DownloadService (`tests/integration/helpers/download-service.ts`, created by the download-capture feature) since these flows emit no downloads.

- [ ] **Step 1: Write the integration tests**

Following `tests/integration/download-capture.test.ts`'s pool + operation-construction pattern (ExecuteActionOperation now needs actionService, repo, navigationService, downloadService, maxSelection — build them from the leased session; use `stubDownloadService(logger)`), write:

```
// 1. Multi-row confirm path: open Customer List (page 22), read >=3 rows, capture 3 bookmarks,
//    bc_execute_action(action:'Delete', bookmarks:[b0,b1,b2]) -> assert a confirmation dialog
//    opens (requiresDialogResponse true / dialogsOpened non-empty), then bc_respond_dialog 'no'.
//    Assert the dialog's message reflects a multi-record delete if the BC28 string is known
//    (capture it first); otherwise assert a dialog appeared and answer No.
// 2. Destructive round-trip: open a General Journal, create 3 lines (execute New + write), capture
//    their 3 bookmarks, bc_execute_action(Delete, bookmarks=[all 3]), respond Yes, re-read, assert
//    all three gone.  (Guard with a try/finally that leaves the batch clean.)
// 3. Current-row-only guard: bc_execute_action(action:'Edit', bookmarks:[b0,b1]) -> error, no BC delete.
// 4. Stale anchor: capture a bookmark, apply a filter that removes it from loaded rows, then
//    bc_execute_action(Delete, bookmarks:[staleBookmark]) -> INVALID_BOOKMARK.
// 5. Single-row unchanged: bc_execute_action(Delete, bookmark: b0) still works (existing path).
```

Pin the exact Customer List / General Journal page numbers and the Delete confirmation string during implementation by reading them live. For test 2, if creating disposable journal lines proves environment-specific, substitute another list whose rows are safely creatable+deletable and document the choice.

- [ ] **Step 2: Run the integration tests**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/multi-row-selection.test.ts`
Expected: PASS against Cronus28 (BC 28.3; the Origin fix is on master). If it flakes, retry, then try `BC_BASE_URL=http://cronus281/BC ...`.

Also run the FULL integration suite once to confirm no regression from the ActionService/NavigationService changes:
Run: `npx vitest run --config vitest.integration.config.ts`
Expected: same pass count as before this feature (the single-row selectRow delegation must not regress existing drilldown/delete tests).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/multi-row-selection.test.ts
git commit -m "test(integration): multi-row selection delete, guards, stale anchor"
```

---

### Task 10: Docs — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` ("Row-Targeting Actions (Drill-Down, Delete, etc.)" section)

- [ ] **Step 1: Extend the section**

Add to the "Row-Targeting Actions" section: multi-row selection via `bc_execute_action { bookmarks: [...] }` sends `SetCurrentRowAndRowsSelection` with the full set (anchor = `bookmarks[0]`, which must be a member so selection-consuming actions like Delete see the current row in `SelectedRows`). Selection + action are sent atomically via `BCSession.invokeSequence` (one queue entry). Only selection-consuming actions (Delete, Copy) act on all rows; Edit/View/DrillDown/New use the anchor only and are rejected with `bookmarks[]`. A stale anchor (not in BC's loaded rows) returns `INVALID_BOOKMARK`; non-anchor bookmarks not loaded are silently skipped. `BC_MAX_SELECTION` (default 100) caps the set. `selectAll` is not supported. Reference: decompiled `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs`, `DeleteAction.cs`, `SelectRowsInteraction.cs`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: multi-row selection in Row-Targeting Actions"
```

---

## Self-Review

**Spec coverage** (against `2026-07-24-multi-row-selection-design.md`):
- rowsToSelect on the type + encoder, single-row byte-identical → Task 2. ✓
- Anchor-membership invariant (DeleteAction reason) → Task 5 (assert) + Global Constraints. ✓
- Anchor failure = InvalidBookmarkError; non-anchor silently skipped → Task 3 + Task 5 + Global Constraints. ✓
- `selectRows` + `selectRow` delegate → Task 5. ✓
- Atomicity via `invokeSequence` → Task 4 + Task 6. ✓
- Action validation ordering (resolve/validate before the sequence) → Task 7 (validation precedes executeAction; the action interaction is resolved inside invokeAction before the sequence sends). ✓
- `bookmarks[]` input + all validations (exclusivity, empty, max, dedup, current-row-only reject) → Task 7 + Task 8 (schema). ✓
- Multi-select constraints documented → Task 10 (and the tool description). ✓
- `BC_MAX_SELECTION` default 100 → Task 1. ✓
- `bc_navigate(select)` stays single-row → untouched (no task changes it). ✓
- `selectAll` out of scope → Global Constraints + Task 10. ✓
- Residual-selection behaviour → covered by integration test 1 (answer No) + documented; the spec's residual concern is a documented limitation, not code. ✓

**Placeholder scan:** Task 5 Step 1 ships a placeholder test body with an explicit implementer note listing the 4 real assertions and the established ctx-shaping pattern to use — this is a deliberate, bounded instruction (the exact ctx fixture depends on `resolveSection`'s shape, which the implementer reads live), not a "TODO". Same for Task 6/7 harness bodies. All other steps carry concrete code.

**Type consistency:** `selectRows(pcId, bookmarks, sectionId?)` (Task 5) matches the caller in ActionService's selection path (Task 6 builds the interaction directly, not via selectRows — note: ActionService builds its OWN SetCurrentRowInteraction for the atomic sequence rather than calling selectRows, because selectRows sends its own invoke; the selection descriptor `{ formId, controlPath, bookmarks }` is resolved in the operation Task 7 and passed to executeAction Task 6). `isCurrentRowOnlyAction` (Task 6/7) defined once on ActionService. `InvalidBookmarkError(bookmark)` ctor (Task 3) matches its uses (Task 5, Task 7). `invokeSequence(interactions, expect, timeoutMs?)` (Task 4) matches the call in Task 6.

**One consistency note resolved:** the selection is built in TWO places conceptually — `NavigationService.selectRows` (for the standalone select path, and the single-row delegate) and `ActionService.invokeAction`'s atomic path (which builds its own SetCurrentRowInteraction from the descriptor). This is intentional: the atomic path cannot call selectRows (that would be a separate invoke, breaking atomicity). Both construct the identical interaction shape (key = bookmarks[0], rowsToSelect = bookmarks). The encoder is the single source of wire truth. Documented in Task 6 Step 3.

---

## Execution notes

- Tasks 1-5 are leaf/low-risk and green offline. Task 4 (invokeSequence) and Task 6 (ActionService atomic path) are the session-touching core — review them hardest.
- Task 7 changes ExecuteActionOperation's ctor arity → Task 8 fixes the composition roots. tsc is intentionally red between Task 7 and Task 8 (errors confined to server.ts/stdio-server.ts).
- The existing single-`bookmark`/`rowIndex` path is deliberately left UNCHANGED to avoid regressing shipped behavior; only the new `bookmarks[]` path is atomic.
- Task 9 runs live; Cronus28 works (Origin fix on master), Cronus281 is the fallback.
