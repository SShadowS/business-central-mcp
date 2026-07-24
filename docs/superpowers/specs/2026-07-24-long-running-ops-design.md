# Long-Running Operations — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 — substantially rewritten after two-model adversarial review
(see `.panel/05-longops-*.md`). Both panelists independently found the previous version's central
argument invalid.
**Size:** M-L (depends on which branch the gates select)
**Build order:** 5 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/long-running-ops`
**Status:** Blocked on Gate A and Gate B. Do not implement past the gates.

## Problem

Every invoke is bounded by an absolute wall-clock timeout: `BCSession.invoke` wraps the queued task
in `withTimeout(..., effectiveTimeout + 5000)` (`src/session/bc-session.ts:145-161`), and on expiry
`withTimeout` **kills the session** — `markDead()` + `closeWs()` (`:169-176`). Default
`BC_INVOKE_TIMEOUT` is 30 s (`src/core/config.ts:73-75`).

A month-end posting run, a large report, or a config-package import exceeds that routinely. BC is
healthy and working; we kill the connection, the caller gets a timeout, BC holds the auth slot for
~15 s, and the operation may well have committed server-side.

Raising the global timeout is not a fix: it delays detection of genuinely hung invokes (a confirmed
BC bug) by the same amount for every call.

## Retraction: the previous version's argument was wrong

The earlier draft asserted that `DN.IsExecutingHandler` belongs only to BC's HTTP long-poll client
and is unavailable on our transport, based on finding no matches for `IsExecuting` in
`Microsoft.Dynamics.Nav.Service.ClientService`.

**That grep was against the wrong assembly.**

- This client connects to `${base}/csh` (`src/connection/connection-factory.ts:53-62`).
- `ClientService`'s WebSocket endpoint is `[Route("ws")]` + `[Route("connect")]`, i.e.
  `/ws/connect`, and it runs StreamJsonRpc (`WebSocketController.cs:13-31`,
  `NsServiceJsonRpcHostFactory.cs:15-34`). It is **not** `/csh`.
- No `.cs` file in the decompiled tree contains the string `/csh` at all — the endpoint is part of
  the web-client host, whose request model is `CallbackRequestData` in
  `Microsoft.Dynamics.Framework.UI.Web`.
- Our encoder already sends exactly that model — `interactionsToInvoke`, `sequenceNo`,
  `lastClientAckSequenceNumber`, `navigationContext` (`src/protocol/interaction-encoder.ts:48-73`)
  — and our responses are `ResponseManager` products, per the verified report-download work.

`IsExecuting` is matched **by interaction name** inside transport-agnostic `CallbackHandler`
(`CallbackHandler.cs:231-247`), and answered from `HasEnteredProcessing` **before** `EnterProcessing`
(`:97-104`) — it is expressly designed to be answerable while another interaction is blocked. The
same pre-processing treatment applies to `CancelAction` (`:137-157`).

So IsExecuting is plausibly available to us. The real unknown is whether a second JSON-RPC request
can be dispatched on our socket while an invoke is outstanding — and that is a client-side
constraint we impose ourselves: `BCWebSocket.enqueueSend` serialises an RPC *through its response*
(`src/connection/bc-websocket.ts:210-274`).

## Gates — both mandatory, both cheap

### Gate A — can `/csh` answer IsExecuting concurrently?

1. Open a session, start a long invoke (a report or a deliberate delay).
2. On the same socket, send a second `Invoke` whose sole interaction is named `IsExecuting`,
   bypassing our own send queue.
3. Record: does a `DN.IsExecutingHandler` response arrive? Does it arrive *before* the first invoke
   completes? Does sending it corrupt `sequenceNo` or the first response?

**If Gate A passes**, take Branch 1 below and most of this spec's risk disappears — correlated
progress polling replaces heuristics, and `bc_cancel_operation` becomes cheap (same server-side
pre-processing path).

**If Gate A fails**, take Branch 2 and accept its documented limits.

### Gate B — does BC emit frames during a silent long operation?

Branch 2 is worthless if the socket goes quiet. `ProgressNotificationBlock` is **event-driven, not
a heartbeat** (`ProgressNotificationBlock.cs:91-145`): it emits only when AL explicitly drives a
dialog. A long `CALCFIELDS`, a slow query, a lock wait, or report dataset generation can be silent
for minutes. `CallbackHandler.HandleRequestCore` awaits `InvokeInteractions` before generating the
response (`:184-211`), so the *response* certainly cannot arrive early.

Capture raw `/csh` frames with monotonic timestamps during:

- an operation that drives a progress dialog (batch journal post);
- one that does not (a large report, or a long `MODIFYALL`);
- a long SQL / lock-wait phase.

Report the **maximum inter-frame gap**, not pass/fail. A single chatty report proves nothing about
posting.

## Branch 1 — correlated IsExecuting polling (preferred, if Gate A passes)

- `BCWebSocket` gains a narrowly scoped `sendOutOfBand(method, params)` that bypasses
  `enqueueSend`, used **only** for IsExecuting and (later) CancelAction.
- While an invoke is outstanding and no response has arrived for `pollIntervalMs` (default 10 s),
  send an IsExecuting probe. A `true` answer resets the deadline; a `false` answer means BC is not
  processing and the invoke really is wedged; a transport error fails fast.
- The deadline then measures *what it claims to measure* — server-side execution state — instead of
  inferring liveness from unrelated traffic.

## Branch 2 — idle deadline (fallback, only if Gate A fails and Gate B shows frequent frames)

### `InvokeDeadline` (pure timer policy)

`src/session/invoke-deadline.ts`

```ts
export class InvokeDeadline {
  constructor(opts: {
    idleMs: number; ceilingMs: number;
    onExpire: (reason: 'idle' | 'ceiling', elapsedMs: number) => void;
    now?: () => number; setTimer?: ...;   // injected for tests
  });
  start(): void; touch(source: string): void; stop(): void;
}
```

No knowledge of WebSockets, BC, or sessions. Fully testable with fake timers.

### Wiring, with the corrections the review forced

- The liveness hook must live in the **raw `ws.on('message')` callback**, before `JSON.parse`
  (`src/connection/bc-websocket.ts:104-113`) — not in `routeMessage`, which never sees malformed
  frames and returns early for non-object JSON (`:127-140`). The previous draft's placement
  contradicted its own test 7.
- WebSocket ping/pong is handled below the `message` event by the `ws` library and therefore
  correctly does **not** feed the timer. Asserted by a test so it cannot silently change.
- `sendRpc`'s own timeout is set to `ceilingMs + 5 s`, **not** equal to the ceiling — two timers
  with the same nominal expiry race, and the previous draft's "so the deadline never fires first"
  claim was unfounded.
- The deadline belongs to the **outer queued task**, not to each `invokeUnqueued` attempt. Modal
  reconciliation calls `invokeUnqueued` recursively; nested calls `touch()` the existing deadline
  rather than creating their own.
- Expiry closes the socket, which rejects the pending `sendRpc`. Exactly one settlement path must
  win, listeners must be removed, and no unhandled rejection may escape.

### Honest failure modes (documented in the spec, not discovered later)

1. **Uncorrelated traffic.** Any inbound frame resets the timer, including notifications for other
   open forms, trailing messages from the previous invoke, and server-initiated requests. A wedged
   invoke on a chatty session survives to the ceiling — hang detection regresses from ~35 s to up to
   600 s. Mitigation: every `touch()` logs its frame type at debug so an operator can see what kept
   it alive; nothing stronger is possible without Gate A.
2. **A silent healthy operation still dies** at `idleMs`. If Gate B shows gaps above the idle
   window, Branch 2 does not solve the stated problem and the ceiling must simply be raised
   instead — which is a smaller, honest change.
3. **Late traffic attribution.** The 150 ms quiescence window means a message can arrive after
   settlement and touch the *next* operation's deadline.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BC_INVOKE_IDLE_TIMEOUT` | 30 s | Falls back to `BC_INVOKE_TIMEOUT` when unset. |
