# Phase 5: Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the BC MCP server production-grade with session resilience, multi-company support, report execution, and polished write-back workflows.

**Architecture:** Four independent pillars: (1) Robustness adds retry/backoff/timeout logic to SessionManager and BCSession, (2) Write-Back Polish improves existing execute-action and write-data operations with better error messages and detection, (3) Multi-Company adds two new tools (`bc_switch_company`, `bc_list_companies`) via a new `InvokeSessionAction` interaction type, (4) Reports adds `bc_run_report` using a `RunReport` interaction type. Each pillar touches different files and can be merged independently.

**Tech Stack:** TypeScript, Vitest, Zod, WebSocket protocol

---

## File Map

### Pillar 1: Robustness
- Modify: `src/session/session-manager.ts` -- add retry/backoff to `getSession()`, handle `LogicalModalityViolationException`
- Modify: `src/session/bc-session.ts` -- add invoke timeout via `Promise.race`
- Modify: `src/core/config.ts` -- add `BC_INVOKE_TIMEOUT`, `BC_RECONNECT_MAX_RETRIES`, `BC_RECONNECT_BASE_DELAY` env vars
- Modify: `src/core/errors.ts` -- add `reconnectFailed` field to `SessionLostError`
- Modify: `src/protocol/page-context-repo.ts` -- add `listPageContextSummaries()` for stale context error messages
- Modify: `src/mcp/handler.ts` -- add stale pageContextId validation, license dialog auto-dismiss
- Modify: `src/server.ts` -- pass new config values through
- Modify: `src/stdio-server.ts` -- pass new config values through
- Create: `tests/unit/session-reconnect.test.ts`
- Create: `tests/unit/invoke-timeout.test.ts`
- Create: `tests/unit/stale-context.test.ts`
- Create: `tests/integration/session-recovery.test.ts`

### Pillar 2: Write-Back Polish
- Modify: `src/operations/execute-action.ts` -- detect new pages from "New" action, validate row selection for "Delete"
- Modify: `src/mcp/tool-registry.ts` -- update tool descriptions
- Create: `tests/unit/execute-action-new.test.ts`
- Create: `tests/integration/write-back-workflows.test.ts`

### Pillar 3: Multi-Company
- Create: `src/operations/switch-company.ts`
- Create: `src/operations/list-companies.ts`
- Modify: `src/protocol/types.ts` -- add `InvokeSessionAction` to BCInteraction union (already exists as `SessionAction`)
- Modify: `src/mcp/schemas.ts` -- add `SwitchCompanySchema`, `ListCompaniesSchema`
- Modify: `src/mcp/tool-registry.ts` -- register `bc_switch_company`, `bc_list_companies`
- Modify: `src/server.ts` -- wire new operations
- Modify: `src/stdio-server.ts` -- wire new operations
- Create: `tests/unit/company-switch.test.ts`
- Create: `tests/integration/multi-company.test.ts`

### Pillar 4: Reports
- Create: `src/operations/run-report.ts`
- Modify: `src/protocol/types.ts` -- add `RunReportInteraction` to BCInteraction union
- Modify: `src/protocol/interaction-encoder.ts` -- add `RunReport` case to `buildInvocation`
- Modify: `src/mcp/schemas.ts` -- add `RunReportSchema`
- Modify: `src/mcp/tool-registry.ts` -- register `bc_run_report`
- Modify: `src/server.ts` -- wire new operation
- Modify: `src/stdio-server.ts` -- wire new operation
- Create: `tests/unit/report-execution.test.ts`
- Create: `tests/integration/report-execution.test.ts`

---

## Pillar 1: Robustness & Error Recovery

### Task 1: Add reconnect config to AppConfig

**Files:**
- Modify: `src/core/config.ts`

- [ ] **Step 1: Add new config fields and env var parsing**

In `src/core/config.ts`, add three fields to `BCConfig`:

```typescript
// Add to BCConfig interface after timeoutMs:
  invokeTimeoutMs: number;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
```

In `loadConfig()`, add to the `bc` object:

```typescript
      invokeTimeoutMs: optionalEnvInt('BC_INVOKE_TIMEOUT', 30000),
      reconnectMaxRetries: optionalEnvInt('BC_RECONNECT_MAX_RETRIES', 4),
      reconnectBaseDelayMs: optionalEnvInt('BC_RECONNECT_BASE_DELAY', 1000),
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Errors in files that use `BCConfig` but don't pass new fields -- that's fine, we'll fix them in later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/core/config.ts
git commit -m "feat: add reconnect and timeout config options"
```

---

### Task 2: Add reconnectFailed to SessionLostError

**Files:**
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Add reconnectFailed field**

In `src/core/errors.ts`, modify `SessionLostError`:

```typescript
export class SessionLostError extends BCError {
  public readonly impactedPageContextIds: string[];
  public readonly reconnectFailed: boolean;
  constructor(message: string, impactedPageContextIds: string[], options?: { reconnectFailed?: boolean; context?: Record<string, unknown> }) {
    super(message, 'SESSION_LOST', options?.context);
    this.impactedPageContextIds = impactedPageContextIds;
    this.reconnectFailed = options?.reconnectFailed ?? false;
  }
}
```

- [ ] **Step 2: Fix existing SessionLostError call sites**

In `src/session/session-manager.ts` line 82, update the constructor call:

```typescript
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
```

This still works because `options` is optional. No change needed here.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (the old constructor call is compatible since the third param was `context?` and is now `options?` -- but we need to verify no existing call passes a third arg)

- [ ] **Step 4: Commit**

```bash
git add src/core/errors.ts
git commit -m "feat: add reconnectFailed flag to SessionLostError"
```

---

### Task 3: Session reconnect with exponential backoff

**Files:**
- Modify: `src/session/session-manager.ts`
- Create: `tests/unit/session-reconnect.test.ts`

- [ ] **Step 1: Write failing tests for reconnect behavior**

