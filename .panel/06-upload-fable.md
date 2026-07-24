# Adversarial Review: File Upload Spec

## 1. Codebase claims — verified

- **`interaction-encoder.ts:165-193`, "ten interaction types, none upload"** — Correct. The `buildInvocation` switch has exactly ten cases (OpenForm, LoadForm, CloseForm, InvokeAction, SaveValue, Filter, SetCurrentRow, ScrollRepeater, SessionAction, SortColumn), none byte-moving. Confidence: high.
- **`connection-factory.ts:61` — `/csh` socket** — Correct; `buildWebSocketUrl` appends `/csh` (I read the region; exact line ±few lines but content accurate). Confidence: high.
- **`bc-session.ts:131` — `ServerSessionId` capture** — Correct; `extractSessionCredentials` assigns `this.sessionId = obj.ServerSessionId` right around there. Confidence: high.
- **`wire-types.ts:38-46` — four control-type aliases** — Correct: `lf`, `rc`, `sc`, `ac` only. Confidence: high.
- Not examined: `form-tree-builder.ts`, `bc-websocket.ts` in depth; and I did **not** open `BrowserLogicalControlSerializerMappingRules.cs` or `BrowserPageSessionInitializationSerializer.cs`, so the `BrowserFileUploadActionControl` mapping and `MaxFileUploadSize` claims are unverified by me.

## 2. Protocol claims — verified against decompiled C#

- **Two-step flow** — Correct. `UploadDownloadController.UploadTempFile` (POST `uploadTemp`, binds `IFormFile file` → form field name `file`) returns `"TEMP\" + <guid>`; `FileUploadActionInteraction.Name == "InvokeFileUploadAction"`; strategy reads `files` as `IList<UploadedTempFile>` off a `FileUploadActionControl`. `UploadedTempFile` has exactly `FileName`/`FileToken`. All confirmed. Confidence: almost_certain.
- **Header contract** — Correct. `SessionIdAttribute.OnAuthorization` requires `server-tenant-id` + `server-session-id`, matched against `NavSession.ExternalId`, 401 otherwise. Confidence: certain (read the file).
- **Path B** — Mostly correct, one **inaccuracy**: the spec says the server "returns an UploadResponse". It does not — `Upload()` returns `Task` (no HTTP body); the `UploadResponse` is pushed onto `ServiceCallStack.SetClientReturnValue`, i.e. it flows back to the pending AL call over the *websocket* channel, not the HTTP response. The MCP client should therefore expect the completion to surface on the socket, not in the POST response. Also note: when `UploadAction != null` (the normal path B case) there is **no malware scan** — the scan in `Upload` only runs in the no-pending-action branch. The spec's AV row implicitly assumes scanning happens in both paths.
- **deleteTemp** — Correct route and shape (`HTTP DELETE`, JSON body of names, TEMP-prefix stripped case-insensitively). Note DELETE-with-body is nonstandard; Node's `fetch` handles it, but worth a test. Route constants in `HttpConstants` match the spec. Line-number citations (92-128, 150-200, etc.): plausible but I could not verify exact numbers with my reader; content is accurate.

## 3. Are the two gates the right ones?

Gate 1 (endpoint host + whether `server-session-id == ServerSessionId`) and Gate 2 (wire type of the control) are both legitimate and necessary. But the spec's claim that "the interaction half is settled either way" **overclaims**. Things treated as settled that are not:

- **FileToken format.** Nothing in the decompiled code I read shows whether `FileToken` sent in `InvokeFileUploadAction` must include the `TEMP\` prefix or be the bare GUID. `deleteTemp` tolerantly strips the prefix, which hints the prefixed string is the canonical client value, but the *consumer* of `FileToken` (the NCL side of `FileUploadActionControl.Invoke`) is not examined by the spec — or by me. Gate 1's capture instructions say to record only the uploadTemp URL/headers/response; they should explicitly mandate capturing the **InvokeFileUploadAction wire payload** (files JSON casing, token form, whether it's inside the `namedParameters` JSON string).
- **Path B detection rule.** The spec says detection is "pinned during gate 1's capture" — but gate 1's capture is the Path A attachment flow. `File.UploadIntoStream` will never appear in it. Path B has **no gate and no capture plan** yet ships in the same tool.
- **Where the route mounts.** `[Route("uploadDownload")]` on the controller has no `client` prefix in the attribute; the `/BC/client/...` composition is inferred from constants. Gate 1 covers this — fine.

## 4. Missed failure modes

- **Modality.** `FileUploadActionInteraction.InvokeCore` calls `VerifyFormModality()` first — if a dialog is stacked above the target form the interaction throws (`LogicalModalityViolation` class of error). The spec never states the form-state precondition or maps this error. Confidence: high (read the code).
- **Server-side size rejection.** Client caps are pre-flight only; nothing maps a Kestrel/IIS 413 or a mid-body connection reset for oversized multipart. Error table has no row for it.
- **Two different extension filters.** The control's `AllowedFileExtensions` (page metadata) ≠ server config `FileTypeFilter.IsFileTypeAllowedByConfiguration`. Client-side validation against the former cannot catch the latter, and the controller conveniently exposes `POST /validate` for exactly this — the spec ignores it. This also undermines integration test 15 (see §5).
- **`uploadTemp` with null/empty file returns `string.Empty`**, not an error — a token of `""` silently poisons step 4.
- **AV asymmetry** (Path B pending-action uploads are unscanned) — behavioral note worth documenting.
- Token-prefix ambiguity as above.

## 5. Test plan holes

- **No Path B test at all.** The one-step dialog route ships untested; combined with no gate, it is the weakest part of the spec.
- **Test 15 is likely wrong as written.** A `.exe` rejection is expected "client-side with no HTTP call" — but the Attachments control's `AllowedFileExtensions` may be empty/permissive while the *server config* filter rejects it; then the rejection is a server `FileTypeNotAllowedUpload` after bytes are sent. The test conflates the two filters.
- No integration test for `deleteTemp` (only unit with mocked HTTP), none for multi-file upload against a real `AllowMultipleFiles` control, none for upload-while-dialog-open (modality), none for the empty-token edge.
- Otherwise the unit list is decent and correctly TDD-ordered; test 16 (upload/download round trip) is genuinely strong.

## 6. Scope

- **Cut or gate Path B.** It has no capture, no detection rule, no test, and a wrong claim about its response channel. Either add a gate + integration test (an AL page calling `UploadIntoStream`, or Configuration Package import which uses it) or defer it to its own spec.
- **Add `POST /validate`** to scope — cheap, exists, closes the extension-filter gap before bytes move.
- The no-sandbox `filePath` decision is defensible for a local tool but is a real exfiltration surface if the MCP server is ever exposed remotely; the spec at least acknowledges it. Acceptable.
- `deleteJson` on `BCHttpClient` appears in this spec's files-touched but not in the download-capture spec's interface — minor cross-spec drift.

## Top 3 concerns

1. **Path B is under-specified and untested**: wrong claim about where `UploadResponse` returns (websocket callback, not HTTP body), no capture gate, no detection rule, no integration test — yet it's in scope for v1 of the tool.
2. **FileToken format is treated as settled but isn't** — TEMP-prefix vs bare GUID is unverified, and gate 1's capture checklist doesn't mandate recording the interaction payload that would settle it.
3. **Extension-filter conflation**: client-side `AllowedFileExtensions` validation cannot substitute for server config `FileTypeFilter`; test 15 encodes this false assumption, and the free `/validate` endpoint that fixes it is ignored.