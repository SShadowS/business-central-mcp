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

## Feature 3 — Report output capture (SPIKE — uncertain feasibility)
**Problem:** `bc_run_report` executes reports + fills request pages but cannot capture the rendered PDF/Excel/Word. BC delivers the binary over a separate channel (WCF `StreamTransfer`), not inline in the WebSocket.
**Spike approach (timeboxed, may conclude NOT FEASIBLE):**
1. Investigate decompiled: `ReportResultSetDownloadDecorator.SendReportStreamToClient`, `NSClientCallback.DownloadFileAction`, `Connection.DownloadStream`, `BrowserDownloadFileRequest`, `FileActionDialog`. Determine HOW the client obtains the stream: is there a URL/token delivered in a `MessageToShow`/event/handler that the client then GETs over HTTP? Or is it pushed over the WCF callback channel we don't currently consume?
2. If a fetchable URL/token IS delivered through the WebSocket/HTTP session: implement capture — after report OK, detect the download event, fetch the binary via the authenticated HTTP session (reuse the NTLM/cookie auth), return it (base64 or save-to-disk path) from `bc_run_report`.
3. If the binary ONLY comes over a WCF StreamTransfer callback channel bc-mcp doesn't implement: document the exact mechanism + what it would take, conclude the spike as "not feasible without implementing the WCF callback channel," and STOP (do not build a half-thing). Record findings in this spec / a DISCOVERIES note.
**Deliverable either way:** a definitive feasibility finding backed by decompiled evidence and (if possible) a live probe, plus implementation only if a clean path exists.

## Execution
Feature 1, then 2, then the 3 spike. Each: implement (subagent) -> spec+quality review -> verify (unit + targeted integration). Merge the branch at phase end after a full integration gate. Update CLAUDE.md (remove the resolved "Report Output Capture (Phase 6)" limitation only if Feature 3 lands; otherwise update its status with the spike findings).
