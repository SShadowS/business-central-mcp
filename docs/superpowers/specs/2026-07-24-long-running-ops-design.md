# Long-Running Operations — Design

**Date:** 2026-07-24
**Size:** M
**Build order:** 5 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/long-running-ops`

## Problem

Every invoke is bounded by an absolute wall-clock timeout. `BCSession.invoke` wraps the call in
`withTimeout(..., effectiveTimeout + 5000)` (`src/session/bc-session.ts:157-161`), and on expiry
`withTimeout` **kills the session**: `markDead()` + `closeWs()` (`bc-session.ts:173-176`).

Default `BC_INVOKE_TIMEOUT` is 30 s. A month-end posting run, a large report, a config-package
import, or a batch job on a real dataset routinely exceeds that. BC is healthy and working; we
kill the connection, the caller gets "BC did not respond within 35s", and BC holds the NTLM slot
for ~15 s afterwards. The operation may well have committed server-side, so the caller is left
guessing.

Raising `BC_INVOKE_TIMEOUT` globally is not a fix: it delays detection of genuinely hung invokes
(a confirmed BC bug, per CLAUDE.md) by the same amount for every call.

## Correction to the original plan

The initial gap list proposed polling `DN.IsExecutingHandler`. That handler belongs to BC's HTTP
long-poll client, not our WebSocket:

- `Microsoft.Dynamics.Framework.UI.Web/CallbackHandler.cs:231` — `IsIsExecutingRequest` matches a
  request whose single interaction is literally named `IsExecuting`.
- `CallbackHandler.cs:267` — `GenerateIsExecutingResponse` emits the `DN.IsExecutingHandler` envelope.
- Grepping `IsExecuting` across `Microsoft.Dynamics.Nav.Service.ClientService` (the assembly serving
  our `/csh` socket) returns **no matches**.

There is no busy-poll to send. The mechanism available to us is different and simpler: BC keeps
talking while it works.

## Evidence for the chosen mechanism

| Claim | Source |
|---|---|
| BC pushes async `Message` notifications during an invoke | `src/session/bc-session.ts:215-229` already subscribes to them and merges them into the result |
| Every inbound frame passes one chokepoint | `src/connection/bc-websocket.ts:104-107` -> `routeMessage`, which forwards to all handlers before routing (`bc-websocket.ts:128-140`) |
| Long AL operations emit progress notifications | `Microsoft.Dynamics.Framework.UI/ProgressNotificationBlock.cs`, `ProgressNotificationOptions.cs`; cancellation exists at `UISession.cs:969-978` (`CancelProgressDialog`) |
| The server has its own cap, so an idle client deadline is not the last line of defence | `Microsoft.Dynamics.Nav.Service.ClientService/ClientHostStartup.cs:70` — `UseCancellationMiddleware("ClientActivityId", ServerUserSettings.Instance.ClientServicesOperationTimeout.Value)` |
| Exactly one invoke is in flight at a time | The serialized invoke queue in `BCSession` (CLAUDE.md, "Invoke Queue") |

That last fact is what makes correlation tractable: we do not need to know which pending request a
frame belongs to, because there is only ever one.

## Design

### New unit: `InvokeDeadline` (pure timer policy)

`src/session/invoke-deadline.ts`

```ts
export interface InvokeDeadlineOptions {
  idleMs: number;      // no inbound traffic for this long -> expire
  ceilingMs: number;   // total elapsed cap regardless of traffic
  onExpire: (reason: 'idle' | 'ceiling', elapsedMs: number) => void;
  now?: () => number;  // injected for tests
  setTimer?: ...;      // injected for tests
}

export class InvokeDeadline {
  start(): void;
  touch(): void;   // called on any inbound frame
  stop(): void;    // called on settle
}
```

One responsibility: decide when a call has stopped making progress. No knowledge of WebSockets,
BC, or sessions. Fully unit-testable with fake timers, which the current inline `setTimeout` logic
is not.

### Wiring

- `BCWebSocket` exposes `onAnyFrame(cb)` — invoked from `routeMessage` **before** any parsing or
  routing decision, so malformed or unrecognised frames still count as liveness. This is a new
  hook rather than reusing `onMessage`, because `onMessage` handlers are semantic consumers and
  one of them filtering on `method === 'Message'` (as `invokeUnqueued` does) would miss responses.
- `invokeUnqueued` creates an `InvokeDeadline`, subscribes it to `onAnyFrame`, and unsubscribes in
  its existing `finally`.
- `withTimeout`'s fixed timer is replaced by the deadline. `markDead()` + `closeWs()` still happen
  on expiry — a call that has been silent for the idle window is genuinely wedged, and the existing
  recovery path (SessionManager exponential backoff) is correct for it.
- `ws.sendRpc`'s own `timeoutMs` is raised to the ceiling, so the RPC layer never fires first. The
  deadline becomes the single authority on "too long".

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BC_INVOKE_IDLE_TIMEOUT` | 30 s | Silence tolerated before declaring the invoke wedged. |
| `BC_INVOKE_MAX_DURATION` | 600 s | Absolute cap. Protects against a chatty-but-stuck server. |

