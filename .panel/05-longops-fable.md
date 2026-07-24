# Adversarial Review: Long-Running Ops Spec

## 1. Accuracy of codebase claims — mostly accurate

Verified against source:

- **`bc-session.ts:157-161` withTimeout wrap** — ✅ accurate. `invoke` wraps the queued task in `withTimeout(..., effectiveTimeout + 5000)` at exactly those lines. Confidence: high.
- **`bc-session.ts:173-176` markDead + closeWs on expiry** — ✅ accurate; the timer body calls `this.markDead(); this.closeWs();` (bc-session.ts:~174-175). Confidence: high.
- **`bc-session.ts:215-229` subscribes to async Message notifications** — ✅ the `ws.onMessage` subscription filtering `method === 'Message'` is at those lines. **But note what it proves and what it doesn't** — see §4. Confidence in citation: high; confidence in the inference drawn from it: low.
- **`bc-websocket.ts:104-107` single chokepoint → `routeMessage`, handlers at 128-140** — ✅ accurate (`setupHandlers` parse→routeMessage at ~104-110; handler fan-out at ~131-140). One nit: frames that **fail JSON.parse never reach `routeMessage`** (caught at bc-websocket.ts:107-111), so spec test #7 ("onAnyFrame fires for a malformed frame") is only satisfiable if the hook is moved into the `ws.on('message')` callback, not `routeMessage` as the spec says. Small but real inconsistency. Confidence: high.
- **`ClientHostStartup.cs:70` UseCancellationMiddleware with ClientServicesOperationTimeout** — ✅ verified verbatim. Confidence: high.
- **`UISession.cs:969-978` CancelProgressDialog** — ✅ both overloads present at those lines. Confidence: high.
- **`ProgressNotificationBlock.cs`** — ✅ exists with Start/End/Heading/BodyText and an `IProgressNotificationMonitor`. But this only proves the server-side *abstraction* exists; it says nothing about wire delivery timing. Confidence in citation: high.
- **Config default 30s** — ✅ `invokeTimeoutMs: optionalEnvInt('BC_INVOKE_TIMEOUT', 30000)` (config.ts:89).

## 2. The central protocol claim — the citations are real but the argument is flawed

`CallbackHandler.cs` verified: `IsIsExecutingRequest` at line ~231, `GenerateIsExecutingResponse` at ~267, and `HandleRequestCore` answers IsExecuting from `clientSession.HasEnteredProcessing` **before** `EnterProcessing` (CallbackHandler.cs:~99-104) — i.e., it is expressly designed to be answerable *while* another interaction is blocked. Confidence: high.

The flawed step is the inference. **`IsExecuting` is not a property of the HTTP transport; it is matched by interaction name inside `CallbackHandler`, which is transport-agnostic.** And the project's own CLAUDE.md documents that `/csh` responses ARE CallbackHandler/ResponseManager products (`DN.LogicalClientEventRaisingHandler` with inline `UriToShow`, `DN.*` handler arrays — the report-capture section). So the request path over this WebSocket very likely lands in `CallbackHandler.HandleRequestCore`, where an interaction named `IsExecuting` would be matched. Grepping `Microsoft.Dynamics.Nav.Service.ClientService` and finding nothing proves only that the *transport shim* doesn't mention the string — which is exactly what you'd expect for a name matched in a downstream, shared assembly. I could not run a grep myself (no shell tool in this harness), so I cannot confirm the "no matches" claim either way; but even granting it, it does not support the conclusion.

The genuinely open question is whether a second JSON-RPC request can be *dispatched concurrently* on the same `/csh` socket while an invoke is blocked. If yes, IsExecuting polling (and CancelAction — same pre-EnterProcessing treatment, CallbackHandler.cs:~106-121) works fine over this transport, and the spec's foundational correction collapses. If the socket dispatcher serializes, the spec's conclusion stands for the wrong reason. **This is unverified in the spec and easily testable live: send an IsExecuting-named interaction mid-invoke on a second in-flight RPC and see what comes back.** Confidence that the spec's reasoning is unsound: high. Confidence that IsExecuting actually works over `/csh`: medium — needs the live test.

## 3. Idle deadline + ceiling — reasonable shape, real failure modes

The serialized queue does make correlation trivial (one invoke in flight), verified in `bc-session.ts`. But:

