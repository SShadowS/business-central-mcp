# Verdict: reject the spec in its current form

The proposed timer abstraction is reasonable engineering, but its protocol premise is not established. More seriously, the spec misidentifies the assembly serving `/csh`, treats receipt of unrelated traffic as operation progress, and provides no evidence that ordinary long-running AL execution emits frames frequently enough to prevent the idle deadline.

## 1. Audit of cited codebase claims

| Spec claim | Finding | Confidence |
|---|---|---|
| `BCSession.invoke` wraps execution in `withTimeout(..., effectiveTimeout + 5000)` | Accurate: `src/session/bc-session.ts:145-161`. The timeout starts inside the queued task, so queue wait time is excluded. | Certain |
| Timeout kills the session with `markDead()` and `closeWs()` | Accurate: `src/session/bc-session.ts:169-176`. | Certain |
| Default `BC_INVOKE_TIMEOUT` is 30 seconds | Accurate: `src/core/config.ts:73-75`; constructor default is also 30 seconds at `src/session/bc-session.ts:15,35-43`. | Certain |
| Existing code proves BC pushes async `Message` notifications during an invoke | **Not proved.** `src/session/bc-session.ts:215-231` merely subscribes and knows how to decode a compressed `Message` if one arrives. This is evidence of client capability, not evidence that BC emits such messages during long AL work. | Certain |
| Async events are merged into the result | Accurate for decoded compressed `Message` notifications: `src/session/bc-session.ts:312-318`. | Certain |
| Every inbound frame passes through `routeMessage` | **False.** Raw data is JSON-parsed first at `src/connection/bc-websocket.ts:99-108`. Invalid JSON never reaches `routeMessage`. Moreover, `routeMessage` returns before notifying handlers for non-object JSON at `:127-128`. WebSocket ping/pong/control frames do not use the `message` callback at all. | Certain |
| Existing `onMessage` handlers run before semantic routing | Accurate only for successfully parsed object messages: `src/connection/bc-websocket.ts:127-140`. | Certain |
| Long AL operations emit progress notifications | **Unsupported overgeneralization.** `ProgressNotificationBlock.cs:91-145` shows that callers can explicitly call `Start`, `Heading`, `BodyText`, and `ControlOptions`, which invoke an `IProgressNotificationMonitor`. It provides no periodic heartbeat and no guarantee that a long posting/report uses it. | Certain |
| Progress notification wire shape is known and can be decoded from heading/body properties | **Not specified or evidenced.** Neither cited progress class shows the handler type, `Message` envelope, serialization shape, or delivery timing. Current `EventDecoder` has no progress branch (`src/protocol/event-decoder.ts:27-50,126-205`), and `BCEvent` has no `Progress` variant (`src/protocol/types.ts:3-14`). | Certain |
| `UISession.CancelProgressDialog` exists | Accurate: `UISession.cs:969-980`. | Certain |
| Server operation timeout provides a final safety cap for this client | The code exists at `ClientHostStartup.cs:65-71`, but its applicability to `/csh` is not established and is likely wrong; see the transport error below. The configured value and whether it is disabled or longer than the proposed ceiling are also unknown. | High |
| Exactly one client invoke is active | Accurate for normal `BCSession.invoke` calls because of the promise queue (`src/session/bc-session.ts:145-161,697-702`) and additionally because `BCWebSocket.enqueueSend` waits for the preceding RPC response (`src/connection/bc-websocket.ts:210-274`). Queue-bypassing internals and inbound server traffic remain exceptions to the broader correlation inference. | High |
| SessionManager uses exponential reconnect backoff | Accurate: `src/session/session-manager.ts:129-165`. Recovery occurs on the next `getSession`, not as part of the timed-out call. | Certain |
| `DN.IsExecutingHandler` remains in handler types | Accurate: `src/protocol/handler-types.ts:1-15`. It is not currently decoded by `EventDecoder`. | Certain |
| `CallbackServiceErrorResponseGenerator` is another IsExecuting consumer | Accurate: `CallbackServiceErrorResponseGenerator.cs:15-22`. | Certain |

