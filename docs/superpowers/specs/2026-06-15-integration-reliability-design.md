# Integration Test Reliability — Design Spec

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan
**Phase:** 1 of the "make the MCP better" roadmap (Reliability foundation)
**Scope:** Workstreams 0+1+2 only. Error taxonomy is deferred to its own spec (Phase 1b).

---

## Problem

The integration suite (~111 tests, ~18 files, live BC) is **not reliably green back-to-back**.

Confirmed empirically on 2026-06-15:
- Full run: 4 failures (`multi-section` header write + `phase4-features` factbox data on document pages 42/43).
- Same two files in isolation: 0 failures, on both `master` and a feature branch.

### Root cause

Two compounding mechanisms:

1. **Runtime — undrained invoke queue on session death.** `BCSession.invoke()` already
   fast-fails when `this.dead` is set (`bc-session.ts:122`) and already detects fatal
   tokens (`InvalidSessionException` / `"code":1` at `bc-session.ts:214`). But invokes
   **already enqueued** when death is detected are not drained — each still runs
   `ws.sendRpc` and waits out the full 30s timeout (`withTimeout`, `bc-session.ts:138`).
   A single protocol error therefore produces a cascade of 30s hangs.

2. **Harness — shared poisoned auth slot.** Each integration file builds its own session
   via `SessionFactory.create()` directly in `beforeAll` (bypassing `SessionManager`), all
   using the single `sshadows` account. When one test triggers a session-killing protocol
   error, BC holds that user's NTLM auth slot for ~15s. The next file's `beforeAll`
   `create()` hits the held slot, fails to authenticate, and every test in that file fails.

Mechanism 1 makes failures slow; mechanism 2 makes them spread. Together they turn one
protocol error into a multi-file cascade whose outcome depends on test ordering — i.e.
non-deterministic.

### Why this is Phase 1

A flaky integration suite is not a safety net. Every later phase (god-file refactor,
capability expansion) needs a trustworthy green suite to catch regressions. Fix the
foundation before building on it.

---

## Environment constraints

- **Single BC environment: `Cronus28`** (container `Cronus28`, image
  `mcr.microsoft.com/businesscentral:ltsc2025`). BC27 / `cronus27` no longer exists.
- Authentication: NavUserPassword.
- Provisioning tool: **bccontainerhelper 6.1.15** is installed; `New-BcContainerBcUser`
  and `Get-BcContainerBcUser` are available against the running container.

---

## Design

Three deliverables. No backward-compatibility constraints.

### Deliverable 0 — Test-user provisioning script

**File:** `scripts/provision-test-users.ps1`

Idempotently ensures a pool of SUPER-equivalent users exists on `Cronus28`. Each pool
user is a clone of `sshadows` in capability — **same permissions (SUPER), same company
access (CRONUS), same default profile** — differing only by username, so that test
outcome never depends on which slot served the request.

Pool (3 slots): `sshadows` (existing), `bcmcp_test1`, `bcmcp_test2`.

Logic per user:
```powershell
$existing = Get-BcContainerBcUser -containerName Cronus28 -tenant default |
            Where-Object { $_.UserName -eq $name }
if (-not $existing) {
    New-BcContainerBcUser -containerName Cronus28 -tenant default `
        -Credential (New-Object pscredential $name, (ConvertTo-SecureString '1234' -AsPlainText -Force)) `
        -PermissionSetId SUPER `
        -ChangePasswordAtNextLogOn $false `
        -assignPremiumPlan
}
```

The script is safe to re-run (skips existing users) and is the documented setup step for
running the integration suite on a fresh container. All pool users share password `1234`.

**Pool sizing rationale:** the suite runs files serially; each file takes ~15-30s. With K
users round-robined per file, a poisoned slot gets `(K-1) × file_duration` to cool past
the 15s NTLM hold before it is reissued. K=3 gives one active + one warm + one cooling —
comfortably above the 15s window. K=3 is the minimum that breaks the cascade with margin;
more is unnecessary.

### Deliverable 1 — Runtime: drain-on-death

**File:** `src/session/bc-session.ts`

When the session transitions to dead — whether via fatal-token detection
(`bc-session.ts:214`), transport close, or a `withTimeout` firing — immediately reject
**every invoke currently pending in the queue** with `SessionDeadError`, rather than
letting each chained task reach `ws.sendRpc` and time out.

Approach:
- Track pending queued tasks so they can be settled on death.
- On death detection, settle all of them with `SessionDeadError` (a `BCError` subclass;
  add to `src/core/errors.ts` if not present — note `SessionLostError` already exists for
  the manager-level signal, `SessionDeadError` is the queue-drain signal; if the existing
  `ProtocolError('Session is dead')` path is judged sufficient, reuse it rather than add a
  type — decide during planning).
- New invokes arriving after death continue to fast-fail via the existing `this.dead`
  guard (`bc-session.ts:122`).

**Fatal vs recoverable classification** (verify against decompiled BC during planning):
- Fatal (trip the drain): `InvalidSessionException`, `"code":1`, transport disconnect,
  RPC timeout.
- Recoverable (do NOT trip — already handled by the modal-reconcile retry):
  `LogicalModalityViolationException` (`bc-session.ts:218`).