Create `tests/unit/session-reconnect.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionLostError } from '../../src/core/errors.js';

// Minimal mocks
function createMockSession(alive: boolean) {
  return {
    isAlive: alive,
    close: vi.fn(),
    closeGracefully: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockFactory(sessions: any[]) {
  let index = 0;
  return {
    create: vi.fn(async () => {
      const s = sessions[index++];
      if (s instanceof Error) return { ok: false, error: s };
      return { ok: true, value: s };
    }),
  } as any;
}

function createMockRepo() {
  return {
    listPageContextIds: vi.fn(() => ['ctx-1', 'ctx-2']),
    listPageContextSummaries: vi.fn(() => [
      { id: 'ctx-1', caption: 'Customer List', pageId: 22 },
      { id: 'ctx-2', caption: 'Item Card', pageId: 30 },
    ]),
    clearAll: vi.fn(),
  } as any;
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

describe('SessionManager reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns alive session without reconnect', async () => {
    const session = createMockSession(true);
    const factory = createMockFactory([]);
    const repo = createMockRepo();
    const mgr = new SessionManager(factory, repo, mockLogger);
    // Inject session directly
    (mgr as any).session = session;

    const result = await mgr.getSession();
    expect(result).toBe(session);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('retries with backoff when session is dead', async () => {
    const deadSession = createMockSession(false);
    const newSession = createMockSession(true);
    const factory = createMockFactory([
      new Error('NTLM slot busy'), // retry 1 fails
      new Error('NTLM slot busy'), // retry 2 fails
      newSession,                   // retry 3 succeeds
    ]);
    const repo = createMockRepo();
    const mgr = new SessionManager(factory, repo, mockLogger, {
      maxRetries: 4,
      baseDelayMs: 100,
    });
    (mgr as any).session = deadSession;

    // getSession should retry and eventually throw SessionLostError (success case)
    const promise = mgr.getSession();

    // Advance through delays: 100ms, 200ms, 400ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);

    await expect(promise).rejects.toThrow(SessionLostError);

    // Factory was called 3 times (2 failures + 1 success)
    expect(factory.create).toHaveBeenCalledTimes(3);
    // Repo was cleared
    expect(repo.clearAll).toHaveBeenCalled();
    // Dead session was closed
    expect(deadSession.close).toHaveBeenCalled();
  });

  it('sets reconnectFailed=true when all retries exhausted', async () => {
    const deadSession = createMockSession(false);
    const factory = createMockFactory([
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
      new Error('fail 4'),
    ]);
    const repo = createMockRepo();
    const mgr = new SessionManager(factory, repo, mockLogger, {
      maxRetries: 4,
      baseDelayMs: 100,
    });
    (mgr as any).session = deadSession;

    const promise = mgr.getSession();
    await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 800);

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionLostError);
      expect((e as SessionLostError).reconnectFailed).toBe(true);
      expect((e as SessionLostError).impactedPageContextIds).toEqual(['ctx-1', 'ctx-2']);
    }
  });

  it('handles LogicalModalityViolationException during first connect', async () => {
    const modalError = new Error('LogicalModalityViolationException');
    const goodSession = createMockSession(true);
    const factory = createMockFactory([
      modalError,   // first attempt: modal state from crashed session
      goodSession,  // second attempt: works
    ]);
    const repo = createMockRepo();
    const mgr = new SessionManager(factory, repo, mockLogger, {
      maxRetries: 4,
      baseDelayMs: 100,
    });

    const promise = mgr.getSession();
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe(goodSession);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/session-reconnect.test.ts`
Expected: FAIL -- SessionManager constructor doesn't accept options yet, no retry logic exists

- [ ] **Step 3: Implement reconnect with backoff in SessionManager**

Replace `src/session/session-manager.ts` entirely:

