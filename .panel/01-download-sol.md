# Review verdict

The core problem is real: decoded `FileDownloadReady` events are surfaced only by the report-specific path, while action, dialog, and wizard outputs omit them. However, the spec overstates the protocol evidence, treats a generic `UriToShow` as a trusted file URL, and does not actually design a memory-safe size cap. I would not approve implementation until those issues are corrected.

This was a static review. I did not run the test suite, inspect the referenced live wire capture, or search the remainder of the repository exhaustively.

## 1. Existing-codebase claims

### Accurate claims

- **Decoder already emits `FileDownloadReady`: confirmed, high confidence.**  
  `EventDecoder` handles `SESSION_EVENTS.UriToShow`, reads `params[1]` and `params[2]`, and emits `FileDownloadReady` at `U:/Git/bc-mcp/src/protocol/event-decoder.ts:173-192`. The spec's `:173-188` citation is essentially accurate.

- **`runReportWithDownload` finds and fetches the event: confirmed, high confidence.**  
  It takes the first matching event at `U:/Git/bc-mcp/src/session/bc-session.ts:644-648` and invokes `ReportDownloader` at `:652-659`.

- **`ExecuteActionOutput` has no download field: confirmed, certain.**  
  Its complete output DTO is at `U:/Git/bc-mcp/src/operations/execute-action.ts:29-37`.

- **Dialog and wizard outputs currently omit downloads: confirmed, high confidence.**  
  See:
  - `U:/Git/bc-mcp/src/operations/respond-dialog.ts:14-20`
  - `U:/Git/bc-mcp/src/operations/wizard-navigate.ts:18-34`

  Both retain events temporarily, but their public output builders discard `FileDownloadReady`.

- **`ReportDownloader` contains reusable side-channel HTTP logic: confirmed, high confidence.**  
  URL joining, cookie headers, GET, timeout, content type, disposition parsing, and buffering are all in `U:/Git/bc-mcp/src/session/report-downloader.ts:23-55`. Renaming/extracting it is reasonable.

### Inaccurate or overstated claims

- **“Every client-bound file” uses a relative `DynamicFileHandler.axd` URL: contradicted by the provided C#, high confidence.**  
  `ResponseManager` serializes:

  ```csharp
  FormattedUri ?? Address
  ```

  at `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI.Web/Microsoft.Dynamics.Framework.UI.Web/ResponseManager.cs:516-522`.

  That is a generic URI/address mechanism, not proof that every event is a relative dynamic-file URL. `FileUrlAddressProvider` does construct one particular relative `DynamicFileHandler.axd` form at `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI.Web/Microsoft.Dynamics.Framework.UI.Web/FileUrlAddressProvider.cs:11-23`, but it does not establish universality.

- **“Only one caller consumes it”: supported by the supplied implementation files, but not exhaustively proven, medium confidence.**  
  `BCSession.runReportWithDownload` is the only consumer visible in the reviewed source. I did not perform a repository-wide textual search, so the claim should be phrased as “the inspected implementation has one consumer,” not as an exhaustive fact.

- **The concrete examples—attachments, config packages, Print, wizard exports—are unverified assumptions, medium confidence.**  
  The implementation shows that those output paths would discard such an event if one arrived. Neither the listed TypeScript nor the two provided C# files proves that each named BC action actually emits `UriToShow` over `/csh`. These should remain integration-test targets, not established evidence.

- **“Existing NTLM/cookie headers suffice” is imprecise and badly cited, high confidence.**
  - The cited `report-downloader.ts:14-22` is only a comment, not the actual HTTP request.
  - The request uses whatever `getAuthHeaders()` supplies at `report-downloader.ts:31-36`.
  - The current provider supplies only a `Cookie` header at `U:/Git/bc-mcp/src/connection/auth/ntlm-provider.ts:129-131`.
  - `CLAUDE.md` describes the test environment as NavUserPassword, while the implementation class is named `NTLMAuthProvider` but performs form login and cookie acquisition.

  Cookie reuse is live-claimed and is represented in the code, but “NTLM/cookie headers” conflates authentication mechanisms.

- **The files-touched list is incomplete: certain.**  
  At minimum, the planned refactor also requires:
  - `U:/Git/bc-mcp/src/session/session-factory.ts:20-38`, which currently constructs and injects `ReportDownloader`.
  - `U:/Git/bc-mcp/src/server.ts:78-111`, where services and operations are composed.
  - `U:/Git/bc-mcp/src/stdio-server.ts:73-108`, which duplicates that composition.
  - Likely error/tool-boundary code if structured download error details must reach callers.

