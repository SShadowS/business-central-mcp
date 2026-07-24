# Adversarial review: "Generic Download Capture" spec

## 1. Accuracy of codebase claims

Verified against source:

- **`event-decoder.ts:173-188`** — accurate. The `UriToShow` case is at lines ~173-191 and emits `FileDownloadReady` with `relativeUrl` + `style` (default `'1'`). **Confidence: certain.**
- **`bc-session.ts:644`** — accurate. Line 644 is exactly `const dlReady = okResult.value.find(e => e.type === 'FileDownloadReady')` inside `runReportWithDownload`. **Confidence: certain.**
- **`execute-action.ts:29-37`** — accurate. `ExecuteActionOutput` sits there and has no download field. **Confidence: certain.**
- **`report-downloader.ts:14-22`** — accurate as a citation (the NTLM/HandlerSessionId comment). But note the environment inconsistency: CLAUDE.md states Cronus28 uses **NavUserPassword, not NTLM**, while the spec and the code comment talk about "NTLM/cookie headers". Functionally the same `getWebSocketHeaders()` is reused, so the claim's substance ("existing auth headers suffice") is presumably true, but the wording perpetuates a wrong auth label. **Confidence: high** on substance, the label is sloppy.
- **"Only one caller consumes it"** — accurate. Grep-by-eye: `FileDownloadReady` is consumed only in `runReportWithDownload`; `ActionService.invokeAction` completes on `InvokeCompleted` and discards download events. **Confidence: high.**
- **`createReportDownloader` in `connection-factory.ts`** — exists as claimed (line ~45). **Confidence: certain.**
- I did **not** read `respond-dialog.ts`, `wizard-navigate.ts`, the `*.tool.ts` files, `bc-websocket.ts`, or `config.ts`, so I cannot vouch for the claimed edits there being as small as implied.

## 2. Accuracy of BC protocol claims

- **`RegisterUriToShowEvents` exists and emits `DN.LogicalClientEventRaisingHandler` with `[eventName, uri, style]`** — confirmed in `ResponseManager.cs` (`RegisterUriToShowEvents` + `AddUriToShowEventResponseParameters`, which writes `FormattedUri ?? Address` then `Style.ToString("D")`). **Confidence: certain.**
- **Style `0/1/2 = View/Download/Print`** — NOT verifiable from the provided decompiled files. `ResponseManager.cs` only shows the style serialized as a decimal string; the `UriToShowStyle` enum itself is not in either cited file. The spec cites "`ResponseManager` confirmed" — that is an overclaim; ResponseManager confirms only that a numeric style exists. It's probably right (live capture backs `1=Download`), but the evidence table cites the wrong artifact. **Confidence: medium** on the mapping itself.
- **`DynamicFileHandler.axd` keyed on `HandlerSessionId`** — confirmed in `FileUrlAddressProvider.cs`. **However**: `FileUrlAddressProvider` writes only `form`, `sessionid`, `type`, `fid`. There is **no `fname` parameter** in this code path. CLAUDE.md and the collector design assume `fname=<filename>` in the URL. Either `fname` is appended elsewhere (FormattedUri path?) or only in some flows. The spec's `suggestedFileName` extraction from `fname` rests on a live capture, not on the cited decompiled source, and may be absent for non-report downloads (attachments, config-package export). Test plan should not assume `fname` exists. **Confidence: high** that the discrepancy is real.
- **Bigger protocol miss:** `UriToShow` is BC's generic "show a URI" event. AL `HYPERLINK('https://external...')` and mail-to/tel links are delivered through the **same event** (`FormattedUri ?? Address` — an arbitrary absolute URI). The spec treats every `FileDownloadReady` as a fetchable download. `ReportDownloader.downloadFromUrl` happily fetches absolute `http` URLs **with BC auth headers attached** (report-downloader.ts:26-40). Under this spec, an action that calls `HYPERLINK` to an external site would cause the MCP server to GET an arbitrary external URL with the session's auth cookies — a credential-leak and SSRF-shaped behavior. The collector must filter to relative/`DynamicFileHandler.axd` URLs (or at minimum same-origin) and surface external URIs as a distinct `externalUri` field. The spec is silent on this. **Confidence: high** that this is a real hole (the event decoder currently converts *any* UriToShow, including `style 0` view URIs, into `FileDownloadReady`).

## 3. Design soundness