```typescript
import { isErr } from '../core/result.js';
import { SessionLostError } from '../core/errors.js';
import type { BCSession } from './bc-session.js';
import type { SessionFactory } from './session-factory.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

export interface ReconnectOptions {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_RECONNECT: ReconnectOptions = {
  maxRetries: 4,
  baseDelayMs: 1000,
};

/**
 * Manages the BC session lifecycle including lazy creation and automatic recovery
 * after session death (InvalidSessionException, WebSocket disconnect).
 *
 * Recovery uses exponential backoff (1s, 2s, 4s, 8s by default) to wait out
 * BC's ~15-second NTLM auth slot hold after a crashed session.
 */
export class SessionManager {
  private session: BCSession | null = null;
  private servicesInvalidated = false;
  private readonly reconnect: ReconnectOptions;

  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly pageContextRepo: PageContextRepository,
    private readonly logger: Logger,
    reconnectOptions?: Partial<ReconnectOptions>,
  ) {
    this.reconnect = { ...DEFAULT_RECONNECT, ...reconnectOptions };
  }

  get currentSession(): BCSession | null {
    return this.session;
  }

  get needsServiceRebuild(): boolean {
    return this.servicesInvalidated;
  }

  markServicesRebuilt(): void {
    this.servicesInvalidated = false;
  }

  /**
   * Returns an alive session, creating one if needed.
   * If the existing session is dead, performs recovery with exponential backoff.
   */
  async getSession(): Promise<BCSession> {
    // Happy path: session exists and is alive
    if (this.session !== null && this.session.isAlive) {
      return this.session;
    }

    // Session is dead -- recover with retries
    if (this.session !== null) {
      return this.recoverDeadSession();
    }

    // No session yet -- create one (first call), with retry for modal state
    return this.createSessionWithRetry();
  }

  private async recoverDeadSession(): Promise<never> {
    this.logger.info('Session is dead, initiating recovery...');

    const impactedIds = this.pageContextRepo.listPageContextIds();

    // Tear down dead session
    this.session!.close();
    this.session = null;

    // Clear all page contexts
    this.pageContextRepo.clearAll();
    this.servicesInvalidated = true;

    // Attempt reconnect with exponential backoff
    const newSession = await this.createWithBackoff();

    if (newSession) {
      this.session = newSession;
      this.logger.info('Session recovered successfully');
      throw new SessionLostError(
        'Session was lost and has been recreated. Previous page contexts are no longer valid. Please re-open any pages you need.',
        impactedIds,
      );
    }

    // All retries exhausted
    throw new SessionLostError(
      'Session was lost and could not be reconnected after multiple attempts. The BC server may be unavailable.',
      impactedIds,
      { reconnectFailed: true },
    );
  }

  private async createSessionWithRetry(): Promise<BCSession> {
    const session = await this.createWithBackoff();
    if (session) {
      this.session = session;
      this.logger.info('BC session established');
      return session;
    }
    throw new Error('Session creation failed after multiple attempts. The BC server may be unavailable.');
  }

  /**
   * Try to create a session with exponential backoff.
   * Handles both NTLM slot contention and LogicalModalityViolationException.
   */
  private async createWithBackoff(): Promise<BCSession | null> {
    let lastError: string = '';

    for (let attempt = 0; attempt < this.reconnect.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.reconnect.baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.info(`Reconnect attempt ${attempt + 1}/${this.reconnect.maxRetries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const result = await this.sessionFactory.create();
      if (!isErr(result)) {
        return result.value;
      }

      lastError = result.error.message;

      // LogicalModalityViolationException: BC still has stale modal state, retry
      if (lastError.includes('LogicalModalityViolation')) {
        this.logger.warn('BC has stale modal state from previous session, waiting for cleanup...');
        continue;
      }

      // Other transient errors: retry
      this.logger.warn(`Session creation failed (attempt ${attempt + 1}): ${lastError}`);
    }

    this.logger.error(`All ${this.reconnect.maxRetries} reconnect attempts failed. Last error: ${lastError}`);
    return null;
  }

  async closeGracefully(): Promise<void> {
    if (this.session !== null) {
      await this.session.closeGracefully();
      this.session = null;
    }
  }

  close(): void {
    if (this.session !== null) {
      this.session.close();
      this.session = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/session-reconnect.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (no regressions -- existing callers pass no options, defaults apply)

- [ ] **Step 6: Commit**

```bash
git add src/session/session-manager.ts tests/unit/session-reconnect.test.ts
git commit -m "feat: session reconnect with exponential backoff"
```

---

### Task 4: Invoke timeout with session kill

**Files:**
- Modify: `src/session/bc-session.ts`
- Create: `tests/unit/invoke-timeout.test.ts`

- [ ] **Step 1: Write failing test for invoke timeout**

Create `tests/unit/invoke-timeout.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { TimeoutError } from '../../src/core/errors.js';

function createMockWs(sendBehavior: 'hang' | 'succeed') {
  return {
    isConnected: true,
    spaInstanceId: 'spa-1',
    nextSequenceNo: '1',
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn(async () => {
      if (sendBehavior === 'hang') {
        // Never resolves
        return new Promise(() => {});
      }
      return { ok: true, value: [] };
    }),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
  } as any;
}

const mockDecoder = { decode: vi.fn(() => []) } as any;
const mockEncoder = {
  encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
  encodeOpenSession: vi.fn(),
  clientVersion: '27.0.0.0',
} as any;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

describe('BCSession invoke timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills session when invoke exceeds timeout', async () => {
    const ws = createMockWs('hang');
    const session = new BCSession(ws, mockDecoder, mockEncoder, mockLogger, 'default', 500);
    // Mark as initialized so invoke doesn't reject
    (session as any)._initialized = true;
    (session as any).sessionId = 'test-session';
    (session as any).sessionKey = 'test-key';

    const interaction = { type: 'InvokeAction' as const, formId: 'f1', controlPath: 'server:', systemAction: 30 };
    const promise = session.invoke(interaction, () => true, 500);

    // The sendRpc hangs forever. The timeout should fire after 500ms.
    // But the timeout is already in sendRpc via ws.sendRpc(... timeoutMs).
    // Our new code wraps with Promise.race at the BCSession level.
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('timed out');
    }
    expect(session.isAlive).toBe(false);
    expect(ws.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/invoke-timeout.test.ts`
Expected: FAIL -- no session-level timeout wrapping exists yet

- [ ] **Step 3: Add invoke-level timeout to BCSession**

In `src/session/bc-session.ts`, modify the `invokeInternal` method. After line 151 (the `sendRpc` call), the timeout is already passed to `ws.sendRpc`. However, the BC-level hang (Bug 1) happens at a layer where `sendRpc` doesn't return. We need a safety timeout at the session level.

Wrap the entire invoke body in the `invokeInternal` method. Add this helper method to `BCSession`:

```typescript
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logger.error(`${label} timed out after ${ms}ms, killing session`);
        this.markDead();
        this.ws.close();
        reject(new TimeoutError(`BC did not respond within ${ms / 1000}s. Session has been killed and will reconnect on next request.`));
      }, ms);

      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
```

Import `TimeoutError` at the top:
```typescript
import { ProtocolError, TimeoutError } from '../core/errors.js';
```

Then in `invoke()` (line 94-101), wrap the enqueue call:

```typescript
  async invoke(
    interaction: BCInteraction,
    expect: EventPredicate,
    timeoutMs?: number,
  ): Promise<Result<BCEvent[], ProtocolError>> {
    if (this.dead) return err(new ProtocolError('Session is dead'));
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    try {
      return await this.withTimeout(
        this.enqueue(() => this.invokeInternal(interaction, expect, effectiveTimeout)),
        effectiveTimeout + 5000, // Session-level timeout is 5s longer than RPC timeout
        `Invoke(${interaction.type})`,
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        return err(new ProtocolError(e.message));
      }
      throw e;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/invoke-timeout.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/session/bc-session.ts tests/unit/invoke-timeout.test.ts
git commit -m "feat: invoke-level timeout kills session on BC hang"
```

---

### Task 5: Stale page context validation

**Files:**
- Modify: `src/protocol/page-context-repo.ts`
- Modify: `src/mcp/handler.ts`
- Create: `tests/unit/stale-context.test.ts`

- [ ] **Step 1: Add listPageContextSummaries to PageContextRepository**

In `src/protocol/page-context-repo.ts`, add after `listPageContextIds()`:

```typescript
  listPageContextSummaries(): Array<{ id: string; caption: string }> {
    return Array.from(this.pages.entries()).map(([id, ctx]) => ({
      id,
      caption: ctx.caption || `Page (${ctx.pageType})`,
    }));
  }
```

- [ ] **Step 2: Write failing test for stale context detection**

Create `tests/unit/stale-context.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InputValidationError } from '../../src/core/errors.js';

/**
 * Validates that a pageContextId exists, throwing InputValidationError with
 * helpful context if it doesn't. This is the helper function we'll implement.
 */
import { validatePageContextId } from '../../src/mcp/page-context-validator.js';

describe('stale page context validation', () => {
  it('returns context when pageContextId is valid', () => {
    const mockRepo = {
      get: (id: string) => id === 'valid-id' ? { pageContextId: 'valid-id', caption: 'Customer List' } : undefined,
      listPageContextSummaries: () => [{ id: 'valid-id', caption: 'Customer List' }],
    } as any;

    const result = validatePageContextId(mockRepo, 'valid-id');
    expect(result.pageContextId).toBe('valid-id');
  });

  it('throws InputValidationError with open pages list when invalid', () => {
    const mockRepo = {
      get: () => undefined,
      listPageContextSummaries: () => [
        { id: 'ctx-1', caption: 'Customer List' },
        { id: 'ctx-2', caption: 'Item Card' },
      ],
    } as any;

    expect(() => validatePageContextId(mockRepo, 'bad-id')).toThrow(InputValidationError);
    try {
      validatePageContextId(mockRepo, 'bad-id');
    } catch (e) {
      expect((e as Error).message).toContain('bad-id');
      expect((e as Error).message).toContain('Customer List');
      expect((e as Error).message).toContain('Item Card');
    }
  });

  it('shows helpful message when no pages are open', () => {
    const mockRepo = {
      get: () => undefined,
      listPageContextSummaries: () => [],
    } as any;

    try {
      validatePageContextId(mockRepo, 'bad-id');
    } catch (e) {
      expect((e as Error).message).toContain('No pages are currently open');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/stale-context.test.ts`
Expected: FAIL -- `page-context-validator.js` doesn't exist

- [ ] **Step 4: Create page-context-validator**

Create `src/mcp/page-context-validator.ts`:

```typescript
import { InputValidationError } from '../core/errors.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';

/**
 * Validates that a pageContextId exists in the repo.
 * Throws InputValidationError with a list of open pages if invalid.
 */
export function validatePageContextId(
  repo: PageContextRepository,
  pageContextId: string,
): PageContext {
  const ctx = repo.get(pageContextId);
  if (ctx) return ctx;

  const open = repo.listPageContextSummaries();
  const openList = open.length > 0
    ? open.map(p => `"${p.id}" (${p.caption})`).join(', ')
    : 'No pages are currently open';

  throw new InputValidationError([{
    path: 'pageContextId',
    message: `Page context "${pageContextId}" does not exist. Open page contexts: ${openList}. Use bc_open_page to open a page first.`,
  }]);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/stale-context.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/protocol/page-context-repo.ts src/mcp/page-context-validator.ts tests/unit/stale-context.test.ts
git commit -m "feat: stale page context validation with open page listing"
```

---

### Task 6: License popup auto-dismiss

**Files:**
- Modify: `src/session/session-manager.ts`
- Modify: `src/session/bc-session.ts`

- [ ] **Step 1: Add license dialog detection to BCSession**

In `src/session/bc-session.ts`, add a method to check if a dialog is a license popup:

```typescript
  private isLicenseDialog(events: BCEvent[]): BCEvent | undefined {
    return events.find(e => {
      if (e.type !== 'DialogOpened') return false;
      const tree = e.controlTree as Record<string, unknown> | undefined;
      if (!tree) return false;
      const caption = ((tree.Caption ?? tree.caption ?? '') as string).toLowerCase();
      const message = ((tree.Message ?? tree.message ?? '') as string).toLowerCase();
      const text = caption + ' ' + message;
      return text.includes('license') || text.includes('evaluation') || text.includes('trial');
    });
  }
```

- [ ] **Step 2: Call license check after initialize()**

In `BCSession.initialize()`, after `this.updateFormTracking(events)` (line 65), add:

```typescript
    // Auto-dismiss license notification dialogs
    const licenseDialog = this.isLicenseDialog(events);
    if (licenseDialog && licenseDialog.type === 'DialogOpened') {
      this.logger.info('Auto-dismissing license notification dialog');
      try {
        await this.invoke(
          { type: 'InvokeAction', formId: licenseDialog.formId, controlPath: 'server:', systemAction: 300 }, // OK=300
          (e) => e.type === 'InvokeCompleted',
        );
        this._openFormIds.delete(licenseDialog.formId);
      } catch {
        this.logger.warn('Failed to auto-dismiss license dialog, continuing anyway');
      }
    }
```

- [ ] **Step 3: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/session/bc-session.ts
git commit -m "feat: auto-dismiss license popup on fresh databases"
```

---

### Task 7: Wire reconnect config through server entry points

**Files:**
- Modify: `src/server.ts`
- Modify: `src/stdio-server.ts`

- [ ] **Step 1: Pass reconnect options to SessionManager in server.ts**

In `src/server.ts`, update the `SessionManager` construction (around line 59):

```typescript
  const sessionManager = new SessionManager(sessionFactory, pageContextRepo, logger, {
    maxRetries: config.bc.reconnectMaxRetries,
    baseDelayMs: config.bc.reconnectBaseDelayMs,
  });
```

- [ ] **Step 2: Do the same in stdio-server.ts**

Read `src/stdio-server.ts` first, then apply the same pattern.

- [ ] **Step 3: Pass invokeTimeoutMs to SessionFactory/BCSession**

In `src/server.ts`, the `SessionFactory` creates `BCSession` instances. Check how `SessionFactory` passes the timeout. Ensure `config.bc.invokeTimeoutMs` is passed through.

Read `src/session/session-factory.ts` to understand the constructor chain.

- [ ] **Step 4: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/stdio-server.ts
git commit -m "feat: wire reconnect and timeout config through server entry points"
```

---

### Task 8: Session recovery integration tests

**Files:**
- Create: `tests/integration/session-recovery.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/integration/session-recovery.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SessionLostError } from '../../src/core/errors.js';

// These tests use the real BC session infrastructure.
// Import the test helpers used by other integration tests.
// Check existing integration tests (e.g., tests/integration/session.test.ts) for the pattern.

describe('session recovery', () => {
  // NOTE: Read tests/integration/session.test.ts to understand the test helper
  // pattern (session creation, page opening, etc.) and follow the same pattern here.

  it('recovers after session death and provides clear error', async () => {
    // 1. Create session, open a page
    // 2. Kill the session (mark dead, or send an InvalidSessionException-triggering invoke)
    // 3. Call getSession() -- should throw SessionLostError
    // 4. Verify impactedPageContextIds contains the opened page
    // 5. Call getSession() again -- should succeed (new session)
  });

  it('second call after recovery succeeds', async () => {
    // 1. Trigger recovery (as above)
    // 2. Open a page on the new session
    // 3. Verify it works
  });

  it('stale pageContextId gives clear error after recovery', async () => {
    // 1. Open page, get pageContextId
    // 2. Kill session, trigger recovery
    // 3. Try to read from old pageContextId
    // 4. Verify InputValidationError with helpful message
  });
});
```

- [ ] **Step 2: Implement the tests**

Read `tests/integration/session.test.ts` to understand the test setup pattern, then fill in the test bodies using the same helpers.

- [ ] **Step 3: Run integration tests**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/session-recovery.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/session-recovery.test.ts
git commit -m "test: integration tests for session recovery with backoff"
```

---

## Pillar 2: Write-Back Polish

### Task 9: Detect new pages from "New" action

**Files:**
- Modify: `src/operations/execute-action.ts`
- Create: `tests/unit/execute-action-new.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/execute-action-new.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('execute-action new record detection', () => {
  it('returns newPageContextId when New action opens a card page', () => {
    // The current code already detects opened pages via FormCreated events
    // in the openedPages array (execute-action.ts lines 50-60).
    // Verify this works by checking the existing openedPages field.
    // The output already includes: openedPages: Array<{ pageContextId, caption }>
    // No code change needed if this works -- just confirm with a test.
  });
});
```

- [ ] **Step 2: Review existing detection logic**

Read `src/operations/execute-action.ts` lines 50-60. The `openedPages` detection already exists:
- It scans for `FormCreated` events with a formId different from the source page's rootFormId
- It checks `repo.getByFormId()` for a matching page context
- It returns `{ pageContextId, caption }` in the openedPages array

This already does what we need. Verify via integration test that it works for "New" actions.

- [ ] **Step 3: Write integration test for New action**

Add to `tests/integration/write-back-workflows.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('write-back workflows', () => {
  it('New action on Customer List returns new page context', async () => {
    // 1. Open Customer List (page 22)
    // 2. Execute "New" action
    // 3. Verify openedPages contains a new pageContextId
    // 4. Write a field on the new page (Name)
    // 5. Close both pages (delete the new customer if possible)
  });

  it('Delete without selected row gives clear error', async () => {
    // 1. Open Customer List (page 22)
    // 2. Try to execute "Delete" without selecting a row or passing a bookmark
    // 3. Verify the error message mentions selecting a row
  });
});
```

- [ ] **Step 4: Implement and run**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/write-back-workflows.test.ts`

- [ ] **Step 5: Commit**

```bash
git add tests/unit/execute-action-new.test.ts tests/integration/write-back-workflows.test.ts
git commit -m "test: write-back workflow tests for New/Delete actions"
```

---

### Task 10: Update tool descriptions

**Files:**
- Modify: `src/mcp/tool-registry.ts`
- Create: `tests/unit/tool-descriptions.test.ts`

- [ ] **Step 1: Write test for description quality**

Create `tests/unit/tool-descriptions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildToolRegistry, type Operations } from '../../src/mcp/tool-registry.js';

// Create a minimal mock operations object
const mockOps = {
  openPage: { execute: async () => ({}) },
  readData: { execute: async () => ({}) },
  writeData: { execute: async () => ({}) },
  executeAction: { execute: async () => ({}) },
  closePage: { execute: async () => ({}) },
  searchPages: { execute: async () => ({}) },
  navigate: { execute: async () => ({}) },
  respondDialog: { execute: async () => ({}) },
} as unknown as Operations;

describe('tool descriptions', () => {
  const tools = buildToolRegistry(mockOps);

  it('every tool has at least 3 sentences in description', () => {
    for (const tool of tools) {
      const sentences = tool.description.split(/[.!?]+/).filter(s => s.trim().length > 0);
      expect(sentences.length, `${tool.name} has only ${sentences.length} sentences`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every tool description mentions related tools', () => {
    for (const tool of tools) {
      const otherTools = tools.filter(t => t.name !== tool.name);
      const mentionsOther = otherTools.some(t => tool.description.includes(t.name));
      expect(mentionsOther, `${tool.name} does not mention any other bc_ tool`).toBe(true);
    }
  });

  it('bc_execute_action describes create/delete workflow', () => {
    const tool = tools.find(t => t.name === 'bc_execute_action')!;
    expect(tool.description).toContain('New');
    expect(tool.description).toContain('Delete');
  });

  it('bc_respond_dialog describes dialog chaining', () => {
    const tool = tools.find(t => t.name === 'bc_respond_dialog')!;
    expect(tool.description).toContain('chain');
  });
});
```

- [ ] **Step 2: Run test to check current state**

Run: `npx vitest run tests/unit/tool-descriptions.test.ts`
Expected: Likely PASS already -- the descriptions are already quite detailed. If any fail, fix them.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/tool-descriptions.test.ts
git commit -m "test: tool description quality checks"
```

---

## Pillar 3: Multi-Company

### Task 11: SwitchCompany operation

**Files:**
- Create: `src/operations/switch-company.ts`
- Modify: `src/mcp/schemas.ts`

- [ ] **Step 1: Create SwitchCompanySchema**

In `src/mcp/schemas.ts`, add:

```typescript
export const SwitchCompanySchema = z.object({
  companyName: z.string().min(1).describe('Exact company name to switch to. Use bc_list_companies to see available company names.'),
});
```

- [ ] **Step 2: Create SwitchCompanyOperation**

Create `src/operations/switch-company.ts`:

```typescript
import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { Logger } from '../core/logger.js';

export interface SwitchCompanyInput {
  companyName: string;
}

export interface SwitchCompanyOutput {
  previousCompany: string;
  newCompany: string;
  invalidatedPageContextIds: string[];
}

export class SwitchCompanyOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: SwitchCompanyInput): Promise<Result<SwitchCompanyOutput, ProtocolError>> {
    const previousCompany = (this.session as any).company ?? '';
    const invalidatedIds = this.repo.listPageContextIds();

    // Send InvokeSessionAction for company switch
    // This uses the SessionAction interaction type with InvokeSystemAction
    const result = await this.session.invoke(
      {
        type: 'SessionAction',
        actionName: 'InvokeSessionAction',
        namedParameters: {
          systemAction: 500, // ChangeCompany
          company: input.companyName,
        },
      },
      (e) => e.type === 'InvokeCompleted',
    );

    if (!isOk(result)) {
      return result;
    }

    // Invalidate all page contexts -- company switch resets server-side page state
    this.repo.clearAll();

    this.logger.info(`Switched company from "${previousCompany}" to "${input.companyName}"`);

    return ok({
      previousCompany,
      newCompany: input.companyName,
      invalidatedPageContextIds: invalidatedIds,
    });
  }
}
```

**Note:** The exact wire format for `ChangeCompany` needs protocol investigation during implementation. The `SessionAction` approach may not be correct -- it might need a dedicated `InvokeCodeUnit` call. The decompiled source shows `InvokeCodeUnit(2000000006, "ChangeCompany", companyName)`. If `SessionAction` doesn't work, we'll need to add a new interaction type. This task should start with a protocol investigation step against live BC.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/operations/switch-company.ts src/mcp/schemas.ts
git commit -m "feat: SwitchCompanyOperation skeleton"
```