This is a surgical change to one file. It eliminates mechanism 1 and also protects live
LLM callers: a dead session fast-fails with a clear message instead of hanging.

### Deliverable 2 — Test-auth pool + centralized session construction

**New file:** `tests/integration/helpers/session-pool.ts`

A module-singleton pool that becomes the **single source of integration-test sessions**,
replacing the ~18 duplicated `beforeAll` construction stacks and the hardcoded-vs-env
config split.

API:
```
checkOut(): Promise<PooledSession>   // hands out a session on the next COOLED user
checkIn(session, opts: { poisoned: boolean }): Promise<void>
```

Behavior:
- Maintains the user list from config (`BC_TEST_USERS`, default
  `sshadows,bcmcp_test1,bcmcp_test2`), each with a `cooldownUntil` timestamp.
- `checkOut` picks the next user whose `cooldownUntil` has passed (round-robin); if none
  are cool, awaits the soonest. Builds the full session stack
  (auth → connection → encoder → session) internally — the one place this construction
  lives.
- `checkIn({poisoned:true})` stamps `cooldownUntil = now + 15s` (configurable) so the
  poisoned NTLM slot is never reissued hot. `{poisoned:false}` returns the slot to the
  rotation immediately.
- A session is "poisoned" if `!session.isAlive` at check-in, or if the test explicitly
  flags it.

**Integration files** replace their bespoke `beforeAll`/`afterAll` with:
```ts
let session: PooledSession;
beforeAll(async () => { session = await pool.checkOut(); /* build services from session */ });
afterAll(async () => { await pool.checkIn(session, { poisoned: !session.isAlive }); });
```

**Execution model:** the integration vitest config must run **single-process, serial**
(`fileParallelism: false`, single fork) so the pool singleton is shared across files.
Update `vitest.integration.config.ts`. The suite already runs effectively serially
(~410s wall clock) against one stateful BC, so this imposes no real cost and removes a
class of concurrent-session contention.

**Env repoint:** since only `Cronus28` exists, the pool builds all sessions against
`http://cronus28/BC` (`clientVersionString: '28.0.0.0'`, `serverMajor: 28`). Remove the
hardcoded BC28 literal configs (`bc28.test.ts:18`, `multi-section.test.ts:362`,
`document-and-bc28.test.ts:497`) and the stale BC27 references (`phase3-workflows.test.ts:5`
comment and any cronus27 assumptions) — all sessions come from the pool now.

---

## Data flow

```
provision-test-users.ps1 (one-time / idempotent)
        ↓ creates SUPER users on Cronus28
BC_TEST_USERS env  →  session-pool (singleton)
        ↓ checkOut() → cooled user → build session stack
integration test file (beforeAll)
        ↓ runs tests; on protocol error → drain-on-death rejects pending invokes fast
        ↓ afterAll: checkIn(poisoned?) → stamp cooldown if poisoned
next file → checkOut() → different cooled user (poisoned slot still cooling, off critical path)
```

---

## Error handling

- Drain-on-death rejects pending invokes with a single, clear error type (no 30s hangs).
- Pool `checkOut` when all users are cooling: await the soonest `cooldownUntil` rather
  than fail — guarantees progress, worst case ~15s wait once.
- Provisioning script failures (container down, cmdlet error) surface clearly and abort;
  the script never partially-creates a user silently.

---

## Testing strategy

This work fixes the test harness, so verification is meta:

1. **Drain-on-death unit test** (`tests/`): simulate a queued batch, mark the session dead
   mid-flight, assert all pending invokes reject promptly with the session-dead error and
   none wait the full timeout. No live BC needed (mock `ws.sendRpc`).
2. **Pool unit test**: assert round-robin, cooldown-skip (a poisoned user is not reissued
   within the cooldown window), and await-soonest behavior. No live BC.
3. **The acceptance test is the suite itself**: after Deliverables 0-2, the full
   integration suite must pass **green back-to-back, three consecutive full runs**, with no
   order-dependent failures. This is the definition of done.
4. Provisioning script verified by running it twice (second run is a no-op) and confirming
   all three users authenticate.

---

## Definition of done

- `scripts/provision-test-users.ps1` creates the 3-user pool idempotently on `Cronus28`.
- `bc-session.ts` drains pending invokes on death; unit test proves no timeout hang.
- `session-pool.ts` is the sole session source for integration tests; unit test proves
  rotation + cooldown.
- `vitest.integration.config.ts` runs single-process serial.
- All ~18 integration files use the pool; hardcoded/env-split configs and BC27 references
  removed.
- Full integration suite passes green **3× consecutively** with no order dependence.
- `npx tsc --noEmit` clean; 286 unit/protocol tests still pass.

---

## Out of scope (explicitly deferred)

- **Error taxonomy / LLM-actionable error messages** → Phase 1b (own spec).
- **God-file refactor** (tool-registry, bc-session, page-service, page-context-repo) →
  Phase 2, executed under this now-green suite. Note: Deliverable 1 touches `bc-session.ts`
  surgically; the full decomposition waits for Phase 2.
- **Capability work** (report output stream capture, staleness/generation tokens,
  idempotent teardown, new tools) → Phase 3.
