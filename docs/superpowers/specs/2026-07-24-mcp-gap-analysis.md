# MCP Flow Coverage — Gap Analysis and Spec Index

**Date:** 2026-07-24
**Revised:** 2026-07-24 after a two-model adversarial review of all seven specs
(`gpt-5.6-sol` + `claude-fable-5`, raw reviews in `.panel/`)
**Status:** Designs revised; two specs blocked on live gates; implementation not started

## Purpose

The server exposes 14 tools and covers most day-to-day BC flows: page open/close, Tell Me search,
company switching, reads (filters, sort, range scrolling, column projection, tabs, factboxes, cues),
writes with validation-error classification and staleness guards, actions (named, system, row-scoped,
cue drill-down), drill-down and row select, dialogs, wizards, report execution with PDF/Excel/Word
byte capture, field lookups, and OData bulk reads.

Seven capability gaps remain. Each gets its own spec, plan, branch, and merge gate.

## The seven gaps

| # | Spec | Size | One-line problem |
|---|---|---|---|
| 1 | [download-capture](2026-07-24-download-capture-design.md) | M | `FileDownloadReady` is decoded but only the report flow consumes it, so "Open in Excel", "Print", and export actions silently drop their bytes. |
| 2 | [multi-row-selection](2026-07-24-multi-row-selection-design.md) | M | The row-select encoder hardcodes a single bookmark, so no bulk action can be driven. |
| 3 | [assist-edit](2026-07-24-assist-edit-design.md) | M | `isLookup` conflates `AssistEditAction` with `LookupAction`, but only `SystemAction.Lookup=110` is ever sent, so AssistEdit fields are advertised and then unreachable. |
| 4 | [filter-pane](2026-07-24-filter-pane-design.md) | M | Flowfilter columns are serialized by BC and never surfaced; quick filter and filter expressions are unreachable. |
| 5 | [long-running-ops](2026-07-24-long-running-ops-design.md) | M | The invoke timeout is absolute, so any post or report exceeding `BC_INVOKE_TIMEOUT` kills a healthy session that is still working. **Gate A passed — IsExecuting polling selected.** |
| 6 | [file-upload](2026-07-24-file-upload-design.md) | L | No upload path: attachments, incoming documents, config packages, and pictures are unreachable. **Path A only** — Path B was cut. |
| 7 | [odata-writes](2026-07-24-odata-writes-design.md) | L | `bc_query` is GET-only, so bulk create/update and API bound actions must crawl through UI pages. |

Sizes rose across the board after review. None of the "S" estimates survived contact with the
security, atomicity, and error-model work the reviewers surfaced.

## Build order

```
1 download-capture  ->  2 multi-row  ->  3 assist-edit  ->  4 filter-pane
                    ->  5 long-running-ops (gated)  ->  6 file-upload  ->  7 odata-writes
```

### Cross-spec dependencies

- **1 -> 6.** Spec 1 extracts `BCHttpClient`. Spec 6 implements `postMultipart` / `deleteJson` on it.
  Spec 1 deliberately does **not** declare those methods early — an unimplemented method would
  violate the project's no-stubs rule.
- **1 <-> 6 test coupling.** Spec 6's strongest test uploads a file and downloads it back through
  spec 1's path, asserting byte equality.
- **5** is independent but gated; if Gate A passes it also makes `bc_cancel_operation` cheap.
- **3 and 4** are independent of everything else and can be parallelised.

## Open gates

No implementation proceeds past its gate.