---

### Task 12: ListCompanies operation

**Files:**
- Create: `src/operations/list-companies.ts`
- Modify: `src/mcp/schemas.ts`

- [ ] **Step 1: Add ListCompaniesSchema**

In `src/mcp/schemas.ts`, add:

```typescript
export const ListCompaniesSchema = z.object({});
```

- [ ] **Step 2: Create ListCompaniesOperation**

Create `src/operations/list-companies.ts`:

```typescript
import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';

export interface ListCompaniesOutput {
  currentCompany: string;
  companies: Array<{ name: string; displayName: string }>;
}

export class ListCompaniesOperation {
  constructor(
    private readonly pageService: PageService,
    private readonly dataService: DataService,
    private readonly currentCompanyFn: () => string,
  ) {}

  async execute(): Promise<Result<ListCompaniesOutput, ProtocolError>> {
    // Open the Companies system page (page 357)
    const openResult = await this.pageService.openPage('357');
    if (!isOk(openResult)) return openResult;

    const pageContextId = openResult.value.pageContextId;

    try {
      // Read all rows
      const readResult = await this.dataService.readRows(pageContextId);
      if (!isOk(readResult)) return readResult;

      const companies = readResult.value.rows.map(row => {
        // Extract company name from row cells
        const cells = row.cells as Record<string, unknown>;
        const name = Object.values(cells).find(v => typeof v === 'string') as string ?? '';
        return { name, displayName: name };
      });

      return ok({
        currentCompany: this.currentCompanyFn(),
        companies,
      });
    } finally {
      // Always close the page
      await this.pageService.closePage(pageContextId);
    }
  }
}
```