There is also an implementation contradiction in the proposed wiring: setting `sendRpc` timeout to exactly the ceiling does **not** ensure that the deadline “never fires first.” Two independently registered timers with the same nominal expiry race. The RPC timeout should be disabled, driven by a common abort signal, or set safely beyond the ceiling.

Existing per-call timeout behavior also needs a migration rule. For example, report flows pass a larger explicit timeout into `invoke` in `src/session/bc-session.ts:515-557`. Replacing that with a global 30-second idle deadline could silently regress those flows. Declaring per-call overrides out of scope does not resolve the existing API semantics.

## 2. Central IsExecuting protocol claim

## **THE SPEC'S CENTRAL TRANSPORT CLAIM IS NOT RELIABLE, AND ITS KEY SUPPORTING PREMISE IS FACTUALLY WRONG.**

The spec says `Microsoft.Dynamics.Nav.Service.ClientService` is “the assembly serving our `/csh` socket.” Decompiled source contradicts that:

- This client constructs `${base}/csh?...` at `src/connection/connection-factory.ts:53-62`.
- The ClientService WebSocket controller is explicitly routed as `[Route("ws")]` plus `[Route("connect")]`, i.e. `/ws/connect`, at `WebSocketController.cs:12-19`.
- That endpoint starts `NsServiceJsonRpcHostFactory`/StreamJsonRpc at `WebSocketController.cs:25-31` and `NsServiceJsonRpcHostFactory.cs:15-34`.
- The project's own verified notes distinguish `/csh` as the web-client WebSocket from `/ws/connect` as StreamJsonRpc in `CLAUDE.md:313-319`.

Therefore, grepping `Microsoft.Dynamics.Nav.Service.ClientService` for `IsExecuting` says nothing about whether `/csh` supports it. It is the wrong assembly/path.

Furthermore, `CallbackHandler` treats IsExecuting as an ordinary `CallbackRequestData` interaction:

- Detection: `CallbackHandler.cs:231-247`.
- Handling and acknowledgement: `CallbackHandler.cs:129-136`.
- Response generation: `CallbackHandler.cs:267-276`.
- There is no transport guard in that code saying “HTTP only.”
- The current encoder sends the same callback request model—`interactionsToInvoke`, `sequenceNo`, `lastClientAckSequenceNumber`, `navigationContext`, etc.—inside `/csh` JSON-RPC `Invoke` calls at `src/protocol/interaction-encoder.ts:48-73`.

This does not, from the files I could inspect, conclusively prove that `/csh` accepts a concurrently issued IsExecuting request. The missing ground-truth piece is the decompiled `/csh` endpoint/bridge showing how `OpenSession`, `Invoke`, and `Message` dispatch to `CallbackHandler`. But it conclusively invalidates the spec's “no matches in ClientService, therefore unavailable on `/csh`” argument.

Before implementation, this needs a mandatory verification gate:

1. Locate the decompiled `/csh` host and trace its `Invoke` dispatch.
2. Send an `Invoke` whose sole interaction is `IsExecuting` against a live `/csh` session.
3. Determine whether it can be sent concurrently while another invoke is outstanding.
4. Determine whether the same socket can multiplex it or whether browser behavior uses a parallel HTTP/WebSocket channel.
5. Capture the actual `DN.IsExecutingHandler` response.

Until that is done, the “Correction to the original plan” must not be treated as verified protocol fact.

**Confidence:** high that the spec's assembly/path attribution is wrong; medium that `/csh` can drive IsExecuting somehow; low on whether it can be multiplexed over this exact socket without a second channel.

## 3. Idle deadline plus hard ceiling

An idle deadline reset by **any** inbound frame is not an operation-progress detector. At best, it is a weak session-traffic detector.

### Failure modes