- **Chatty server masking a hang** — the worst one. The confirmed BC hung-invoke bug currently gets caught at ~35 s. Under this design, *any* unrelated inbound frame — a trailing Message notification from a previous form, a navigation-service push, an inbound request from BC — resets the idle timer. A wedged invoke on a session with background chatter now survives to the 600 s ceiling. Since `sendRpc`'s own timeout is raised to the ceiling too, there is no second line of defence. Mitigation not in spec: only count frames that plausibly belong to the session's activity, or at minimum log every touch with the frame type so operators can see what kept it alive.
- **Dead-invoke-kept-alive by role-center/factbox residue** — same mechanism; the session keeps multiple forms open (`openFormIds`), and BC pushes property changes for them asynchronously.
- **WS ping/pong** — the `ws` library answers pings below `message` events, so pings correctly do *not* feed the timer. Good, but nowhere stated; worth an explicit test that transport keepalives don't count as progress.
- Interaction with the queue is fine: the deadline starts inside the queued task, mirroring the current design's correct decision to not count queue wait.

## 4. Does BC actually talk during a long AL op? — the spec's weakest, load-bearing, unverified assumption

The cited evidence proves less than claimed:

- `bc-session.ts:215-229` proves the client *can receive* async Message notifications. But the existing, documented behaviour (CLAUDE.md "Async Message Timing") is about **trailing** messages caught in a 150 ms post-response quiescence window — i.e., messages arriving *after* the RPC response, not *during* a blocked invoke. Nothing in the repo demonstrates mid-invoke pushes.
- `ProgressNotificationBlock` fires only when AL actually drives a dialog (`Dialog.Open/Update`, posting routines mostly do). But plenty of long operations are silent: report dataset generation, a slow `CALCFIELDS`/query, a long `COMMIT`, `MODIFYALL` without a dialog. On the HTTP client, the *reason IsExecuting exists* is precisely that the server can be silent for the duration of an interaction. If the same silence holds on `/csh`, a healthy 3-minute silent post dies at 30 s idle — the design fails for exactly the scenario in its problem statement, just with a different error message.
- Also unresolved: even where a ProgressNotificationMonitor emits, is delivery to a `/csh` client immediate, or buffered until the interaction result flushes? I found no decompiled evidence either way in the files I read; I did not locate the concrete `IProgressNotificationMonitor` implementation.

**Evidence that would settle it:** a wire capture on Cronus28 of a >60 s operation (batch journal post with a posting dialog, and separately a long report *without* one), logging frame timestamps. If the socket shows gaps > idle window, the design needs a fallback (e.g. the IsExecuting probe from §2, or a WS-level ping treated as "connection alive, extend cautiously"). The spec should have a **verification gate** here; the gap-analysis explicitly promises gates for unverified assumptions, and this spec doesn't declare one. That is its biggest process failure.

## 5. Test plan — decent on the unit side, holed on the parts that matter

Good: fake-timer unit coverage of the policy object is thorough (tests 1-6).
Holes:

- Test 10's fallback (`BC_INVOke_IDLE_TIMEOUT=2000` + any report) tests the *mechanism* but silently dodges the §4 question: it only passes if BC emits frames at <2 s intervals, and if it does pass that way, nobody has learned whether a real 3-minute post has 30 s+ silent gaps. The plan should mandate measuring **maximum inter-frame gap** during a genuinely long op, not just pass/fail.
- No test for "unrelated inbound traffic keeps a hung invoke alive until the ceiling" — the regression risk to the confirmed BC hang bug is untested.
- No integration test of the ceiling path at all.
- Test 7 (malformed frame) contradicts the stated hook placement (see §1).
- No test that outbound frames / WS pings do not touch the timer.

## 6. Scope — deferring cancellation is right, but the rationale is shaky

Deferring `bc_cancel_operation` is the correct call for a size-M spec. But the stated reason — "needs a second channel into a session whose queue is blocked" — is the *client's own* queue, which is self-imposed; and `CancelAction` gets the same pre-EnterProcessing treatment as IsExecuting server-side (CallbackHandler.cs:~106-121). If the §2 concurrency test shows a second in-flight RPC works, cancellation is much cheaper than the spec implies. Fine to defer; the reasoning should be corrected so the deferral doesn't harden into "impossible."

## Top 3 concerns

1. **Unverified load-bearing assumption (§4):** no evidence BC emits inbound frames during a silent long AL operation on `/csh`. If the socket is quiet for minutes, the idle deadline kills exactly the healthy operations the spec exists to save. Needs a mandatory wire-capture verification gate before implementation, which the spec omits despite the gap-analysis promising gates.
2. **The IsExecuting correction is argued from the wrong assembly (§2):** the interaction is matched by name in transport-agnostic `CallbackHandler`, which demonstrably serves `/csh` responses per this project's own CLAUDE.md. A one-hour live test (second in-flight RPC with an `IsExecuting` interaction mid-invoke) could invalidate the spec's foundation — and would simultaneously unlock cancellation.
3. **Hang detection regresses from 35 s to up to 600 s** whenever any unrelated frame arrives (§3), with `sendRpc`'s timeout also raised to the ceiling so nothing else fires. For the confirmed BC hung-invoke bug this is a real operational regression, and the test plan doesn't cover it.