- **“DialogService-equivalent” is hand-waving rather than an actual existing boundary: high confidence.**  
  There is no `src/services/dialog-service.ts`. `RespondDialogOperation` invokes `BCSession` directly at `U:/Git/bc-mcp/src/operations/respond-dialog.ts:72-84`. The spec must name the actual injection point.

- **The spec silently removes existing disk output: certain.**  
  `RunReportOperation` supports `BC_REPORT_DIR` and returns `savedPath` at `U:/Git/bc-mcp/src/operations/run-report.ts:25-34` and `:99-130`. Declaring disk output “out of scope” is not neutral—it removes an implemented feature. Breaking changes may be allowed, but this removal must be explicit.

## 2. BC protocol claims

### Confirmed

- **`UriToShow` is registered as `DN.LogicalClientEventRaisingHandler`: high confidence.**  
  `GenerateResponse` calls `RegisterUriToShowEvents` at `ResponseManager.cs:205-219`; the registration loop creates that handler and appends the event name and parameters at `:248-267`.

- **The wire parameters are URI followed by a decimal style ordinal: certain.**  
  `AddUriToShowEventResponseParameters` adds the URI and then `Style.ToString("D")` at `ResponseManager.cs:516-522`.

- **Provider-created dynamic-file URLs include form, handler session, type, and random file ID: certain.**  
  `FileUrlAddressProvider.cs:11-23` shows:
  - `form`
  - `sessionid = HandlerSessionId`
  - `type`
  - `fid`
  - relative `DynamicFileHandler.axd`

- **Multiple URI changes can produce multiple response handlers in logical-change order: high confidence.**  
  `RegisterUriToShowEvents` iterates all logical changes and adds one response per matching change at `ResponseManager.cs:248-267`.

### Not confirmed or contradicted

- **Style mapping `0=view, 1=download, 2=print`: not established by the provided decompiled files, high confidence.**  
  `ResponseManager` proves only that the enum's numeric ordinal is serialized. It does not declare the enum or map its values. `event-decoder.ts:176-177` merely repeats the assertion. The mapping may be correct from live capture or another decompiled enum, but the cited evidence does not prove it.

- **Specific `/csh` transport behavior is only partially established, medium confidence.**  
  The response manager proves handler construction in a callback response, but these two C# files do not show the `/csh` routing/call chain or rule out every other delivery path. The live wire capture may do so, but I did not inspect it.

- **`fname` is not supplied by `FileUrlAddressProvider`: certain.**  
  The provider shown at `FileUrlAddressProvider.cs:11-23` does not add `fname`. A formatted URI or another layer may add it, and existing tests assume that shape, but `fname` cannot be treated as protocol-guaranteed from this source.

- **The URL is not “keyed on HandlerSessionId” alone: certain.**  
  It is keyed/qualified by at least form, session ID, file type, and random file ID. The spec's wording is materially incomplete.

- **No separate token is required: not proven by the supplied C#, medium confidence.**  
  The URL embeds the handler session ID, and existing live behavior reportedly works with cookies. Neither C# file establishes the HTTP handler's authentication policy.

## 3. Design and decomposition

### What is sound

- Extracting a generic HTTP transport from `ReportDownloader` is appropriate.
- Keeping filename parsing pure and tested is appropriate.
- A service that converts references to bounded, output-ready downloads is useful.
- Returning multiple downloads in event order is better than the current `find()`-only report implementation.

### What should change

1. **`DownloadService` should accept events, not only already-collected refs.**  
   A better public boundary is:

   ```ts
   capture(events: readonly BCEvent[]): Promise<Download[]>
   ```

   It can call an internal/exported pure `collectDownloadRefs()` helper. With the proposed `fetchAll(refs)` API, every operation must remember both collection and fetching, recreating exactly the omission this feature is intended to eliminate.

2. **Do not inject download fetching indiscriminately into `ActionService` without specifying ordering.**  
   `ExecuteActionOperation` and `WizardNavigateOperation` classify business errors after `ActionService` returns. If `ActionService` eagerly fetches URIs, an event batch containing a BC error plus a URI could trigger network access before the business error is classified. The design should state whether:
   - business-error classification happens first, then downloads are captured; or
   - downloads are captured regardless, with a documented reason.

3. **The report protocol orchestration remains overly embedded in `BCSession`.**  
   `BCSession.runReportWithDownload` currently mixes protocol sequencing, report-format selection, HTTP I/O, and DTO preparation. A more coherent architecture would be:
   - `BCSession`: invoke and return events.
   - `ReportService`: drive request/format dialogs.
   - `DownloadService`: validate and fetch download events.
   - Operations: shape MCP DTOs.

   For an S-sized change, retaining report orchestration in `BCSession` may be pragmatic, but then `BCSession` depending on a services-layer `DownloadService` conflicts with the documented `session -> services` layering.

