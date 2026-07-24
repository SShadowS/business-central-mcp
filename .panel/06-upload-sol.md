## Overall verdict

The Path A protocol core is mostly correct, but the spec overstates how settled the feature is. Path B is not designed far enough to implement safely, Gate 2 is already answered by decompiled source, and the HTTP/session-auth transport has additional unresolved requirements. I would not approve implementation until the gates are rewritten and Path B is either independently proven or cut.

I did not perform a live Cronus28 capture, so all statements requiring live behavior remain unverified here.

## 1. Existing-code claims

### Accurate claims

- **There is no upload interaction today — high confidence.**  
  `src/protocol/interaction-encoder.ts:163-193` handles exactly ten interaction variants: OpenForm, LoadForm, CloseForm, InvokeAction, SaveValue, Filter, SetCurrentRow, ScrollRepeater, SessionAction, and SortColumn. `src/protocol/types.ts:181-193` contains the matching ten-member `BCInteraction` union.

- **The current socket is `/csh` — certain.**  
  `src/connection/connection-factory.ts:51-61` builds `${base}/csh?...`.

- **BCSession captures a field named `ServerSessionId` — high confidence.**  
  `src/session/bc-session.ts:125-141` recursively assigns it to `this.sessionId`.

  However, the spec misses an implementation issue: `sessionId` is private and has no getter. `UploadService` cannot currently obtain it. The “Files touched” list should therefore include `src/session/bc-session.ts`, or session headers should be assembled by a session-bound transport object.

- **`wire-types.ts` lists only four control aliases — certain.**  
  `src/protocol/wire-types.ts:38-46` has LogicalForm, RepeaterControl, StringControl, and ActionControl.

- **The current tree builder does not recognize upload controls — certain.**  
  `src/protocol/form-tree-builder.ts:78-91` has no `fla` branch and falls back to `UnknownNode`.

- **The existing HTTP side channel is download-only — high confidence.**  
  `src/session/report-downloader.ts:14-46` performs only GET requests.

I did not exhaustively search every file under `src/`, so the source-wide negative claim that “nothing in `src/` touches BC's upload endpoints” is strongly supported by the inspected transport/session files but not proven by a repository-wide search.

### Misleading dependent-spec claim

The download spec and `ReportDownloader` repeatedly call the auth “NTLM headers,” but the configured environment is NavUserPassword (`CLAUDE.md:18-27`). `src/connection/auth/ntlm-provider.ts` actually performs the BC SignIn form flow, and `getWebSocketHeaders()` returns only a `Cookie` header. There is no NTLM `Authorization` header.

That naming error matters because upload POST/DELETE requests may also require an antiforgery token. The provider stores a CSRF token but exposes it only through WebSocket query parameters, not HTTP headers (`src/connection/auth/ntlm-provider.ts:123-137`). The upload design does not address that.

### Incomplete implementation file list

The proposed “Files touched” list is materially incomplete:

- `src/session/bc-session.ts`: expose or otherwise supply session ID and upload-size metadata.
- `src/session/session-factory.ts`: currently constructs and injects `ReportDownloader` (`:22-41`).
- `src/server.ts` and `src/stdio-server.ts`: both manually construct every service and operation (`server.ts:65-111`; `stdio-server.ts:65-108`).
- `src/mcp/tool-registry.ts`: not just registration—the `Operations` interface also needs the operation.
- Possibly `src/connection/auth/auth-provider.ts` and `src/connection/auth/ntlm-provider.ts` if antiforgery material is needed.
- REST API composition must be consciously addressed if the new operation is intended to be MCP-only.

## 2. Protocol claims

### Path A: uploadTemp followed by InvokeFileUploadAction

**Verdict: substantially correct — high confidence.**

- `UploadDownloadController.UploadTempFile` accepts one `IFormFile`, applies the global file-type filter, writes a temp file, scans it, and returns `"TEMP\\" + token`:  
  `UploadDownloadController.cs:86-127`.

