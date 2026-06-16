# Capability (Phase 3) — Design

**Date:** 2026-06-16
**Branch:** `feat/capability`
Three features, executed in order of certainty. The reliable suite + typed errors (Phases 1/1b) are the foundation.

## Feature 1 — Staleness / generation tokens (well-defined)
**Problem:** A `pageContextId` can be valid (page still open) yet its STATE has drifted since the LLM last read it — async `Message` events or a sibling operation mutated the form, so a bookmark/row the LLM intends to act on no longer means what it did. `bc_execute_action`/`bc_write_data` then target the wrong row silently.

**Design:**
- `PageContext` gains a monotonic `generation: number` (starts at 0), bumped by `PageContextRepository` whenever an applied event actually changes form state or rows (i.e. in `applyToPage`/`applyEvent` when a mutation is non-empty). One bump per applied event-batch that mutates; no bump for no-op batches.
- Read-side outputs include the current generation as `stateVersion`: `bc_open_page` and `bc_read_data` outputs gain `stateVersion: number`.
- Mutating tools accept an OPTIONAL `expectedStateVersion?: number` input: `bc_write_data`, `bc_execute_action`. When provided and != the context's current generation, the operation returns `err(new StaleContextError(...))` (new error, code `STALE_CONTEXT`) BEFORE sending anything to BC. When omitted, behavior is unchanged (opt-in guard — no breaking change for callers that don't pass it).
- `errorHint('STALE_CONTEXT')` = "The page changed since you last read it (stateVersion mismatch). Re-read with bc_read_data to get the current stateVersion, then retry."
- Tool descriptions updated to explain the stateVersion round-trip.

**Tests:** unit — generation bumps on mutating event, not on no-op; StaleContextError raised on mismatch, passes through on match/omitted. Integration — open page (capture stateVersion), mutate via a write, assert stateVersion advanced; a stale expectedStateVersion is rejected with STALE_CONTEXT.

## Feature 2 — Idempotent teardown / server-side session reap (small/medium)
**Problem:** `bc_close_page` / session close can fail midway (dialog mid-close, connection drop), leaking BC-side form/session state that blocks new sessions for the same user (the residual-risk class noted in Phase 1).
**Design:**
- `BCSession.closeGracefully` already best-effort closes forms. Add a final reap guarantee: if graceful form-close fails or times out, ensure the session is torn down server-side — send the session-close/abort that frees the BC slot (verify the exact mechanism against decompiled: likely closing the WS triggers server session disposal, but confirm whether an explicit logoff/CloseSession interaction is needed to release the NTLM slot promptly). Make close idempotent: calling it twice is safe; a failed close still marks dead + closes the WS.
- `ClosePageOperation`: on a close that errors, still invalidate the local page context and return a clear result (not a hang). Ensure no path leaves a page context referencing a dead form.
**Tests:** unit — double-close is safe; close after death is a no-op that still resolves; close-with-error still tears down. Integration — close a page then confirm a fresh open on the same user succeeds promptly (no NTLM-slot block).

## Feature 3 — Report output capture (SPIKE COMPLETE — deferred, mechanism documented)

**Spike result:** NOT IMPLEMENTED. The mechanism is feasible in principle but requires a non-trivial protocol layer addition. Deferred.

**Exact download mechanism (confirmed from decompiled source + live probe 2026-06-16):**

BC delivers the report binary via an **inbound JSON-RPC call over the same WebSocket**, NOT via WCF StreamTransfer callback. The chain:

1. `ReportResultSetDownloadDecorator.SendReportStreamToClient` (`Microsoft.Dynamics.Nav.Ncl/Microsoft.Dynamics.Nav.Runtime.Report/`) calls `session.ClientCallback.DownloadFileAction(stream, displayDialog:false, caption, ...)`.
2. `NSClientCallback.DownloadFileAction` (`Microsoft.Dynamics.Nav.Service/`) stores the stream: `Connection.DownloadStream = new StreamTransfer(stream)` and calls `ClientContract.FileActionDialog(fileActionRequest)` — where `ClientContract` is the JSON-RPC proxy created by `jsonRpc.Attach<IClientCallbackApi>()` in `NsServiceJsonRpcHostFactory.CreateAndRunNsServiceJsonRpcService` (`Microsoft.Dynamics.Nav.Service.ClientService/`).
3. This fires a **synchronous inbound JSON-RPC request** `{ "jsonrpc": "2.0", "method": "FileActionDialog", "id": "<guid>", "params": [<FileActionRequest>] }` FROM BC TO OUR CLIENT over the same WebSocket. BC's report execution is BLOCKED until we respond.
4. The correct response is `{ "jsonrpc": "2.0", "id": "<guid>", "result": <FileActionResponse> }` with `IsFileAccessed: true` and the chosen filename.
5. While BC is blocked waiting, the bytes are available at `GET /BC/client/uploadDownload/download` (same domain, same NTLM/cookie session) — `UploadDownloadController.Download()` (`Microsoft.Dynamics.Nav.Service.ClientService/`) reads `Connection.DownloadStream` and serves `application/octet-stream`.

**Live probe findings:**
- Report 6 (Trial Balance) request page uses `SystemAction: 410` ("Send to...") to initiate download — NOT `SystemAction: 300` (OK). `SystemAction: 410` opens a format-choice sub-dialog (`MappingHint: "PrintDialog"`); `SystemAction: 400` = Preview (PDF in browser).
- Neither `SystemAction: 410` nor `SystemAction: 300` triggered a `FileActionDialog` inbound call in the probe — full sub-dialog navigation (choosing a format inside the "Send to..." dialog) is required before BC sends `FileActionDialog`.
- No `FileActionDialog` calls arrived as inbound JSON-RPC requests during any of the tested interactions, confirming our client currently ignores them (they have `id` and `method` but no matching `pendingRequests` entry so they are silently dropped in `BCWebSocket.routeMessage`).

**Why deferred (not "not feasible"):**
The bytes ARE reachable over plain HTTP with the existing NTLM/cookie auth. Implementation requires:
1. `BCWebSocket.routeMessage`: detect messages with `method` + `id` (inbound JSON-RPC requests, not responses) and dispatch them to a registered handler rather than dropping them.
2. A `FileActionDialog` handler in `BCSession` that: (a) sends back `{IsFileAccessed:true, FileName: "<suggested>"}` immediately, (b) concurrently GETs `/BC/client/uploadDownload/download` with the session cookies to pull the stream bytes.
3. Report request-page navigation needs to handle the `SystemAction: 410` -> format-choice sub-dialog before download is triggered.
4. `bc_run_report` output gains a `downloadBytes` (base64) or `downloadPath` field.

This is ~2-3 days of protocol work. The CLAUDE.md Known Limitations section has been updated with the full mechanism.

## Execution
Feature 1, then 2, then the 3 spike. Each: implement (subagent) -> spec+quality review -> verify (unit + targeted integration). Merge the branch at phase end after a full integration gate. Update CLAUDE.md (remove the resolved "Report Output Capture (Phase 6)" limitation only if Feature 3 lands; otherwise update its status with the spike findings).
