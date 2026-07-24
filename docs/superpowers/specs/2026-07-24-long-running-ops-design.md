# Long-Running Operations — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 — substantially rewritten after two-model adversarial review
(see `.panel/05-longops-*.md`). Both panelists independently found the previous version's central
argument invalid.
**Size:** M
**Build order:** 5 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/long-running-ops`
**Status:** **Gate A CLOSED (2026-07-24, passed). Branch 1 selected; Branch 2 dropped. Gate B moot.**
Live probe: `scripts/gate-a-isexecuting.ts`; captured wire fixture:
`src/protocol/captures/isexecuting-concurrent-2026-07-24.json`.

## Gate A result — passed

Ran the probe against Cronus281 (BC 28.0; Cronus28 is BC 28.3 and had its `/csh` upgrade returning
403 at the time — unrelated infra). It starts a slow `OpenForm` without awaiting it and pushes raw
`Invoke` frames carrying a single `IsExecuting` interaction straight onto the socket, bypassing
`enqueueSend`.

Findings, all confirmed:

- **`/csh` answers a concurrent IsExecuting.** 10 of 10 probes sent while the invoke was outstanding
  received a response, RTT **1-4 ms** — the send queue is our own constraint, not the server's.
- **The answer is a real `DN.IsExecutingHandler`** carrying `["true"]` / `["false"]`. The response
  frame uses the `compressedResult` key (not `result`), so `decompressIfNeeded` must run before
  decoding — noted for the Branch 1 decoder.
- **The answer tracks server processing state.** Early probes returned `true` (BC mid-OpenForm),
  then flipped to `false` — *before* the 39 KB `FormCreated` frame was even delivered. So IsExecuting
  reports "server is processing", and it goes false as soon as processing ends, independent of when
  the large response is flushed. Exactly the correlated heartbeat this feature needs.
- **No sequence corruption.** A normal `invoke` after the probe barrage succeeded.

This makes **Gate B irrelevant for the chosen design**: we do not depend on BC volunteering frames
during a silent long operation, because we poll IsExecuting and it answers in ~2 ms regardless.

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

So IsExecuting is available to us. The one remaining unknown — whether a second JSON-RPC request
could be dispatched on our socket while an invoke is outstanding, given our own
`BCWebSocket.enqueueSend` serialises an RPC *through its response*
(`src/connection/bc-websocket.ts:210-274`) — was Gate A, now closed (see the result at the top of
this document).

## Design — correlated IsExecuting polling

Gate A passed, so this replaces the idle-deadline heuristic entirely. The heuristic and its
failure modes are recorded in the "Rejected: idle deadline" appendix so the reasoning is not lost.

### `sendOutOfBand`

`BCWebSocket` gains a narrowly scoped `sendOutOfBand(method, params): Promise<Result<...>>` that
bypasses `enqueueSend` — used **only** for `IsExecuting` and (later) `CancelAction`. It registers
its own `pendingRequests` entry keyed on the frame id, and decodes the response through
`decompressIfNeeded` (the probe proved the answer arrives under `compressedResult`, not `result`).
Everything else still goes through the serialised queue; this is a deliberate, audited exception,
not a general concurrency door.

### `IsExecutingPoller`

`src/session/isexecuting-poller.ts` — pure-ish policy object, timers injected for tests:

```ts
export class IsExecutingPoller {
  constructor(opts: {
    probe: () => Promise<'true' | 'false' | 'error'>;
    pollIntervalMs: number;      // BC_ISEXECUTING_POLL_INTERVAL, default 10 s
    ceilingMs: number;           // BC_INVOKE_MAX_DURATION, default 600 s
    onVerdict: (v: 'still-executing' | 'wedged' | 'ceiling' | 'transport-dead') => void;
    now?: () => number; setTimer?: ...;
  });
  start(): void; stop(): void;
}
```

While an invoke is outstanding and no response has arrived for `pollIntervalMs`, it fires a probe:

- `true` → server is processing; extend, keep waiting.
- `false` → the server is **not** processing yet the invoke has not returned. That is the confirmed
  BC hung-invoke bug. Verdict `wedged`; kill the session and let SessionManager recover — the same
  action as today, but now correlated instead of guessed, and reached in ~10 s instead of blindly
  at 30 s.
- `error`/timeout on the probe → verdict `transport-dead`; the socket itself is gone.
- Total elapsed past `ceilingMs` → verdict `ceiling`, regardless of `true`, so a genuinely
  runaway job cannot pin the session forever.

Because the probe answers in ~2 ms and reflects real server state, Gate B's worry — a silent socket
during a long AL phase — does not apply: silence on the main channel no longer implies a dead
invoke, because we *ask*.

### Wiring

- `BCSession.invokeUnqueued` starts an `IsExecutingPoller` when it sends, stops it on settle (its
  existing `finally`). The poller belongs to the **outer** logical operation; nested
  `invokeUnqueued` calls from modal reconciliation do not each spawn one.
- `sendRpc`'s own timeout is raised to `ceilingMs + 5 s` so the RPC layer never races the poller's
  verdict.
- Existing per-call `timeoutMs` overrides set that call's ceiling (the report flow passes a larger
  timeout at `src/session/bc-session.ts:515-557`; it must not regress).

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BC_ISEXECUTING_POLL_INTERVAL` | 10 s | Silence tolerated before probing IsExecuting. |
| `BC_INVOKE_MAX_DURATION` | 600 s | Absolute ceiling, enforced even while IsExecuting is `true`. |

`BC_INVOKE_TIMEOUT` (30 s) stays as the default `sendRpc` floor for calls that opt out of polling.
Existing per-call `timeoutMs` overrides must be preserved: the report flow passes a larger explicit
timeout (`src/session/bc-session.ts:515-557`), and a ceiling that ignores it is a silent regression.
An explicit per-call timeout now sets that call's **ceiling**.