| `BC_INVOKE_MAX_DURATION` | 600 s | Absolute cap. |
| `BC_ISEXECUTING_POLL_INTERVAL` | 10 s | Branch 1 only. |

Existing per-call `timeoutMs` overrides must be preserved: the report flow passes a larger explicit
timeout (`src/session/bc-session.ts:515-557`), and a global idle deadline that ignores it is a
silent regression. An explicit per-call timeout now sets that call's **ceiling**.

Distinct error messages, because the operator response differs:

- idle: "BC sent nothing for Ns. Session killed. The operation may have committed server-side —
  verify before retrying."
- ceiling: "Operation exceeded the Ns cap while still responding. Raise `BC_INVOKE_MAX_DURATION` if
  this operation is legitimately this slow."

## Progress surfacing

Both branches: decode progress notifications into a `Progress` event and log at info, so a long run
is observable instead of looking like a hang. The wire shape is **not yet known** — the decompiled
`IProgressNotificationMonitor` implementation has not been traced to a handler array. Gate B's
capture supplies it. No progress field is added to tool outputs.

## Files touched

```
new   src/session/invoke-deadline.ts          (Branch 2)
edit  src/connection/bc-websocket.ts          (raw-frame hook; sendOutOfBand for Branch 1;
                                               sendRpc timeout = ceiling + 5s)
edit  src/session/bc-session.ts               (deadline ownership on the outer task; poll loop
                                               for Branch 1; per-call ceiling)
edit  src/protocol/event-decoder.ts           (Progress event, shape from Gate B)
edit  src/protocol/types.ts                   (ProgressEvent)
edit  src/core/config.ts                      (new env vars)
```