4. **Do not declare `postMultipart` now.**  
   It is unused, unimplemented, and conflicts with the project's “no stubs or skeleton implementations” convention. Adding a method to the same `BCHttpClient` in spec 6 does not duplicate the client or auth story. Cut it from this spec.

5. **The HTTP API must not accept arbitrary absolute URLs with BC cookies.**  
   If absolute URLs are supported, enforce same origin and expected scheme/path before attaching cookies. Better: accept only a parsed, validated BC-side-channel URL. The current `ReportDownloader` already accepts arbitrary strings beginning with `"http"` at `report-downloader.ts:24-26`; that flaw should not be promoted into a generic client.

6. **`Download.fileName` cannot be required without a fallback policy.**  
   `suggestedFileName`, `Content-Disposition`, and `fname` are all optional. Define precedence and a deterministic fallback such as `download-{index}` plus an extension inferred cautiously from content type.

## 4. Missed failure modes and protocol realities

### Security

- **SSRF and cookie leakage: critical, almost certain.**  
  Because `ResponseManager` can serialize a generic address, treating every `UriToShow`, including style `view`, as a file to GET can make the MCP server request attacker-controlled or external URLs. Sending BC cookies to an arbitrary absolute URL would be a credential leak.

- **Redirect handling is unspecified.**  
  A stale dynamic URL may redirect to SignIn, or a malicious endpoint may redirect cross-origin. Default `fetch` redirect behavior is not an adequate policy. Use manual redirects or validate every redirect target.

- **Full URLs leak handler/session identifiers into logs and errors.**  
  The existing report path logs the complete URL at `bc-session.ts:651`. The new spec explicitly asks error messages to include the URL. At least `sessionid`, `fid`, and other query values should be redacted.

### Size and memory

- **The proposed size cap is not memory-safe.**  
  Checking `Content-Length` and then calling `arrayBuffer()` still buffers the entire response when the header is absent, false, or smaller than the body. Enforce the limit while streaming and abort immediately after `maxBytes + 1`.

- **There is no aggregate batch cap.**  
  Ten 10 MB downloads satisfy a per-file limit but produce roughly 133 MB of base64 before JSON overhead. Add:
  - per-file cap,
  - total-operation cap,
  - maximum download count.

- **10 MB inline is already far too large for an LLM tool result.**  
  A 10 MB binary becomes about 13.3 MB of base64, then is pretty-printed by `MCPHandler` at `U:/Git/bc-mcp/src/mcp/handler.ts:153-165`. This can overwhelm client transport and model context even though it is under the proposed cap.

- **`Content-Length` semantics are underspecified.**  
  Consider missing, invalid, compressed-transfer, mismatched, and oversized lengths, as well as exact-boundary behavior.

### Error and output semantics

- **Structured error context currently does not reach MCP callers.**  
  `ProtocolError` can carry context at `U:/Git/bc-mcp/src/core/errors.ts:1-24`, but `MCPHandler` renders only code and message at `mcp/handler.ts:167-177`. REST errors similarly drop context at `U:/Git/bc-mcp/src/api/routes.ts:84-92`. Therefore `sizeBytes`, filename, status, and “action already committed” must be embedded in the message or the handlers must be changed.

- **Partial failure is unspecified.**  
  If two files are emitted and the second fetch fails, should the first successful file be discarded? Retried? Returned alongside an error? Dynamic downloads may be one-shot, making an all-or-nothing retry impossible.

- **Network errors are not just HTTP errors.**  
  DNS failures, TLS errors, abort/timeouts, redirects, body stream failures, connection resets, and session expiry need stable error mapping.

- **A 200 response may be a login page or HTML error.**  
  Status alone is insufficient. At least detect obvious SignIn HTML and empty/204 bodies.

### Event attribution and timing

- `FileDownloadReady.formId` is always empty, so it cannot be attributed to a form.
- `BCSession` merges trailing asynchronous events after a fixed 150 ms window at `bc-session.ts:303-309`. A delayed event could be missed or associated with the next operation.
- The session queue reduces ambiguity but does not establish causal correlation.
- Nested invokes used by page/action hydration do not propagate all events into the original action result. For example, `ChildFormHydrationStrategy` performs additional `session.invoke` calls and applies their events internally at `U:/Git/bc-mcp/src/services/strategies/child-form-hydration.ts:103-156`. Thus “generic capture across every invocation” is not achieved merely by enriching four top-level DTOs.