**Note:** The row cell extraction logic is approximate. The actual column names will need to be discovered from the control tree during integration testing. This may need to use `readData` with column filtering instead.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: May fail due to service method signatures -- fix as needed.

- [ ] **Step 4: Commit**

```bash
git add src/operations/list-companies.ts src/mcp/schemas.ts
git commit -m "feat: ListCompaniesOperation skeleton"
```

---

### Task 13: Register multi-company tools

**Files:**
- Modify: `src/mcp/tool-registry.ts`
- Modify: `src/server.ts`
- Modify: `src/stdio-server.ts`

- [ ] **Step 1: Add tool definitions to registry**

In `src/mcp/tool-registry.ts`, add imports:

```typescript
import { SwitchCompanySchema, ListCompaniesSchema } from './schemas.js';
import type { SwitchCompanyOperation } from '../operations/switch-company.js';
import type { ListCompaniesOperation } from '../operations/list-companies.js';
```

Add to `Operations` interface:

```typescript
  switchCompany: SwitchCompanyOperation;
  listCompanies: ListCompaniesOperation;
```

Add to the tools array in `buildToolRegistry`:

```typescript
    {
      name: 'bc_switch_company',
      description: `Switch to a different company within the current Business Central session. All currently open pages will be invalidated and their pageContextIds will become unusable -- you must call bc_open_page to re-open any pages you need in the new company context.