| Spec | Gate | Why it blocks |
|---|---|---|
| 1 | Style enum (`0/1/2`) located or captured | The mapping is asserted by our decoder but not proven by `ResponseManager`; unknown styles must not be coerced to "download" |
| 4 | Empty-line no-op; Reset semantics; expression grammar | `AddFilterLine` can silently succeed without filtering; `clearFilters` behaviour per filter kind is unknown; `filterExpression` ships only if its grammar is established, otherwise it is cut |
| 5 | ~~A: can `/csh` answer a concurrent `IsExecuting`? B: max inter-frame gap during a silent long op?~~ | **CLOSED 2026-07-24.** Gate A passed: `/csh` answers a concurrent IsExecuting in 1-4 ms with a real `true`/`false` that tracks server processing state, no sequence corruption (probe: `scripts/gate-a-isexecuting.ts`, fixture: `src/protocol/captures/isexecuting-concurrent-2026-07-24.json`). Spec 5 takes IsExecuting polling; Gate B is moot because we poll rather than wait for volunteered frames |
| 6 | One live capture: transport, session/tenant id sourcing, antiforgery, the `InvokeFileUploadAction` payload (`TEMP\` prefix?), `AllowedFileExtensions` grammar | Five unknowns the first draft treated as settled |
| 7 | Bound-action namespace from live `$metadata` | The `Microsoft.NAV` claim was retracted; the qualified name is read from metadata, not guessed |

## Decisions taken during design

1. **Seven separate specs**, one per gap, each with its own cycle.
2. **OData writes go the full distance** — create, update, delete, bound actions — but with
   GUID-only keys and mandatory explicit company selection.
3. **Long-running ops are gate-driven**, not committed to a mechanism. See the correction below.
4. **Destructive integration tests against Cronus28 are allowed**, but must run as single tests with
   `try/finally` cleanup keyed on a unique marker, not as ordered sequences that cascade on failure.
5. **Upload accepts a local path or base64.** The unsandboxed `filePath` read is a recorded product
   decision for a local server, not an oversight.
6. **Downloads surface inline with a per-entry error**, never as a whole-operation failure, and
   never for off-origin URIs.
7. **Multi-row selection is a `bookmarks[]` parameter** on `bc_execute_action`, with the anchor
   required to be a member of the set.
8. **`bc_lookup` gains an explicit `mode`, with no `auto`.** An implicit fallback from candidate
   enumeration into arbitrary AL execution was rejected on safety grounds.

## Correction: the IsExecuting claim was wrong (twice)

The original gap list proposed `DN.IsExecutingHandler` polling. The first revision "corrected" that
to *unavailable*, citing zero matches in `Microsoft.Dynamics.Nav.Service.ClientService`.

**That grep was against the wrong assembly.** `ClientService` serves `/ws/connect`
(`WebSocketController.cs:13-19`, StreamJsonRpc); this client connects to `/csh`, which belongs to
the web-client host whose request model is `CallbackRequestData` in
`Microsoft.Dynamics.Framework.UI.Web` — the same assembly whose `CallbackHandler` matches
`IsExecuting` **by interaction name** (`CallbackHandler.cs:231-247`) and answers it from
`HasEnteredProcessing` *before* `EnterProcessing` (`:97-104`), i.e. while another interaction is
blocked. No `.cs` file in the decompiled tree mentions `/csh` at all.

So IsExecuting is available to us, and the only real constraint was our own send serialisation
(`bc-websocket.ts:210-274`). **Gate A (2026-07-24) confirmed it live**: an out-of-band `IsExecuting`
frame sent on the `/csh` socket while an invoke is outstanding is answered in 1-4 ms with a real
`DN.IsExecutingHandler` carrying `true`/`false` that tracks server processing state, and it does not
corrupt sequence numbers. Spec 5 therefore polls IsExecuting rather than guessing from traffic.

Recorded here at length because the wrong version of this claim was already written into a commit
message, and the next person to grep for it should find the retraction and the live confirmation.

## What the review changed, by spec

Five factual errors were verified and corrected, each of which would have produced broken code:

- **Spec 2**: `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:60` is inside
  `GetFriendlyDescription()`, not an execution fast path; and a stale **anchor** bookmark throws
  `InvalidBookmarkException` (`:32-35`) rather than being silently ignored.
- **Spec 4**: quick-filter parameters are `FilterColumnId` / `FilterValue`
  (`FilterInteractionInput.cs`), not the serializer's outbound `QuickFilterColumnId` /
  `QuickFilterValue`; and `FilterColumns` is discarded by `readProperties`
  (`form-tree-builder.ts:278-311`), so the proposed parser could not have worked.
- **Spec 5**: the assembly error above.
- **Spec 6**: Gate 2 was already answered —
  `[TypeAlias("fla", BrowserType = "DN.FileUploadActionControl")]`.
- **Spec 7**: a stale ETag is **409** + `Request_EntityChanged` (`ExceptionExtensions.cs:103-104`,
  `:186-187`), not 412.

Plus one whole-class omission: every spec's "files touched" list was incomplete, because tool input
schemas live in `src/mcp/schemas.ts` (not the sibling `.tool.ts` modules) and service composition is
duplicated across `src/server.ts`, `src/stdio-server.ts`, and `src/session/session-factory.ts`.

## Deferred to their own specs

- **Upload Path B** (`File.UploadIntoStream` dialogs) — needs its own capture gate; the response
  arrives over the socket via `ServiceCallStack.SetClientReturnValue`, not in the HTTP response.
- **AssistEdit on repeater cells** — needs column-level action metadata, `section`/`bookmark`
  inputs, and `cr/c[N]` targeting together.
- **`bc_cancel_operation`** — cheap if spec 5's Gate A passes.

## Verification standard

Protocol claims are grounded in `U:/git/bc-mcp/reference/bc28/decompiled/`, cited by file and line,
and confirmed against live BC28 before being codified as tests. Every remaining unverified
assumption is an explicit gate in the table above.

The review's lesson, recorded so it is not repeated: citing a line number is not the same as having
read the method it sits in. Four of the five corrected errors were citations to real lines whose
surrounding context said something different.