1. **Unrelated form traffic masks a dead invoke.**  
   A single session owns multiple forms. Notifications for any form, delayed messages from the previous invoke, server-initiated requests, or session-level changes would reset the active deadline despite having no relationship to the outstanding callback.

2. **A chatty server masks an application hang.**  
   Repeated notifications, warnings, telemetry-like protocol traffic, or malformed-but-parseable objects can keep the idle timer alive until the hard ceiling.

3. **A valid but silent operation is killed after 30 seconds.**  
   This is the most serious problem. A long SQL query, report rendering stage, `Sleep`, lock wait, external service call, or posting phase may produce no UI progress calls. The proposal then behaves exactly like today's absolute 30-second timeout.

4. **Serialization does not provide correlation.**  
   The queue proves that only one client invoke was sent, but it does not prove that every inbound frame relates to that invoke. The inference in the spec is invalid.

5. **Late traffic can be attributed to the next invoke.**  
   The implementation explicitly acknowledges a best-effort 150 ms quiescence window (`CLAUDE.md:342-344`). A notification arriving after that can touch the following operation's timer.

6. **Hard ceiling remains an arbitrary destructive timeout.**  
   A legitimate month-end job can exceed ten minutes. Killing the socket at 600 seconds preserves the commit ambiguity the design is meant to reduce. A per-operation or per-call ceiling remains necessary.

7. **Transport liveness and operation liveness are conflated.**  
   WebSocket ping/pong can determine whether the connection is alive, but it cannot determine whether AL execution is making progress. Conversely, application `Message` frames need not prove transport health if they are unrelated.

8. **Malformed-frame semantics are dangerous and inconsistent.**  
   Counting malformed traffic as liveness allows a corrupt/chatty peer to suppress idle expiry. The proposed hook also cannot see malformed JSON if placed in `routeMessage`; it would need to run in the raw `message` callback before `JSON.parse`.

9. **Nested `invokeUnqueued` calls are underspecified.**  
   Modal reconciliation calls `invokeUnqueued` recursively. If every such call creates a deadline, multiple active timers/listeners can coexist. The spec must say whether the deadline belongs to the outer queue task, each RPC attempt, or the entire logical operation.

10. **Socket-close race and cleanup need specification.**  
    Expiry closes the socket, which rejects `sendRpc`, while the deadline also attempts to settle the outer operation. Tests should prove single settlement, listener cleanup, and no unhandled rejection.

### Better direction

Unless BC provides a proven correlated heartbeat, separate the concerns:

- WebSocket ping/pong or close/error handling for transport failure.
- A configurable hard operation deadline, preferably per operation/call.
- Correlated IsExecuting/progress polling if `/csh` supports it.
- Otherwise, accept that client-side code cannot distinguish a silent healthy operation from a server hang and choose a conservative ceiling rather than pretending arbitrary traffic is progress.

**Confidence:** high.

## 4. Does BC emit traffic during long AL execution?

The cited evidence does not show that it does.

`CallbackHandler.HandleRequestCore` awaits `InvokeInteractions` before generating the callback response (`CallbackHandler.cs:184-211`). Thus the normal synchronous response cannot arrive until execution completes.

`ProgressNotificationBlock` is event-driven, not timer-driven. It emits only when application/runtime code explicitly invokes start/update/end methods. Nothing in it guarantees:

- that posting or report code invokes those methods;
- that updates occur at least every 30 seconds;
- that `IProgressNotificationMonitor.UpdateWork` produces a `/csh` `Message`;
- that the message is flushed while the original callback is still executing rather than buffered until completion.

Therefore, a WebSocket can plausibly be completely silent for minutes. A long operation that spends 90 seconds in SQL before its next explicit progress update is enough to defeat this design.

### Evidence that would settle it

The verification gate should require both:

1. **Decompiled chain:** trace `IProgressNotificationMonitor.UpdateWork` through its concrete web implementation to the exact handler array, `Message` notification, and flush mechanism. Look for a periodic guarantee, not merely a callback when progress changes.
2. **Timed live capture:** record every raw `/csh` frame with monotonic timestamps during:
   - a controlled 60–90 second AL sleep/busy loop with no progress API;
   - the same operation with explicit progress updates;
   - representative posting and report operations;
   - a long SQL/lock-wait phase.

The test should report the maximum inter-frame gap and decoded origin of every frame. A single successful chatty report is not enough to generalize to posting or imports.

Until this evidence exists, the design should assume valid operations can be silent.

**Confidence:** high that the cited evidence is insufficient; medium-high that some legitimate operations can be silent for longer than 30 seconds.

## 5. Test-plan holes

The test plan is inadequate for the protocol risk.

Missing tests or gates include:

- A live raw-frame capture proving intermediate traffic actually occurs.
- A valid long operation intentionally producing no progress traffic.
- A half-open/blackholed socket test. Closing the connection mid-invoke only tests the existing immediate close rejection, not idle expiry.
- An unrelated notification from another form while the active RPC is hung.
- Late traffic from the preceding invoke touching the next invoke.
- A chatty-but-hung operation reaching the ceiling.
- Exact RPC-timeout-versus-ceiling race behavior.
- Existing explicit `timeoutMs` overrides, especially report flows.
- Nested modal reconciliation and retry timer ownership.
- Multiple `start()` calls, touch-before-start, `idleMs >= ceilingMs`, zero/negative configuration, exact-boundary races, and thrown `onExpire`.
- Single-settlement and no-unhandled-rejection behavior when expiry closes the socket.
- Listener cleanup after success, RPC error, deadline expiry, and session close.
- Raw invalid JSON versus valid non-object JSON versus unknown JSON-RPC objects.
- WebSocket ping/pong semantics.
- Progress decoder fixtures. The proposed wire shape is not even concretely specified.
- Logging rate limiting/deduplication for frequent progress updates.
- Queue drain behavior after idle and ceiling expiry.
- Configuration tests for `BC_INVOKE_MAX_DURATION`, precedence when all three variables are set, and invalid values.

The fallback integration proposal—set idle to 2 seconds and “use any normal report”—is not sufficient. The operation must demonstrably last longer than the idle interval and receive attributable frames with no gap exceeding that interval. Otherwise it does not exercise timer reset at all.

Integration test 11 should simulate a socket that remains open but drops all inbound data. A cleanly killed connection already rejects pending RPCs immediately at `src/connection/bc-websocket.ts:111-117`.

**Confidence:** high.

## 6. Cancellation scope

Deferring a user-facing cancellation tool is reasonable as a separate feature, but the rationale should be more precise.

The decompiled protocol already has a `CancelAction` path in `CallbackHandler.cs:137-157`, which invokes `UISession.CancelProgressDialog`. The present client cannot send it while another request is outstanding because `BCWebSocket.enqueueSend` serializes an RPC through its response, not merely through socket send completion (`src/connection/bc-websocket.ts:210-274`). Supporting cancellation therefore requires either safe RPC multiplexing, bypassing that queue for a narrowly defined cancel request, or another authenticated channel.

That is substantial enough to defer. However:

- The spec should cite `CancelAction`, not just the underlying `UISession` method.
- It should not imply a second channel is proven to be the only solution.
- Hard-closing the socket on timeout is itself an uncontrolled form of cancellation and can leave commit outcome ambiguous.
- If expected operations routinely approach the hard ceiling, graceful cancellation may become a safety prerequisite rather than optional polish.

**Confidence:** high.

## Top 3 concerns

1. **The central IsExecuting rejection rests on the wrong server assembly:** `/ws/connect` ClientService was searched, while this client uses `/csh`.
2. **No evidence guarantees inbound frames during long AL work:** a valid silent operation still dies after 30 seconds, defeating the feature.
3. **“Any frame” is uncorrelated:** unrelated or stale traffic can keep a genuinely dead invoke alive until the destructive hard ceiling.