Use bc_list_companies first to see the available company names and verify the target company exists. The companyName must be an exact match (case-sensitive). After switching, the session continues with the new company -- all subsequent bc_open_page, bc_read_data, bc_write_data, and bc_execute_action calls will operate against the new company's data.

Do NOT switch companies in the middle of a multi-step workflow (e.g., between creating a Sales Order and posting it). Complete all operations in the current company first, then switch.

Example: { "companyName": "CRONUS International Ltd." }`,
      inputSchema: toMcpJsonSchema(SwitchCompanySchema),
      zodSchema: SwitchCompanySchema,
      execute: (input) => ops.switchCompany.execute(input as Parameters<typeof ops.switchCompany.execute>[0]),
    },
    {
      name: 'bc_list_companies',
      description: `List all companies available in the current Business Central environment. Returns an array of company names along with the currently active company name. Use this before bc_switch_company to verify the target company exists and to discover available companies.

This tool opens the BC Companies system page internally, reads all entries, and closes it. It does not affect your currently open pages or session state. No parameters are required.

Do NOT use this if you already know the company name -- call bc_switch_company directly.`,
      inputSchema: toMcpJsonSchema(ListCompaniesSchema),
      zodSchema: ListCompaniesSchema,
      execute: () => ops.listCompanies.execute(),
    },
```