## Test plan (TDD order)

**Gates first — no implementation before both are recorded.**

**Unit (fake timers):**

1. No `touch()` → expires at `idleMs`, reason `idle`.
2. Repeated `touch()` below the idle window past 3x `idleMs` → no expiry.
3. Continuous `touch()` past `ceilingMs` → expires, reason `ceiling`.
4. `stop()` before expiry → `onExpire` never fires, zero dangling timers.
5. `touch()` after `stop()` is a no-op; `start()` twice is safe; `idleMs >= ceilingMs` rejected.
6. Distinct messages for idle vs ceiling.
7. Raw hook fires for a frame that fails `JSON.parse` (proves placement before parsing).
8. Raw hook fires for responses, `Message` notifications, and inbound requests.
9. WS ping/pong does **not** touch the deadline.
10. Nested `invokeUnqueued` touches the outer deadline; it does not create a second one.
11. Expiry + socket close settles exactly once, removes listeners, no unhandled rejection.
12. Explicit per-call `timeoutMs` sets that call's ceiling and is not overridden by the global.
13. Config: idle falls back to `BC_INVOKE_TIMEOUT`; both unset → 30 s; invalid values rejected.
14. Branch 1: a `false` IsExecuting answer while an invoke is outstanding fails it fast rather than
    waiting for the ceiling.

**Integration — Cronus28:**

15. **Gate A live test**, kept as a permanent regression test whichever branch ships.
16. **Gate B measurement**, asserting the recorded maximum inter-frame gap for the chosen fixture
    stays under the configured idle window. This is the test that would catch BC changing.
17. A genuinely long operation (>60 s) completes instead of killing the session.
18. A half-open socket — connection kept open, all inbound data dropped — expires on idle. (Killing
    the connection outright only tests the existing immediate-rejection path at
    `bc-websocket.ts:111-117`.)
19. Branch 2 only: an unrelated notification arriving while an invoke is hung — assert the
    documented regression (survives to the ceiling) so the behaviour is recorded, not accidental.
20. Existing session-recovery integration tests unchanged and green.

## Definition of done

- Gates A and B closed, recorded in the plan **and** in CLAUDE.md.
- The chosen branch implemented; the rejected branch's rationale written down.
- Unit + integration green; existing timeout/recovery tests unaffected.
- `npx tsc --noEmit` clean.
- CLAUDE.md "Session Recovery" and "Async Message Timing" updated, including the retraction above
  so the wrong IsExecuting claim does not get re-derived from the old note.

## Out of scope

- `bc_cancel_operation`. Deferred — but the rationale is corrected: the blocker is our own
  `enqueueSend` serialisation plus the need for `sendOutOfBand`, **not** a server limitation. BC
  exposes `CancelAction` on the same pre-processing path as IsExecuting
  (`CallbackHandler.cs:137-157` → `UISession.CancelProgressDialog`, `UISession.cs:969-980`). If
  Gate A passes, cancellation becomes a small follow-up rather than a redesign.
- Async operation handles (`operationId` + poll tool).