- Interaction name is exactly `InvokeFileUploadAction`:  
  `FileUploadActionInteraction.cs:7-10`.

- Execution resolves a `FileUploadActionControl` and deserializes named parameter `files` as `IList<UploadedTempFile>`:  
  `FileUploadInteractionExecutionStrategy.cs:20-28`.

- `UploadedTempFile` exposes exactly `FileName` and `FileToken`:  
  `UploadedTempFile.cs:13-38`.

- The interaction forwards all files together in one array under `"files"`:  
  `FileUploadActionInteraction.cs:13-21`.

The proposed wire payload:

```json
{
  "files": [
    {
      "FileName": "...",
      "FileToken": "..."
    }
  ]
}
```

is therefore well grounded.

One important omitted fact is that `FileUploadActionInteraction.InvokeCore` calls `VerifyFormModality()` before resolving and invoking the control (`FileUploadActionInteraction.cs:13-14`). The interaction does require a valid form/modal state. A modal layered over the target page can invalidate an otherwise valid temp upload.

### Temp-token format and prefix

**Token format: certain. Whether the browser sends the full prefix as `FileToken`: only medium confidence without a capture or downstream consumer.**

`UploadTempFile` literally returns `"TEMP\\" + text`, where `text` is a `Guid.NewGuid().ToString("N")` generated by `WriteTempFile` (`UploadDownloadController.cs:125`, `:202-211`). Thus the raw token is `TEMP\` plus a 32-hex-character GUID without hyphens.

The spec treats it as settled that this entire returned value is passed as `FileToken`. That is likely, but the cited `UploadedTempFile` class only proves the property exists; it does not prove whether the browser strips `TEMP\` before constructing the interaction. Gate 1 currently records the response body but not the subsequent `InvokeFileUploadAction` request. It must capture both and compare them.

The response parsing also needs verification: an ASP.NET `Task<string>` action may appear on the wire as JSON string content, including quotes and an escaped backslash, rather than bare text. `postMultipart` needs an explicit parsing rule and tests.

### Header contract

**Controller contract: certain. Correct value sourcing: unverified.**

`SessionIdAttribute.cs:15-39` requires:

- `server-tenant-id`
- non-empty `server-session-id`

It resolves the tenant and then matches `server-session-id` to `NavSession.ExternalId`.

The spec is right about the filter contract, but it is too confident about sourcing:

- `BCSession` captures an OpenSession field called `ServerSessionId`.
- Separately, the browser initialization serializer writes a field with the same name from `ClientSession.HandlerSessionId` (`BrowserPageSessionInitializationSerializer.cs:90-96`).
- The same serializer exposes both `TenantId` and `RuntimeTenantId` (`:103-109`).

Those similarly named IDs are not enough to prove which values the ClientService endpoint expects for this `/csh` session. Gate 1 must record and compare both header values, not merely ask whether the session header equals the recursively captured field.

The ordinary authentication and antiforgery requirements are also separate from `SessionIdAttribute`; that attribute does not prove Cookie-only requests are sufficient.

### URL route

**Controller-relative route: certain. Full `/BC/client/...` URL: medium confidence.**

The controller declares `[Route("uploadDownload")]` and method routes `uploadTemp`, `upload`, `validate`, and `deleteTemp` (`UploadDownloadController.cs:20`, `:35`, `:87`, `:130`, `:150`). `HttpConstants.cs:19-39` declares `client`, `uploadDownload`, and the method route names.

But constants do not themselves prove that this controller is mounted under `/client`, and the controller attributes do not contain that prefix. Live endpoint reachability remains a legitimate gate.

### Separate `Session.UploadAction` path

**Endpoint-side behavior is proven; the proposed client flow is not — high confidence.**

`UploadDownloadController.Upload` is:

- `POST uploadDownload/upload`
- marked `SessionUsage.None`
- bound to the current session by the class-level `SessionId` filter  
  (`UploadDownloadController.cs:34-39`).

If `context.Session.UploadAction != null`, it calls that delegate with the uploaded stream (`:51-60`).

However, the spec overstates this as a settled “one-step” client flow. If no pending `UploadAction` exists, the controller does not reject the request; it takes a different branch, buffers the file into an `UploadResponse`, and performs a malware scan (`:61-66`). Therefore, posting merely because an “active form looks like a file-upload dialog” is unsafe and not proven.

Unanswered Path B questions include:

- What event or inbound callback tells the web client that `UploadAction` is pending?
- Is the original Invoke still in flight while the HTTP POST must occur?
- Does the upload have to be concurrent with an AL `UploadIntoStream` call?
- Is there actually a page-context form to detect?
- Does `/csh` issue an inbound request that the current `BCSession` catch-all would immediately acknowledge with `{}` (`src/session/bc-session.ts:42-58`)?
- What response signifies successful attachment or stream delivery?

Gate 1's proposed Sales Order attachment capture exercises Path A and cannot establish any of this.

### Cleanup route

**Route and body shape: high confidence. Cleanup guarantee: overstated.**

`DELETE uploadDownload/deleteTemp` accepts a JSON body `List<string>` (`UploadDownloadController.cs:148-157`). It strips a `TEMP\` marker and calls guarded deletion for every item (`:163-194`). Passing the full returned token list is the sensible design.

Missing caveats:

- A dead session may make cleanup impossible because the same session headers are required.
- Cleanup returns per-file `{FileName, Result}` values; a 2xx response can still contain `Result: false`.
- Cleanup failure must not replace the original interaction error.
- If the Invoke outcome is unknown after a timeout, cleanup is idempotent for not-found files, but the service must describe that uncertainty.
- On malware rejection during `uploadTemp`, no token reaches the client, so client-side cleanup cannot help.

The spec also says the malware catch “deletes the temp file.” The literal decompiled source scans `fileName` but tests/deletes `text`, the GUID-like name, in the catch (`UploadDownloadController.cs:109-124`). At minimum, the cited code does not cleanly prove deletion of the full temp path. This may be a decompilation artifact or server bug, but the spec should not state deletion as established fact.

### Antivirus timing

**Spec is incomplete — high confidence.**

- Path A scans after writing the temp file and before returning the token.
- Path B scans only in the branch where no pending `Session.UploadAction` exists. The pending-action branch has no explicit controller-level malware scan (`UploadDownloadController.cs:51-66`).

“Malware scanner rejection” therefore cannot be documented as one uniform failure mode without finding another downstream scanner for the pending-action branch.

## 3. Are the two gates right?

### Gate 1

**Right in principle, but insufficient.**

It should be split into:

1. **Path A transport capture**
   - Exact URL and route prefix.
   - Cookies, antiforgery header/query token, tenant header, and session header.
   - Multipart boundary, field name, filename encoding, content type, and request length.
   - Raw response content type and body.
   - Subsequent `InvokeFileUploadAction` JSON, including whether `FileToken` retains `TEMP\`.
   - Exact `AllowedFileExtensions` wire value and semantics.

2. **Path B lifecycle capture**
   - A real AL `File.UploadIntoStream` or equivalent flow.
   - Triggering interaction.
   - Every event/inbound RPC before the POST.
   - Whether POST occurs while Invoke is pending.
   - Exact success response and subsequent events.
   - Behavior when POST happens without a pending `UploadAction`.

3. **Session metadata capture**
   - Which tenant ID is used: configured tenant, `TenantId`, or `RuntimeTenantId`.
   - Which session ID is used: OpenSession `ServerSessionId`, HandlerSessionId, or another ID.
   - Whether antiforgery is mandatory.

### Gate 2

**Misclassified as unknown — certain.**

The decompiled client type already gives the wire alias:

```csharp
[TypeAlias("fla", BrowserType = "DN.FileUploadActionControl")]
```

at `ClientFileUploadActionControl.cs:3`.

The same file fixes the property names as `AllowedFileExtensions` and `AllowMultipleFiles` (`:6-8`). `FileUploadActionControlSerializer.cs:18-33` writes those exact names. The browser mapping at `BrowserLogicalControlSerializerMappingRules.cs:30` corroborates the browser control mapping.

A live fixture is still appropriate under the project's integration-first convention, but it is confirmation, not a transport-changing unknown. The real unresolved metadata issue is the **format and semantics of the `AllowedFileExtensions` string**, not its spelling.

Also, adding `fla` to `wire-types.ts` does not by itself help `buildFormTree`; the builder dispatches directly on raw `t` values (`form-tree-builder.ts:78-91`). It needs an explicit `t === 'fla'` branch.

## 4. Missed failure modes and design gaps

### Transport and authentication

- Missing or wrong antiforgery token.
- Cookie expiration, not merely incorrect session headers.
- 401 can mean wrong tenant, expired/dead session, missing Cookie, or bad session ID; it does not uniquely mean “the header contract broke.”
- 413/request-body-limit failures and multipart overhead relative to the advertised file cap.
- Invalid or unexpected `uploadTemp` response body.
- Network timeout after the server stored the temp file but before the client received its token—this creates an uncleanable orphan.
- HTTP success with cleanup result entries containing `Result: false`.
- Filename encoding, quotes, CR/LF, NUL, Unicode, and path separator handling.
- MIME type derivation is unspecified even though `postMultipart` requires `contentType`.

### File source handling

- `FileSource.fileName` is declared required, but the rules and tool schema make it optional.
- Node's common base64 decoding is lenient; malformed base64 needs strict rejection.
- Size must be checked on actual decoded/read bytes, not only stat metadata.
- Cap boundary behavior and zero-byte files are unspecified.
- Per-file versus aggregate cap is unspecified.
- Multiple base64 payloads can consume much more memory than the decoded cap before validation.
- Empty/whitespace filenames and duplicate filenames are unspecified.
- Local arbitrary-path access is a deliberate but significant security capability. It should be a documented product/security decision, not dismissed solely because the process runs as the same OS user.

### Control metadata and target resolution

- `AllowedFileExtensions` is serialized as one string, but the parsing grammar, wildcard behavior, empty-string semantics, case sensitivity, and multi-extension delimiter are not established.
- BC also exposes a `/validate` route for server-global extension preflight (`UploadDownloadController.cs:128-147`). The spec ignores it while claiming server rejection can only happen after bytes are sent.
- Global configured file filtering and per-control allowed extensions are distinct checks.
- Visibility, enabled state, and effective modal accessibility of upload controls are not considered.
- “id” in the proposed DTO is undefined: control path, `DefinitionId`, or `ControlIdentifier`?
- Duplicate captions across sections or within a form need deterministic ambiguity errors.
- `VerifyFormModality()` means a target can become invalid even while its form remains open.

### Session and concurrency

- Temp upload and interaction are not atomic. Another MCP request can mutate or close the page between them.
- `expectedStateVersion` must be checked before I/O and rechecked before Invoke; otherwise a long upload can target stale state.
- A session-level lock may be required across target resolution, HTTP upload, and Invoke, especially for Path B.
- Cleanup after session death may be impossible.
- Current session ID is private and the size limit is not captured at all.
- `MaxFileUploadSize` is only shown as serialized metadata (`BrowserPageSessionInitializationSerializer.cs:218`); its units and whether it limits file bytes or whole request bytes remain unverified.
- A local default of 50 MB can be an intentional stricter cap, but it should not be presented as equivalent to BC enforcement.

### Partial and uncertain outcomes

- Failure on file N after files 1…N-1 uploaded.
- Failure while reading a later local file after earlier files were already uploaded; all sources should be resolved and validated before network I/O.
- Invoke timeout where attachment may have succeeded.
- Business error after the action consumed one or more tokens.
- Cleanup HTTP failure masking the original failure.
- Reusing a token on retry.
- Multiple-file ordering and partial action acceptance.

## 5. Test-plan adequacy

The plan is not adequate for the declared scope.

### Most serious omission

There is **no Path B unit or integration test**, despite the tool claiming automatic Path A/Path B selection. That alone prevents the definition of done from proving the advertised feature.

### Missing transport tests

Add tests for:

- Exact multipart field name `file`.
- Filename and binary body preservation.
- Boundary and `Content-Type` handling.
- Cookie, tenant, session, and antiforgery headers.
- URL joining with `/client/uploadDownload/...`.
- Raw/JSON-string token response parsing.
- Preservation of the `TEMP\` prefix.
- 401, 413, 5xx, malformed response, and timeout mapping.
- DELETE JSON body and per-item cleanup failures.

### Missing source/validation tests

- Malformed base64 and whitespace-only input.
- Exact cap boundary and post-decode size.
- File growth/change between stat and read.
- Empty file.
- Filename validation and multipart-header injection.
- Case-insensitive extensions, no extension, wildcard/all-files, compound extensions, and actual captured delimiter syntax.
- Server `/validate` rejection versus control-specific rejection.
- Session cap lower than local cap.

### Missing service tests

- Failure on the second temp upload cleans the first token.
- Cleanup failure preserves the primary error.
- Unknown Invoke outcome is reported as uncertain.
- Stale state before and after temp upload.
- Missing, disabled, hidden, closed, or modality-blocked control.
- Duplicate captions and ID-based resolution.
- Multiple files accepted in one interaction, including a live integration test.
- Upload target discovery appears in `Section` output.

### Missing live tests

- Path B `UploadIntoStream`.
- Live `deleteTemp`.
- Server-side oversize rejection.
- Captured max-size units.
- Multipart filename with spaces/non-ASCII characters.
- Antivirus timing, if the environment safely supports an EICAR-style test.
- Interaction failure after successful temp upload.
- Concurrent state change while uploading.

The `.exe` integration test also claims “no HTTP call made,” which cannot be established without instrumenting the HTTP client or server logs. As written, that assertion is more appropriate as a unit test.

## 6. Scope

### Keep

- Path A upload control support.
- Temp cleanup.
- First-class upload-control discovery.
- Local path and base64 source support, subject to an explicit security policy.
- `postMultipart` in the shared HTTP client.

### Cut or split

**Cut Path B from this spec unless a separate Path B gate is closed first.** It is not a small variation of Path A; it has a pending-session action, potentially concurrent transport, different malware behavior, and no proven page-context detection rule. Shipping Path A first would still unlock attachments, incoming documents, and embedded upload controls.

If Path B remains, it needs its own protocol section, orchestration state machine, tests, and likely changes to `BCWebSocket`/`BCSession`.

### Reconsider

- The `wire-types.ts` edit may be unnecessary for tree construction; the critical edit is the explicit `fla` branch in `form-tree-builder.ts`.
- Consider using `/validate` for the global configured extension check before sending bytes.
- Do not treat dynamic session cap capture as “when available.” Either make it a required gate and implement it, or clearly define the local cap as the only guaranteed client-side cap.
- Clarify whether upload is MCP-only or also exposed through the REST API.

## Top 3 concerns

1. **Path B is not actually specified:** no proven trigger/detection rule, concurrency model, response contract, or test.
2. **Session-auth transport is incomplete:** session/tenant ID sourcing, antiforgery, private session metadata, and composition-root wiring are unresolved.
3. **Token/multipart/cleanup semantics are under-tested:** especially `TEMP\` preservation, response parsing, partial uploads, uncertain Invoke outcomes, and max-size enforcement.