Distinct error messages, because the operator response differs:

- wedged: "BC reported it stopped processing (IsExecuting=false) but the operation did not return.
  Session killed. The operation may have committed server-side — verify before retrying."
- ceiling: "Operation exceeded the Ns cap while still processing. Raise `BC_INVOKE_MAX_DURATION` if
  this operation is legitimately this slow."
- transport-dead: "The connection stopped answering IsExecuting probes. Session killed."

## Progress surfacing

Decode progress notifications into a `Progress` event and log at info, so a long run is observable
instead of looking like a hang. The wire shape is **not yet traced** — the decompiled
`IProgressNotificationMonitor` implementation has not been mapped to a handler array. This is a
secondary nicety, not load-bearing (the poller is what keeps the session alive), so it may ship in
a follow-up if the shape is not trivially captured. No progress field is added to tool outputs.

## Files touched

```
new   src/session/isexecuting-poller.ts       (policy object, injected timers)
edit  src/connection/bc-websocket.ts          (sendOutOfBand; sendRpc timeout = ceiling + 5s)
edit  src/session/bc-session.ts               (poller ownership on the outer task; per-call ceiling)
edit  src/protocol/event-decoder.ts           (Progress event — follow-up)
edit  src/protocol/types.ts                   (ProgressEvent — follow-up)
edit  src/core/config.ts                      (BC_ISEXECUTING_POLL_INTERVAL, BC_INVOKE_MAX_DURATION)
```

## Test plan (TDD order)

**Unit (fake timers, probe injected):**

1. Probe not due yet (elapsed < interval) → no probe sent.
2. Probe returns `true` at each interval past 3x interval → poller keeps waiting, no verdict.
3. Probe returns `false` → verdict `wedged` immediately, does not wait for the ceiling.
4. Probe returns `error` → verdict `transport-dead`.
5. Elapsed past `ceilingMs` while probe still `true` → verdict `ceiling`.
6. `stop()` before any probe → no verdict, zero dangling timers.
7. `stop()` mid-flight cancels an in-flight probe's verdict.
8. `start()` twice is safe; `pollIntervalMs >= ceilingMs` rejected.
9. Distinct messages for wedged / ceiling / transport-dead.
10. Nested `invokeUnqueued` shares the outer poller; it does not spawn a second one.
11. Settle-then-late-probe: a probe resolving after `stop()` produces no verdict, no unhandled
    rejection.
12. `sendOutOfBand` decodes an answer arriving under `compressedResult` (fixture:
    `src/protocol/captures/isexecuting-concurrent-2026-07-24.json`).
13. `sendOutOfBand` bypasses the send queue — a probe dispatched while a normal invoke's promise is
    unresolved still sends (assert against a controlled fake socket).
14. Explicit per-call `timeoutMs` sets that call's ceiling.
15. Config: `BC_ISEXECUTING_POLL_INTERVAL` / `BC_INVOKE_MAX_DURATION` defaults and invalid-value
    rejection.

**Integration — Cronus281 (BC 28.0) / Cronus28 when its `/csh` recovers:**

16. **Gate A regression**: the `scripts/gate-a-isexecuting.ts` scenario as a test — concurrent
    IsExecuting answers `true`/`false`, no sequence corruption. This is the test that catches BC
    changing the behaviour we depend on.
17. A genuinely long operation (>60 s, e.g. a wide report) completes instead of killing the session,
    with the poller observing `true` throughout.
18. A half-open socket — connection kept open, all inbound data dropped: IsExecuting probes get no
    answer → verdict `transport-dead` and recovery. (Killing the connection outright only tests the
    existing immediate-rejection path at `bc-websocket.ts:111-117`.)
19. Existing session-recovery integration tests unchanged and green.

## Definition of done

- Poller implemented; the rejected idle-deadline rationale retained in the appendix.
- Unit + integration green; existing timeout/recovery tests unaffected.
- `npx tsc --noEmit` clean.
- CLAUDE.md "Session Recovery" updated with the IsExecuting poll mechanism, and "Async Message
  Timing" updated with the retraction so the wrong claim is not re-derived.

## Out of scope

- `bc_cancel_operation`. Now a cheap follow-up, not a redesign: `sendOutOfBand` is the only missing
  piece, and BC handles `CancelAction` on the same pre-processing path as IsExecuting
  (`CallbackHandler.cs:137-157` → `UISession.CancelProgressDialog`, `UISession.cs:969-980`).
- Async operation handles (`operationId` + poll tool).

## Appendix — rejected: idle deadline

Before Gate A closed, the fallback design was an idle-based `InvokeDeadline` that reset on any
inbound frame with a hard ceiling. It is recorded here because it is the correct design *if a future
BC version breaks concurrent IsExecuting*, and because its failure modes explain why the poller is
better.

Its fatal flaw: "any inbound frame" is uncorrelated. Traffic for other open forms, trailing
messages from the previous invoke, and server-initiated requests all reset the timer, so a genuinely
wedged invoke on a chatty session survives to the 600 s ceiling — hang detection regresses from
~35 s. And a *silent* healthy operation still dies at the idle window, which is the exact problem
the feature exists to solve (`ProgressNotificationBlock` is event-driven, not a heartbeat;
`CallbackHandler.HandleRequestCore` awaits `InvokeInteractions` before responding, `:184-211`, so a
long silent AL phase produces no frames). The poller avoids both because it *asks* the server rather
than inferring from traffic. If it is ever resurrected, the raw-frame hook must sit in
`ws.on('message')` before `JSON.parse` (not `routeMessage`), and `sendRpc`'s timeout must exceed the
ceiling rather than equal it.
