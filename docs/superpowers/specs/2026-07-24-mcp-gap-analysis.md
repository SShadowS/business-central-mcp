# MCP Flow Coverage — Gap Analysis and Spec Index

**Date:** 2026-07-24
**Status:** Design approved, specs written, implementation not started

## Purpose

The server exposes 14 tools and covers most day-to-day BC flows: page open/close,
Tell Me search, company switching, reads (filters, sort, range scrolling, column
projection, tabs, factboxes, cues), writes with validation-error classification and
staleness guards, actions (named, system, row-scoped, cue drill-down), drill-down and
row select, dialogs, wizards, report execution with PDF/Excel/Word byte capture,
field lookups, and OData bulk reads.

Seven capability gaps remain. Each gets its own spec, plan, branch, and merge gate.

## The seven gaps

| # | Spec | Size | One-line problem |
|---|---|---|---|
| 1 | [download-capture](2026-07-24-download-capture-design.md) | S | `FileDownloadReady` is decoded but only the report flow consumes it, so "Open in Excel", "Print", and export actions silently drop their bytes. |
| 2 | [multi-row-selection](2026-07-24-multi-row-selection-design.md) | S | The row-select encoder hardcodes a single bookmark, so no bulk action (batch post, multi-delete, apply entries) can be driven. |
| 3 | [assist-edit](2026-07-24-assist-edit-design.md) | S | `isLookup` conflates `AssistEditAction` with `LookupAction`, but only `SystemAction.Lookup=110` is ever sent, so AssistEdit fields are advertised and then unreachable. |
| 4 | [filter-pane](2026-07-24-filter-pane-design.md) | M | Flowfilter columns ("Filter totals by") are serialized by BC and never surfaced, and there is no raw filter-expression path. |
| 5 | [long-running-ops](2026-07-24-long-running-ops-design.md) | M | The invoke timeout is absolute, so any post or report exceeding `BC_INVOKE_TIMEOUT` kills a healthy session that is still working. |
| 6 | [file-upload](2026-07-24-file-upload-design.md) | L | No upload path at all: attachments, incoming documents, config packages, bank statement import, and item pictures are unreachable. |
| 7 | [odata-writes](2026-07-24-odata-writes-design.md) | L | `bc_query` is GET-only, so bulk create/update and API bound actions must crawl through UI pages. |

## Build order

Small protocol wins first, session-layer risk in the middle, largest surfaces last:

```
1 download-capture  ->  2 multi-row  ->  3 assist-edit  ->  4 filter-pane
                    ->  5 long-running-ops  ->  6 file-upload  ->  7 odata-writes
```

### Cross-spec dependencies

- **1 -> 6.** Spec 1 extracts `BCHttpClient` (session-authenticated HTTP side channel) out of
  `ReportDownloader`. Spec 6 uploads through that same client. Build 1 first or spec 6 has to
  build the transport itself.
- **5 -> 6, 5 -> 7.** Uploads of large files and OData bound actions that post documents are both
  long operations. They are more pleasant to verify once the idle-deadline work in spec 5 lands,
  but neither strictly blocks.
- **3 and 4** are independent of everything else and can be parallelised if desired.

## Decisions taken during design

1. **Seven separate specs**, one per gap, each with its own cycle. Not bundled.
2. **OData writes go the full distance** — create, update, delete, and bound actions.
3. **Long-running ops use an idle deadline**, not `IsExecuting` polling. See the correction below.
4. **Destructive integration tests against Cronus28 are allowed.** CRONUS demo data is disposable.
5. **Upload accepts a local path or base64**, so the tool still works when the server is remote
   from the client.
6. **Downloads surface inline** on every mutating tool as a `downloads[]` array, no fetch token.
7. **Multi-row selection is a `bookmarks[]` parameter** on `bc_execute_action`, not a new tool —
   BC models selection as action context, not as a standalone verb.

## Correction: IsExecuting is not available on our transport

The initial gap list proposed a `DN.IsExecutingHandler` polling loop for long operations. That is
wrong for this client.

`IsExecuting` is an artifact of BC's **HTTP long-poll** callback path. The client sends an
interaction literally named `IsExecuting` and the server answers with a
`DN.IsExecutingHandler` envelope carrying `"true"` / `"false"` / `"invalidsession"`:

- `Microsoft.Dynamics.Framework.UI.Web/CallbackHandler.cs:231` — `IsIsExecutingRequest`
  matches a request whose single interaction is named `IsExecuting`.
- `Microsoft.Dynamics.Framework.UI.Web/CallbackHandler.cs:267` — `GenerateIsExecutingResponse`
  builds the `DN.IsExecutingHandler` response.
- `Microsoft.Dynamics.Framework.UI.Web/CallbackServiceErrorResponseGenerator.cs:19` — the only
  other consumer.

A search for `IsExecuting` across `Microsoft.Dynamics.Nav.Service.ClientService` — the assembly
that serves the WebSocket this client connects to — returns **no matches**. There is no busy-poll
to send over `/csh`.

The handler string stays in `src/protocol/handler-types.ts` because a mixed-mode server can still
emit it; it is simply never the mechanism we drive. Spec 5 uses an idle-based deadline instead.

## Verification standard for all seven

Every spec follows the project rule: protocol claims are grounded in
`U:/git/bc-mcp/reference/bc28/decompiled/`, cited by file and line, and confirmed against live
BC28 (Cronus28) before the behaviour is codified as a unit test. Where a spec still contains an
unverified assumption, it is marked as an explicit **verification gate** that must be closed
before the rest of that spec's implementation proceeds.