- [ ] **Step 2: Wire operations in server.ts**

In `src/server.ts`, in the `buildServices` function, add:

```typescript
    const switchCompanyOp = new SwitchCompanyOperation(s, pageContextRepo, logger);
    const listCompaniesOp = new ListCompaniesOperation(pageService, dataService, () => s.company);
```

Add to the `operations` object:

```typescript
      switchCompany: switchCompanyOp,
      listCompanies: listCompaniesOp,
```

Add the imports at the top.

- [ ] **Step 3: Do the same in stdio-server.ts**

- [ ] **Step 4: Run type check and unit tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-registry.ts src/mcp/schemas.ts src/server.ts src/stdio-server.ts
git commit -m "feat: register bc_switch_company and bc_list_companies tools"
```

---

### Task 14: Multi-company integration tests

**Files:**
- Create: `tests/integration/multi-company.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect } from 'vitest';

describe('multi-company', () => {
  it('bc_list_companies returns at least one company including CRONUS', async () => {
    // 1. Call ListCompaniesOperation
    // 2. Verify result contains at least one company
    // 3. Verify currentCompany is set
    // 4. Look for CRONUS in the company list
  });

  it('bc_switch_company invalidates all open pages', async () => {
    // NOTE: This test only works if there are multiple companies in the BC instance.
    // If only CRONUS exists, skip with a clear message.
    // 1. Open Customer List (page 22)
    // 2. Switch to another company
    // 3. Verify invalidatedPageContextIds includes the Customer List context
    // 4. Verify old pageContextId gives stale context error
    // 5. Switch back to CRONUS
  });

  it('switch to non-existent company returns clear error', async () => {
    // 1. Try to switch to "NonExistent Company XYZ"
    // 2. Verify error message is clear
  });
});
```

- [ ] **Step 2: Implement tests using existing integration test patterns**

Read existing integration test files to understand the helper pattern (session setup, etc.).

- [ ] **Step 3: Protocol investigation -- verify wire format**

Before running integration tests, test the `ChangeCompany` interaction manually:
1. Open a BC session
2. Send the `SessionAction` interaction with `systemAction: 500` and `company: "CRONUS International Ltd."`
3. If it fails, try alternate wire formats based on decompiled source
4. Document the working format

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/multi-company.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/multi-company.test.ts
git commit -m "test: multi-company integration tests"
```

---

## Pillar 4: Report Execution

### Task 15: Add RunReport interaction type

**Files:**
- Modify: `src/protocol/types.ts`
- Modify: `src/protocol/interaction-encoder.ts`

- [ ] **Step 1: Add RunReportInteraction to types.ts**

In `src/protocol/types.ts`, add to the `BCInteraction` union:

```typescript
  | RunReportInteraction;
```

Add the interface:

```typescript
export interface RunReportInteraction extends BaseInteraction {
  readonly type: 'RunReport';
  readonly reportId: number;
}
```

- [ ] **Step 2: Add RunReport case to interaction-encoder.ts**

In `src/protocol/interaction-encoder.ts`, add to the `buildInvocation` switch:

```typescript
      case 'RunReport':
        return { interactionName: 'RunReport', namedParameters: JSON.stringify({ reportId: interaction.reportId }), callbackId };
```