- The three-unit split is reasonable but slightly over-engineered for the size: `collectDownloads` is a ~15-line filter/map. Fine as a pure seam; not objectionable.
- Extracting `BCHttpClient` now with a **declared-but-unimplemented `postMultipart`** violates the project's own "no stubs" rule (CLAUDE.md). Declare the class, implement only `get`, and let spec 6 add `postMultipart` — don't put an unimplemented method in the interface now.
- `DownloadService.fetchAll` losing the per-call timeout is a regression risk: `runReportWithDownload` currently uses `max(timeoutMs, 120000)` for the fetch. The proposed `fetchAll(refs)` signature has no timeout parameter. Large Excel exports will need it.
- Wiring the service into `ActionService` etc. is right, but note events from `positionRow`/`selectRow` (execute-action.ts:100-121) are a second invoke whose events are discarded — unlikely to carry UriToShow, but worth stating which event stream the collector runs over per operation (the spec doesn't).

## 4. Missed failure modes / protocol realities

1. **External/`view` URIs via UriToShow** (above) — the single biggest miss.
2. **Semantics of a failed/over-cap fetch when the action itself mutated state.** Returning `ProtocolError` for `DOWNLOAD_TOO_LARGE`/`DOWNLOAD_FAILED` discards the operation's other outputs (`openedPages`, `changedSections`, dialogs). For `bc_respond_dialog` OK on a posting flow this is actively harmful — the caller loses page-context handles that were created. A partial-success shape (downloads entry with `error` field) would be more correct. The spec's error table acknowledges "the message must say so" but throws away the structured result anyway.
3. **Multiple downloads with one over cap** — does one `DOWNLOAD_TOO_LARGE` poison all downloads and the whole response? Unspecified.
4. **Memory at the cap**: the current fetch does `response.arrayBuffer()` unconditionally. A 500 MB export is fully buffered before the cap check unless the implementation aborts on `content-length` or streams. Spec test 6 mentions content-length OR body, but the design doesn't require abort-on-exceed.
5. **10 MB default cap is ~13.3 MB of base64** in a tool response — that already destroys most LLM contexts. The "out of scope: writing to disk" decision is questionable given `BC_REPORT_DIR` disk-save **already exists** in `run-report.ts:100-118` (`savedPath`); the new `Download` DTO silently drops `savedPath`, a feature regression the spec never mentions.
6. **`fileName: string` required in the DTO** but the current downloader returns `fileName?: string` and `fname` may be absent (see §2) — the fallback rule is unspecified.
7. **Trailing-async timing**: CLAUDE.md notes the 150 ms quiescence window can miss late messages. For reports the UriToShow is proven inline; for arbitrary actions ("Export" on config packages can take minutes server-side) the URI may arrive in a later response batch. No test covers a delayed UriToShow.
8. **"Open in Excel" vs "Edit in Excel"**: test 8 assumes both variants emit a plain xlsx download. "Edit in Excel" goes through the Excel add-in path (not UriToShow). If page 22's ribbon exposes "Edit in Excel" prominently, the test as written may target the wrong action. Not verified by the spec against decompiled source — the spec's own "nothing new needs to be discovered" claim is overconfident for the non-report flows: **none of the four evidence rows covers execute-action/dialog/wizard flows live.**

## 5. Test plan adequacy

Decent for the happy path, but holes:

- No test for a **`style: '0'` view URI / external URL** UriToShow (the SSRF case).
- No test for **missing `fname`** (spec test 3 covers absent fname for the collector, good — but no integration case).
- No test for the **partial-success problem** (download fails after a state-mutating action).
- No test for **multiple downloads in one response** at integration level (unit test 4 only).
- No test for **respond-dialog and wizard paths** beyond test 9 (dialog); wizard path (`bc_wizard_navigate` finishing on a download) has zero coverage despite being one of the three motivating cases.
- DoD grep criterion "`fetch(` appears once outside tests" is almost certainly already false — auth providers and OData `bc_query` presumably use `fetch`. Weak/wrong gate.

## 6. Scope

- **Cut**: `postMultipart` declaration (stub violation). Consider cutting the hard-error-on-oversize in favor of metadata-without-bytes (`downloads[i].bytes` omitted + `truncated: true` reason) — keeps structured output intact.
- **Wrongly deferred**: URI filtering/`view`-style handling is deferred as "treated as a normal download" — that is exactly the external-hyperlink case and cannot be deferred safely.
- **Missing**: reconcile `savedPath`/`BC_REPORT_DIR` with the new DTO; specify fetchAll timeout.

## Top 3 concerns

1. **UriToShow is not download-only.** Fetching every URI with session auth headers is an SSRF/credential-leak vector and will also mis-handle AL `HYPERLINK`. The collector must filter to relative `DynamicFileHandler.axd` URLs. (High confidence.)
2. **Error model destroys partial results.** `DOWNLOAD_FAILED`/`DOWNLOAD_TOO_LARGE` as whole-operation errors discards openedPages/dialog state of an action that already committed server-side — worse for the LLM than the status quo in some flows. (High confidence.)
3. **Evidence overclaims.** Style mapping is not actually in the cited decompiled files, `fname` is not produced by `FileUrlAddressProvider`, and the non-report flows (Open in Excel, dialog OK, wizard finish) have no live verification — "nothing new needs to be discovered" is not earned; expect surprises in integration tests 8-9. (High confidence on the citation gaps; medium on whether surprises materialize.)

```json evidence
{
  "files_checked": [
    "U:/Git/bc-mcp/docs/superpowers/specs/2026-07-24-download-capture-design.md",
    "U:/Git/bc-mcp/docs/superpowers/specs/2026-07-24-mcp-gap-analysis.md",
    "U:/Git/bc-mcp/CLAUDE.md",
    "U:/Git/bc-mcp/src/protocol/event-decoder.ts",
    "U:/Git/bc-mcp/src/session/report-downloader.ts",
    "U:/Git/bc-mcp/src/session/bc-session.ts",
    "U:/Git/bc-mcp/src/connection/connection-factory.ts",
    "U:/Git/bc-mcp/src/operations/execute-action.ts",
    "U:/Git/bc-mcp/src/operations/run-report.ts",
    "U:/Git/bc-mcp/src/services/action-service.ts",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI.Web/Microsoft.Dynamics.Framework.UI.Web/ResponseManager.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI.Web/Microsoft.Dynamics.Framework.UI.Web/FileUrlAddressProvider.cs"
  ],
  "searches_performed": [],
  "confidence": "high"
}
```

Note: I did not read `bc-websocket.ts`, `respond-dialog.ts`, `wizard-navigate.ts`, or `config.ts`; claims about those files are flagged as unverified above. `bc-session.ts` was read only in the `runReportWithDownload` region (lines ~560-660), which is the region the spec cites.