### Filename and response handling

- Filename precedence between `suggestedFileName` and `Content-Disposition` is unspecified.
- Header filenames need path-separator/control-character sanitization.
- `filename*` charset/language variants and quoted semicolons are not covered.
- Unknown styles should not silently become `download`; that masks protocol changes and is especially unsafe for generic URIs.
- Sequential versus concurrent fetching is unspecified. Preserve order explicitly; use sequential fetching unless concurrency against `DynamicFileHandler` is live-verified.

## 5. Test-plan assessment

The test plan is insufficient to prove the feature safe or fully wired.

### Missing unit tests

Add tests for:

1. Same-origin and allowed-scheme/path validation.
2. External absolute URL rejection without sending auth headers.
3. Redirect rejection or same-origin redirect handling.
4. Leading-slash and trailing-slash URL joining.
5. Network failure, timeout, abort, and body-stream failure mapping.
6. Missing, malformed, negative, mismatched, exact-limit, and oversized `Content-Length`.
7. Streaming abort at `maxBytes + 1`, proving the full oversized body is not buffered.
8. Aggregate size and download-count limits.
9. Multiple download success, order, and partial failure semantics.
10. Required filename fallback and filename precedence.
11. Content-type fallback and 200 SignIn/HTML detection.
12. Unknown style behavior. Do not codify “unknown means download” without protocol justification.
13. Error code and details as they appear through the actual MCP handler, not merely as an internal `ProtocolError`.
14. Configuration default plus rejection of zero, negative, and malformed `BC_MAX_DOWNLOAD_BYTES`. Current `optionalEnvInt` accepts partial strings via `parseInt` at `U:/Git/bc-mcp/src/core/config.ts:47-52`.
15. All four operations returning `downloads: []` when no event occurs.
16. All four operations returning captured downloads when one or multiple events occur.
17. Business-error-plus-URI ordering.
18. Run-report no-format behavior after changing singular `download` to `downloads`.

### Integration holes

- The plan tests download-producing action and dialog paths but not the wizard path, despite naming wizard support as a deliverable.
- It does not prove multiple downloads.
- It does not prove timeout or oversized live behavior.
- It does not test attachment download or config-package export, despite using them as motivating examples.
- The report plan drops explicit Word coverage. The existing integration file tests PDF, Excel, and Word at `U:/Git/bc-mcp/tests/integration/report-capture.test.ts:36-130`, though Excel and Word currently treat unavailable layouts as a passing early return.
- The current integration test constructs `RunReportOperation(session)` while the constructor requires a repository at `run-report.ts:40-45`. Runtime happens to avoid the repository on the format path, but this is a sign that the migration should not merely be mechanical.
- “Refresh returns `downloads: []`” proves only one output DTO's empty case.
- Content-type assertions should tolerate legitimate parameters and known BC variants while still checking magic bytes and nonempty bodies.

## 6. Scope judgment

### Cut

- `postMultipart` declaration and all upload-oriented API design.
- Automatic fetching for arbitrary or cross-origin `style: view` URIs until a security policy is defined.
- The unsupported “unknown style defaults to download” behavior.

### Bring into scope

- Same-origin/redirect validation.
- Streaming size enforcement.
- Aggregate response limits.
- Explicit partial-failure semantics.
- Filename fallback/sanitization.
- Wiring changes in `session-factory.ts`, `server.ts`, and `stdio-server.ts`.
- A clear decision on preserving or removing `BC_REPORT_DIR`.
- At least one wizard-download integration test if wizard support remains a definition-of-done item.

### Reconsider the deferred-download decision

Inlining may be acceptable for genuinely small files, but 10 MB is not a credible context-safe cap. Either:

- use a much smaller inline cap and provide a fetch token/resource for larger files now, or
- explicitly declare large downloads unsupported and set a conservative cap based on measured MCP/client limits.

“Download succeeded but tool returns only an error and no retrieval mechanism” is operationally weak, especially for one-shot URLs.

## Top 3 concerns

1. **Security:** `UriToShow` is generic, yet the design proposes authenticated GETs—including absolute URLs and `style: view`—without same-origin or redirect validation.
2. **Resource safety:** the cap does not prevent full-body buffering, has no aggregate limit, and still permits context-destroying base64 output.
3. **Incomplete architecture/testing:** actual composition files and dialog boundaries are missing, error details are dropped at MCP/API boundaries, and wizard/multiple/partial-failure paths are unproved.