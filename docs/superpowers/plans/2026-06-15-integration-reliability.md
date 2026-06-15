# Integration Test Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live-BC integration suite pass green back-to-back deterministically by killing the session-death cascade (undrained invoke queue + shared poisoned NTLM auth slot).

**Architecture:** Three deliverables. (0) An idempotent PowerShell script provisions a 3-user SUPER pool on the `Cronus28` container via bccontainerhelper. (1) `BCSession` gains a dead-guard at the top of `invokeUnqueued` so queued invokes fast-fail instead of each eating a 30s timeout. (2) A new `IntegrationSessionPool` becomes the single session source for every integration file, rotating users with a post-poison cooldown, run single-process serial so the singleton is shared.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, bccontainerhelper 6.1.15 (PowerShell 7), real BC28 (`Cronus28` container, `http://cronus28/BC`, NavUserPassword).

**Spec:** `docs/superpowers/specs/2026-06-15-integration-reliability-design.md`

---

## File Structure

- Create: `scripts/provision-test-users.ps1` — idempotent BC user provisioning (Deliverable 0).
- Create: `tests/integration/helpers/session-pool.ts` — `IntegrationSessionPool` class + configured `integrationPool` singleton (Deliverable 2).
- Create: `tests/unit/integration-session-pool.test.ts` — pool rotation/cooldown unit tests (no live BC).
- Create: `tests/unit/drain-on-death.test.ts` — drain-on-death unit test (no live BC).
- Modify: `src/session/bc-session.ts` — add dead-guard at top of `invokeUnqueued` (Deliverable 1).
- Modify: `vitest.integration.config.ts` — force single-process serial execution.
- Modify: all `tests/integration/*.test.ts` (~18 files) — replace bespoke `beforeAll`/`afterAll` session construction with the pool; remove hardcoded/BC27 configs.

---

## Task 1: Drain-on-death guard in BCSession

**Files:**
- Modify: `src/session/bc-session.ts:162` (top of `invokeUnqueued`)
- Test: `tests/unit/drain-on-death.test.ts`

Background: `invoke()` (line 122) already fast-fails when `this.dead`, but that guard is
checked when `invoke()` is *called*. Invokes already enqueued before death run their
closure `() => this.invokeUnqueued(...)` later, bypassing that guard, so each reaches
`ws.sendRpc` and waits the full timeout. The queue is serial, so a guard at the top of
`invokeUnqueued` makes every subsequent queued task return instantly once `this.dead` is set.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/drain-on-death.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../../src/protocol/types.js';

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}
function createMockDecoder() {
  return { decode: vi.fn(() => [] as BCEvent[]) } as unknown as EventDecoder;
}

const dummyInteraction: BCInteraction = { type: 'InvokeAction', formId: '1', controlPath: 'server:', systemAction: 30 };
const dummyExpect: EventPredicate = () => true;