`BC_INVOKE_TIMEOUT` is retained as the fallback default for `BC_INVOKE_IDLE_TIMEOUT` so existing
deployments keep their tuning without edits.

Error messages must distinguish the two, because the operator response differs:

- idle: "BC sent nothing for 30s. Session killed and will reconnect. The operation may have
  committed server-side — verify before retrying."
- ceiling: "Operation exceeded the 600s cap while still responding. Session killed. Raise
  `BC_INVOKE_MAX_DURATION` if this operation is legitimately this slow."

### Progress surfacing

Progress notifications are already decoded into events and merged. This spec adds only:

1. A `Progress` event variant in the decoder when a `Message` batch carries progress-notification
   properties (heading / body text), instead of falling through as unknown.
2. `logger.info` on each progress update, so a long run is observable in the log rather than
   looking like a hang.

It deliberately does **not** add a progress field to tool outputs. The invoke is synchronous from
the caller's perspective; by the time a tool result is produced the operation has finished and
intermediate progress is noise. If a future async-handle mode lands, that is where progress
belongs.

## Files touched

```
new   src/session/invoke-deadline.ts
edit  src/connection/bc-websocket.ts   (onAnyFrame hook; sendRpc timeout -> ceiling)
edit  src/session/bc-session.ts        (withTimeout -> InvokeDeadline; error messages)
edit  src/protocol/event-decoder.ts    (Progress event)
edit  src/protocol/types.ts            (ProgressEvent)
edit  src/core/config.ts               (two new env vars, BC_INVOKE_TIMEOUT fallback)
```

## Test plan (TDD order)

**Unit — fake timers throughout, write first:**

1. No `touch()` -> expires at `idleMs` with reason `idle`.
2. `touch()` at 0.9x idle, repeatedly, past `idleMs * 3` -> does not expire.
3. Continuous `touch()` past `ceilingMs` -> expires with reason `ceiling`.
4. `stop()` before expiry -> `onExpire` never fires, no dangling timer (assert timer count zero).
5. `touch()` after `stop()` is a no-op.
6. Idle expiry message names the idle window; ceiling expiry message names the cap.
7. `BCWebSocket.onAnyFrame` fires for a malformed frame that `routeMessage` cannot parse further.
8. `onAnyFrame` fires for responses, `Message` notifications, and inbound requests alike.
9. Config: `BC_INVOKE_IDLE_TIMEOUT` unset falls back to `BC_INVOKE_TIMEOUT`; both unset -> 30 s.

**Integration — Cronus28, destructive allowed:**

10. Drive an operation that takes longer than 30 s and assert it completes rather than killing the
    session. Candidate: `bc_run_report` on a wide report (e.g. Detail Trial Balance over a full
    year, all accounts) or a batch post of several journal lines. The plan pins the concrete
    operation after measuring one against Cronus28; if nothing on the demo dataset reliably exceeds
    30 s, set `BC_INVOKE_IDLE_TIMEOUT=2000` for that test and use any normal report — the
    mechanism, not the wall-clock, is what is under test.
11. A genuinely dead socket (kill the connection mid-invoke) still fails fast and marks the session
    dead — the fast-fail behaviour must not regress.
12. Existing session-recovery integration tests unchanged and green.

## Definition of done

- Unit + integration green; existing timeout/recovery tests unaffected.
- `npx tsc --noEmit` clean.
- No raw `setTimeout` left in `BCSession` for invoke timing (grep).
- CLAUDE.md "Session Recovery" and "Async Message Timing" sections updated with the idle/ceiling
  model and the IsExecuting correction.

## Out of scope

- `bc_cancel_operation` wired to `UISession.CancelProgressDialog`. Considered and deferred: it
  needs a second channel into a session whose queue is blocked by the very invoke being cancelled.
- Async operation handles (`operationId` + poll tool).
- Per-call `timeoutMs` overrides on individual tools. The idle model makes them mostly unnecessary;
  revisit if a real flow needs a tighter bound than the global.