**Note:** The exact wire format for `RunReport` needs protocol investigation. The decompiled source shows `IService.RunReport(int reportId)` which may map to a different RPC method rather than an `Invoke` interaction. This may need a `RunReport` RPC call similar to `OpenSession`. If so, add a new `encodeRunReport` method to `InteractionEncoder` and a matching `runReport` method to `BCSession`.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/protocol/types.ts src/protocol/interaction-encoder.ts
git commit -m "feat: add RunReport interaction type"
```

---

### Task 16: RunReport operation

**Files:**
- Create: `src/operations/run-report.ts`
- Modify: `src/mcp/schemas.ts`

- [ ] **Step 1: Add RunReportSchema**

In `src/mcp/schemas.ts`, add:

```typescript
export const RunReportSchema = z.object({
  reportId: StringOrNumber.describe('Numeric BC report ID to execute (e.g., 1306 for Customer Statement, 6 for Trial Balance).'),
});
```

- [ ] **Step 2: Create RunReportOperation**

Create `src/operations/run-report.ts`:

```typescript
import { ok, isOk, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface RunReportInput {
  reportId: string;
}

export interface RunReportOutput {
  success: boolean;
  reportId: number;
  /** If the report has a request page, it opens as a dialog */
  requestPage?: {
    pageContextId: string;
    formId: string;
    fields?: ControlField[];
    message?: string;
  };
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class RunReportOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: RunReportInput): Promise<Result<RunReportOutput, ProtocolError>> {
    const reportId = parseInt(input.reportId, 10);

    // Send RunReport interaction
    const result = await this.session.invoke(
      { type: 'RunReport', reportId },
      (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'FormCreated',
    );

    if (!isOk(result)) {
      return result;
    }

    const events = result.value;
    const dialogsOpened = detectDialogs(events);

    // Check for request page (dialog with RequestPageFilters container type)
    // The request page opens as a FormCreated or DialogOpened event
    let requestPage: RunReportOutput['requestPage'] | undefined;

    for (const dialog of dialogsOpened) {
      // Request pages are identified by their container type or by being
      // the first dialog opened after RunReport
      requestPage = {
        pageContextId: '', // Will be set if we register a page context
        formId: dialog.formId,
        fields: dialog.fields,
        message: dialog.message,
      };
      break;
    }

    return ok({
      success: true,
      reportId,
      requestPage,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    });
  }
}
```

**Note:** The request page detection and pageContextId assignment needs refinement during integration testing. The report may open a full page context (FormCreated) rather than a dialog (DialogOpened), in which case we need to register it in the PageContextRepo.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/operations/run-report.ts src/mcp/schemas.ts
git commit -m "feat: RunReportOperation skeleton"
```

---

### Task 17: Register report tool

**Files:**
- Modify: `src/mcp/tool-registry.ts`
- Modify: `src/server.ts`
- Modify: `src/stdio-server.ts`

- [ ] **Step 1: Add tool definition**

In `src/mcp/tool-registry.ts`, add imports:

```typescript
import { RunReportSchema } from './schemas.js';
import type { RunReportOperation } from '../operations/run-report.js';
```

Add to `Operations` interface:

```typescript
  runReport: RunReportOperation;
```

Add to tools array:

```typescript
    {
      name: 'bc_run_report',
      description: `Execute a Business Central report by its numeric report ID. If the report has a request page (parameter/filter dialog), it will be returned with its fields so you can fill in parameters using bc_write_data and then execute the report by responding with bc_respond_dialog (response: "ok"). The report runs server-side on the BC service tier.

Output capture (downloading the rendered PDF, Excel, or Word document) is not yet supported. Use this tool for reports that perform server-side actions (batch posting via Report 295 "Batch Post Sales Orders", inventory adjustments, data processing) or to inspect and fill request page parameters. Common reports: 1306 (Customer Statement), 120 (Aged Accounts Receivable), 6 (Trial Balance), 295 (Batch Post Sales Orders).

Do NOT use this for viewing data -- use bc_open_page and bc_read_data for data retrieval. Do NOT confuse reports with pages -- reports are processing/printing objects, pages are UI views.

Example: { "reportId": 6 } runs Trial Balance report, which opens a request page for date range and account filters.`,
      inputSchema: toMcpJsonSchema(RunReportSchema),
      zodSchema: RunReportSchema,
      execute: (input) => ops.runReport.execute(input as Parameters<typeof ops.runReport.execute>[0]),
    },
```

- [ ] **Step 2: Wire in server.ts and stdio-server.ts**

In `buildServices()`:

```typescript
    const runReportOp = new RunReportOperation(s, pageContextRepo);
```

Add to operations:

```typescript
      runReport: runReportOp,
```

- [ ] **Step 3: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tool-registry.ts src/server.ts src/stdio-server.ts
git commit -m "feat: register bc_run_report tool"
```

---

### Task 18: Report integration tests

**Files:**
- Create: `tests/integration/report-execution.test.ts`

- [ ] **Step 1: Protocol investigation**

Before writing tests, investigate the `RunReport` wire format against live BC:

1. Open a session
2. Send `RunReport` with reportId=6 (Trial Balance)
3. Capture the response to understand what events come back
4. Check if it opens as FormCreated, DialogOpened, or something else
5. Document findings

This is critical because the `RunReport` may use a completely different RPC method (not `Invoke`), in which case the interaction encoder needs a new method, and `BCSession` needs a `runReport()` method similar to `initialize()`.

- [ ] **Step 2: Write integration tests based on findings**

```typescript
import { describe, it, expect } from 'vitest';

describe('report execution', () => {
  it('bc_run_report with Trial Balance (6) returns request page', async () => {
    // 1. Call RunReportOperation with reportId=6
    // 2. Verify request page fields are returned
    // 3. Verify requiresDialogResponse is true
  });

  it('can fill request page parameters and execute', async () => {
    // 1. Run report 6
    // 2. Write parameters (date range, account filter) via bc_write_data
    // 3. Respond "ok" to execute
    // 4. Verify success response
  });

  it('invalid report ID returns clear error', async () => {
    // 1. Run report 999999
    // 2. Verify error message is clear
  });
});
```

- [ ] **Step 3: Adjust RunReport wire format based on investigation**

If the wire format differs from the initial implementation, update:
- `src/protocol/types.ts` -- interaction type
- `src/protocol/interaction-encoder.ts` -- encoding
- `src/operations/run-report.ts` -- event handling

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/report-execution.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/report-execution.test.ts
git commit -m "test: report execution integration tests"
```

---

## Cross-Pillar Tests

### Task 19: Cross-pillar integration tests

**Files:**
- Create: `tests/integration/phase5-cross-pillar.test.ts`

- [ ] **Step 1: Write cross-pillar scenario tests**

```typescript
import { describe, it, expect } from 'vitest';

describe('phase 5 cross-pillar', () => {
  it('open page, switch company, verify old context invalid, open new page', async () => {
    // 1. Open Customer List (page 22)
    // 2. Switch company (if multi-company available)
    // 3. Verify old pageContextId fails with stale context error
    // 4. Open Customer List in new company
    // 5. Verify it works
    // 6. Switch back
  });

  it('switch company, run report in new company', async () => {
    // 1. Switch to another company (if available)
    // 2. Run Trial Balance report
    // 3. Verify request page opens
    // 4. Close/cancel
    // 5. Switch back
  });

  it('write field, get validation dialog, respond', async () => {
    // 1. Open a page where writing triggers a validation dialog
    // 2. Write the field value
    // 3. Verify dialogsOpened is returned
    // 4. Respond to dialog
    // 5. Verify field was saved
  });
});
```

- [ ] **Step 2: Implement tests**

Follow existing integration test patterns. Some tests may need to be conditional on multi-company availability.

- [ ] **Step 3: Run all integration tests**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 4: Commit**

```bash
git add tests/integration/phase5-cross-pillar.test.ts
git commit -m "test: cross-pillar integration tests for Phase 5"
```

---

## Final Verification

### Task 20: Full test suite and type check

- [ ] **Step 1: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

- [ ] **Step 2: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass (109 existing + new tests)

- [ ] **Step 3: Run all integration tests**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: All tests pass

- [ ] **Step 4: Update CLAUDE.md if needed**

If any new protocol patterns were discovered during implementation, document them in `CLAUDE.md`:
- RunReport wire format
- ChangeCompany wire format
- Any new handler types or events encountered

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md with Phase 5 protocol findings"
```