describe('BCSession drain-on-death', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fast-fails queued invokes after the session is marked dead, without calling sendRpc', async () => {
    const sendRpc = vi.fn((): Promise<any> => Promise.resolve(ok([])));
    const ws = {
      isConnected: true, spaInstanceId: 'spa-test', nextSequenceNo: 1, lastClientAckSequenceNumber: 0,
      sendRpc, onMessage: vi.fn(() => () => {}), close: vi.fn(),
    };
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    // Mark dead, then attempt an invoke that would otherwise dispatch.
    session.markDead();
    const result = await session.invoke(dummyInteraction, dummyExpect);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Session is dead');
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('drains invokes enqueued before death is detected mid-flight', async () => {
    // First invoke triggers death (sendRpc returns InvalidSessionException);
    // a second invoke enqueued right behind it must fast-fail without its own sendRpc.
    let call = 0;
    const sendRpc = vi.fn((): Promise<any> => {
      call += 1;
      if (call === 1) return Promise.resolve({ ok: false, error: new Error('InvalidSessionException') });
      return Promise.resolve(ok([]));
    });
    const ws = {
      isConnected: true, spaInstanceId: 'spa-test', nextSequenceNo: 1, lastClientAckSequenceNumber: 0,
      sendRpc, onMessage: vi.fn(() => () => {}), close: vi.fn(),
    };
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const p1 = session.invoke(dummyInteraction, dummyExpect);
    const p2 = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(200); // quiescence window for the first invoke

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.ok).toBe(false); // first invoke surfaced the InvalidSessionException
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.message).toContain('Session is dead');
    expect(sendRpc).toHaveBeenCalledTimes(1); // second invoke never dispatched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/drain-on-death.test.ts`
Expected: the second test FAILS — `sendRpc` is called twice (the second invoke dispatches) because there is no dead-guard in `invokeUnqueued` yet.

- [ ] **Step 3: Add the dead-guard**

In `src/session/bc-session.ts`, at the very top of `invokeUnqueued` (currently line 162-167, right after the signature `): Promise<Result<BCEvent[], ProtocolError>> {`), insert before `const callbackId = uuid();`:

```typescript
    // Drain-on-death: once the session is dead, every queued invoke fast-fails
    // here instead of reaching ws.sendRpc and eating a full timeout. The queue is
    // serial, so the task that detects death (markDead) is immediately followed by
    // the remaining queued tasks, each short-circuiting through this guard.
    if (this.dead) {
      return err(new ProtocolError('Session is dead'));
    }
```

(`err` and `ProtocolError` are already imported at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/drain-on-death.test.ts`
Expected: PASS (both tests). `sendRpc` called exactly once in the mid-flight test.

- [ ] **Step 5: Verify no regression in the existing timeout test**

Run: `npx vitest run tests/unit/invoke-timeout.test.ts`
Expected: PASS (4 tests) — the guard does not affect the not-dead paths.

- [ ] **Step 6: Commit**

```bash
git add src/session/bc-session.ts tests/unit/drain-on-death.test.ts
git commit -m "fix: drain queued invokes on session death instead of timing out each"
```

---

## Task 2: Test-user provisioning script

**Files:**
- Create: `scripts/provision-test-users.ps1`

This is a PowerShell setup artifact (not TS, no vitest). Verification is running it and
inspecting the container. It must be idempotent.

- [ ] **Step 1: Write the script**

Create `scripts/provision-test-users.ps1`:

```powershell
#requires -Version 7
# Provisions the integration-test user pool on the Cronus28 BC container.
# Idempotent: existing users are skipped. Safe to re-run.
#
# Usage:  pwsh ./scripts/provision-test-users.ps1
# Requires: bccontainerhelper module, Cronus28 container running.

$ErrorActionPreference = 'Stop'

$ContainerName = 'Cronus28'
$Tenant        = 'default'
$Password      = '1234'
$Users         = @('sshadows', 'bcmcp_test1', 'bcmcp_test2')

Import-Module bccontainerhelper -DisableNameChecking

$securePwd = ConvertTo-SecureString $Password -AsPlainText -Force
$existing  = Get-BcContainerBcUser -containerName $ContainerName -tenant $Tenant

foreach ($name in $Users) {
    $already = $existing | Where-Object { $_.UserName -ieq $name }
    if ($already) {
        Write-Host "[skip] user '$name' already exists"
        continue
    }
    Write-Host "[create] user '$name' (SUPER)"
    $cred = New-Object System.Management.Automation.PSCredential($name, $securePwd)
    New-BcContainerBcUser -containerName $ContainerName -tenant $Tenant `
        -Credential $cred `
        -PermissionSetId 'SUPER' `
        -ChangePasswordAtNextLogOn $false `
        -assignPremiumPlan
}

Write-Host ''
Write-Host 'Pool users present on Cronus28:'
Get-BcContainerBcUser -containerName $ContainerName -tenant $Tenant |
    Where-Object { $_.UserName -in $Users } |
    Select-Object UserName, State, LicenseType | Format-Table -AutoSize
```

- [ ] **Step 2: Run the script (first run — creates users)**

Run: `pwsh ./scripts/provision-test-users.ps1`
Expected: `sshadows` reported `[skip]` (already exists); `bcmcp_test1` and `bcmcp_test2`
reported `[create]`; final table lists all three with `State = Enabled`.

- [ ] **Step 3: Run the script again (idempotency check)**

Run: `pwsh ./scripts/provision-test-users.ps1`
Expected: all three reported `[skip]`; final table still lists all three. No errors.

- [ ] **Step 4: Sanity-check one new user can authenticate**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -u bcmcp_test1:1234 "http://cronus28/BC/?tenant=default"
```
Expected: `200` (or a redirect 3xx) — not `401`.

- [ ] **Step 5: Commit**

```bash
git add scripts/provision-test-users.ps1
git commit -m "test: add idempotent Cronus28 test-user provisioning script"
```

---

## Task 3: IntegrationSessionPool helper + unit tests

**Files:**
- Create: `tests/integration/helpers/session-pool.ts`
- Test: `tests/unit/integration-session-pool.test.ts`

The pool is injected with a `buildSession(user)` function so rotation/cooldown logic is
unit-testable without live BC. The real configured singleton wires `buildSession` to the
NTLM → connection → session-factory stack against Cronus28.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/integration-session-pool.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntegrationSessionPool } from '../../tests/integration/helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';

// Minimal fake session: only isAlive + closeGracefully are touched by the pool.
function fakeSession(): BCSession {
  return {
    isAlive: true,
    closeGracefully: vi.fn(async () => {}),
  } as unknown as BCSession;
}

describe('IntegrationSessionPool', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('round-robins users across clean check-out / check-in cycles', async () => {
    const handed: string[] = [];
    const pool = new IntegrationSessionPool({
      users: ['u1', 'u2', 'u3'],
      cooldownMs: 15000,
      buildSession: async (user) => { handed.push(user); return fakeSession(); },
    });

    for (let i = 0; i < 3; i++) {
      const lease = await pool.checkOut();
      await pool.checkIn(lease, { poisoned: false });
    }

    expect(handed).toEqual(['u1', 'u2', 'u3']);
  });

  it('does not reissue a poisoned user within the cooldown window', async () => {
    const handed: string[] = [];
    const pool = new IntegrationSessionPool({
      users: ['u1', 'u2'],
      cooldownMs: 15000,
      buildSession: async (user) => { handed.push(user); return fakeSession(); },
    });

    const lease1 = await pool.checkOut();          // u1
    await pool.checkIn(lease1, { poisoned: true }); // u1 now cooling for 15s

    const lease2 = await pool.checkOut();           // must be u2, not u1
    expect(lease2.user).toBe('u2');
    await pool.checkIn(lease2, { poisoned: false });

    const lease3 = await pool.checkOut();           // u1 still cooling -> u2 again
    expect(lease3.user).toBe('u2');
  });

  it('awaits the soonest cooldown when all users are cooling', async () => {
    const pool = new IntegrationSessionPool({
      users: ['u1'],
      cooldownMs: 15000,
      buildSession: async () => fakeSession(),
    });

    const lease1 = await pool.checkOut();
    await pool.checkIn(lease1, { poisoned: true }); // u1 cooling until +15s

    const pending = pool.checkOut();                 // should block until cooldown elapses
    let resolved = false;
    void pending.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(14000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);         // past 15s total
    const lease2 = await pending;
    expect(lease2.user).toBe('u1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/integration-session-pool.test.ts`
Expected: FAIL — module `tests/integration/helpers/session-pool.ts` does not exist.

- [ ] **Step 3: Implement the pool**

Create `tests/integration/helpers/session-pool.ts`:

```typescript
import { createNullLogger } from '../../../src/core/logger.js';
import { NTLMAuthProvider } from '../../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../../src/connection/connection-factory.js';
import { EventDecoder } from '../../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../../../src/session/session-factory.js';
import { unwrap } from '../../../src/core/result.js';
import type { BCConfig } from '../../../src/core/config.js';
import type { BCSession } from '../../../src/session/bc-session.js';

export interface PooledLease {
  session: BCSession;
  user: string;
}

interface PoolOptions {
  users: string[];
  cooldownMs: number;
  buildSession: (user: string) => Promise<BCSession>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class IntegrationSessionPool {
  private readonly users: string[];
  private readonly cooldownMs: number;
  private readonly buildSession: (user: string) => Promise<BCSession>;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly inUse = new Set<string>();
  private rrIndex = 0;

  constructor(opts: PoolOptions) {
    this.users = [...opts.users];
    this.cooldownMs = opts.cooldownMs;
    this.buildSession = opts.buildSession;
  }

  async checkOut(): Promise<PooledLease> {
    const user = await this.acquireUser();
    this.inUse.add(user);
    const session = await this.buildSession(user);
    return { session, user };
  }

  async checkIn(lease: PooledLease, opts: { poisoned: boolean }): Promise<void> {
    try {
      await lease.session.closeGracefully();
    } catch {
      // best effort — a dead session may already be torn down
    }
    if (opts.poisoned) {
      this.cooldownUntil.set(lease.user, Date.now() + this.cooldownMs);
    }
    this.inUse.delete(lease.user);
  }

  private async acquireUser(): Promise<string> {
    // Loop until a user is free and cool.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      // Prefer a free, cool user via round-robin.
      for (let i = 0; i < this.users.length; i++) {
        const idx = (this.rrIndex + i) % this.users.length;
        const candidate = this.users[idx]!;
        const coolAt = this.cooldownUntil.get(candidate) ?? 0;
        if (!this.inUse.has(candidate) && coolAt <= now) {
          this.rrIndex = (idx + 1) % this.users.length;
          return candidate;
        }
      }
      // None ready: wait until the soonest cooldown of a not-in-use user elapses.
      const waits = this.users
        .filter(u => !this.inUse.has(u))
        .map(u => (this.cooldownUntil.get(u) ?? 0) - now)
        .filter(w => w > 0);
      const wait = waits.length > 0 ? Math.min(...waits) : 10;
      await sleep(wait);
    }
  }
}

// ---- Configured singleton for integration tests (real Cronus28 sessions) ----

const CRONUS28: BCConfig = {
  baseUrl: 'http://cronus28/BC',
  username: 'sshadows',          // overridden per-slot below
  password: process.env.BC_TEST_PASSWORD ?? '1234',
  tenantId: 'default',
  profile: '',
  applicationId: process.env.BC_APPLICATION_ID ?? 'FIN',
  clientVersionString: '28.0.0.0',
  serverMajor: 28,
  timeoutMs: 120000,
  invokeTimeoutMs: 30000,
  reconnectMaxRetries: 4,
  reconnectBaseDelayMs: 1000,
};

const POOL_USERS = (process.env.BC_TEST_USERS ?? 'sshadows,bcmcp_test1,bcmcp_test2')
  .split(',').map(s => s.trim()).filter(Boolean);

async function buildCronus28Session(user: string): Promise<BCSession> {
  const logger = createNullLogger();
  const cfg: BCConfig = { ...CRONUS28, username: user };
  const auth = new NTLMAuthProvider({
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    password: cfg.password,
    tenantId: cfg.tenantId,
  }, logger);
  const connFactory = new ConnectionFactory(auth, cfg, logger);
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(cfg.clientVersionString, cfg.applicationId);
  const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, cfg.tenantId);
  return unwrap(await sessionFactory.create());
}

export const integrationPool = new IntegrationSessionPool({
  users: POOL_USERS,
  cooldownMs: 16000, // > BC's ~15s NTLM hold
  buildSession: buildCronus28Session,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/integration-session-pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/helpers/session-pool.ts tests/unit/integration-session-pool.test.ts
git commit -m "test: add IntegrationSessionPool with user rotation and cooldown"
```

---

## Task 4: Force integration suite single-process serial

**Files:**
- Modify: `vitest.integration.config.ts`

The pool singleton must be shared across all integration files, so they must run in one
process. vitest isolates files in separate workers by default; disable that.

- [ ] **Step 1: Update the config**

Replace the contents of `vitest.integration.config.ts` with:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/phase4-destructive.test.ts'],
    // Single process, serial: the IntegrationSessionPool singleton is shared
    // across files, and BC's wire protocol is stateful (one session at a time).
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 2: Verify the config loads and tests still collect**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/bc28.test.ts`
Expected: PASS (4 tests) — config is valid and a single file still runs against Cronus28.
(`bc28.test.ts` is not yet migrated to the pool; this only proves the config change is sound.)

- [ ] **Step 3: Commit**

```bash
git add vitest.integration.config.ts
git commit -m "test: run integration suite single-process serial for shared session pool"
```

---

## Task 5: Migrate all integration files to the pool

**Files (modify each):**
`advanced-workflows.test.ts`, `bc28.test.ts`, `connection.test.ts`, `data-service.test.ts`,
`document-and-bc28.test.ts`, `edge-cases.test.ts`, `mcp-endpoint.test.ts`,
`modal-recovery.test.ts`, `multi-section.test.ts`, `page-service.test.ts`,
`phase3-features.test.ts`, `phase3-workflows.test.ts`, `phase4-features.test.ts`,
`phase5-features.test.ts`, `role-center.test.ts`, `search-pages.test.ts`,
`session.test.ts`, `workflow-smoke.test.ts` (all under `tests/integration/`).

> `phase4-destructive.test.ts` is excluded from the suite (see config) — migrate it too for
> consistency but it will not run in the acceptance check.

**The recipe (apply per file):**

Each file currently builds a session in `beforeAll` via some variant of:
```typescript
const appConfig = loadConfig();
const auth = new NTLMAuthProvider({ ... }, logger);
const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
const decoder = new EventDecoder();
const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);
session = unwrap(await sessionFactory.create());
```
and tears down in `afterAll` with `await session?.closeGracefully().catch(() => {})`.

Replace that construction with a pool lease, and the teardown with a check-in.

- [ ] **Step 1: Add the pool import** (top of each file, with the other imports)

```typescript
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
```

- [ ] **Step 2: Replace the `beforeAll` session construction**

Remove the auth/connFactory/decoder/encoder/sessionFactory/create lines. Keep the
service construction that follows (`new PageService(session, ...)` etc.). Introduce a
`lease` variable alongside the existing `let session: BCSession;`:

```typescript
let lease: PooledLease;
// ...
beforeAll(async () => {
  lease = await integrationPool.checkOut();
  session = lease.session;

  const repo = new PageContextRepository();
  pageService = new PageService(session, repo, logger);
  dataService = new DataService(session, repo, logger);
  // ...keep whatever services this file built before...
});
```

Delete now-unused imports per file (e.g. `loadConfig`, `NTLMAuthProvider`,
`ConnectionFactory`, `SessionFactory`, `dotenvConfig`, `InteractionEncoder` if only used
for construction). Leave imports that the test bodies still use.

- [ ] **Step 3: Replace the `afterAll` teardown**

```typescript
afterAll(async () => {
  if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
});
```

- [ ] **Step 4: Handle the three files with hardcoded second configs**

These have an extra `describe` block with its own inline `BC28_CONFIG`/`bc28Config`
literal and second `beforeAll`:
- `bc28.test.ts:17-43` (`BC28_CONFIG`)
- `multi-section.test.ts:362-378` (`bc28Config`)
- `document-and-bc28.test.ts:497-529` (`BC28_CONFIG`)

For each, apply the same pool recipe to the second `beforeAll`, and delete the inline
config literal. The pool already targets Cronus28, so the separate "BC28" describe just
becomes another pool consumer. In `document-and-bc28.test.ts`, also remove the
"Is the Cronus28 container running?" skip logging tied to the old construction (line ~535)
— the pool's `checkOut` will throw clearly if the container is down.

- [ ] **Step 5: Remove the stale BC27 reference**

In `phase3-workflows.test.ts:5`, update the file-header comment that says
"These tests run against real BC27 at http://cronus27/BC." to "against real BC28 (Cronus28)
via the shared integration session pool."

- [ ] **Step 6: Migrate `mcp-endpoint.test.ts` if it constructs a session**

`mcp-endpoint.test.ts` spawns an HTTP server on port 3456 rather than building a session
directly. If it does NOT call `SessionFactory.create()`, leave its session handling alone
(only ensure it still runs serially). If it does, apply the recipe. Inspect before editing.

- [ ] **Step 7: Type/collect sanity per batch**

After migrating a batch of ~5 files, run that batch to catch import/typo errors early:
```bash
npx vitest run --config vitest.integration.config.ts tests/integration/data-service.test.ts tests/integration/page-service.test.ts tests/integration/session.test.ts
```
Expected: PASS. Fix any unused-import or reference errors before continuing.

- [ ] **Step 8: Commit (in 2-3 logical batches)**

```bash
git add tests/integration/<batch files>
git commit -m "test: migrate integration files to shared session pool (batch N)"
```

---

## Task 6: Acceptance — green back-to-back

**Files:** none (verification only)

- [ ] **Step 1: Ensure pool users exist**

Run: `pwsh ./scripts/provision-test-users.ps1`
Expected: all three users present.

- [ ] **Step 2: Full integration run #1**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all tests pass (0 failures).

- [ ] **Step 3: Full integration run #2 (immediately, no cooldown wait)**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all tests pass — this is the run that previously cascaded.

- [ ] **Step 4: Full integration run #3 (immediately)**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all tests pass. Three consecutive green full runs = cascade eliminated.

- [ ] **Step 5: Confirm unit suite still green**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 286+ unit/protocol tests pass; tsc clean (new src change is only the
`bc-session.ts` guard).

- [ ] **Step 6: Update docs**

In `CLAUDE.md`, under "Testing Strategy", replace the stale "103 integration tests" count
and the "Session Death Cascading" note: document that integration tests now run
single-process serial against Cronus28 via `tests/integration/helpers/session-pool.ts`,
that `scripts/provision-test-users.ps1` must be run once to create the user pool, and that
the drain-on-death guard makes a dead session fast-fail. Remove the BC27 row from the BC
Test Environments table (only Cronus28 remains).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document serial integration suite, session pool, and Cronus28-only env"
```

---

## Self-Review Notes

- **Spec coverage:** Deliverable 0 = Task 2; Deliverable 1 = Task 1; Deliverable 2 (pool)
  = Task 3, (serial config) = Task 4, (migration + repoint) = Task 5; Definition-of-done
  (green 3×, tsc clean, unit green) = Task 6.
- **Deferred (not in this plan, per spec):** error taxonomy (Phase 1b), god-file refactor
  (Phase 2), capability work (Phase 3).
- **Type consistency:** `IntegrationSessionPool`, `PooledLease { session, user }`,
  `checkOut()`, `checkIn(lease, { poisoned })`, `integrationPool` singleton, and
  `buildSession(user)` are used identically across Tasks 3 and 5. The `bc-session.ts`
  guard reuses the existing `ProtocolError('Session is dead')` contract (already used at
  `bc-session.ts:122` and `:449`) — no new error type.
- **Open verification carried into execution:** confirm the fatal-token set in
  `invokeUnqueued` (`InvalidSessionException` / `"code":1`) is unchanged; the guard only
  short-circuits AFTER `markDead`, so classification is untouched.
