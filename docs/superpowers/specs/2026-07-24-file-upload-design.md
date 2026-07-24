# File Upload (Path A — page upload controls) — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/06-upload-*.md`).
Path B (AL `File.UploadIntoStream` dialogs) is **cut from this spec** — see below.
**Size:** L
**Build order:** 6 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/file-upload`
**Depends on:** [download-capture](2026-07-24-download-capture-design.md) for `BCHttpClient`

## Problem

There is no upload path. `src/protocol/interaction-encoder.ts:163-193` encodes exactly ten
interaction types (`src/protocol/types.ts:181-193` has the matching union) and none moves bytes.

Blocked: attachments on documents and cards, Incoming Documents, Configuration Package import,
bank statement import, item pictures.

## Scope decision: Path A only

BC has two upload mechanisms:

- **Path A** — a `FileUploadActionControl` embedded in a page (Attachments, Incoming Documents,
  pictures). Two steps: POST a temp file, then invoke an interaction with the returned token.
- **Path B** — AL `File.UploadIntoStream`, served by `POST uploadDownload/upload` against a pending
  `Session.UploadAction`.

Both reviewers independently said Path B is not designed far enough to ship, and they were right.
Unknowns: what event signals that `UploadAction` is pending; whether the originating Invoke is
still in flight while the POST must happen; what the detection rule on our side would even be; and
the first draft got its response channel wrong — `Upload()` returns `Task` with no HTTP body, the
`UploadResponse` goes back via `ServiceCallStack.SetClientReturnValue`
(`UploadDownloadController.cs:45-75`), i.e. over the socket to the waiting AL call.

Worse, posting to that route without a pending `UploadAction` does **not** error: the controller
takes the other branch, buffers the file, and scans it (`:61-74`). A wrong guess silently uploads
into nothing.

Path A alone unlocks attachments, incoming documents, and pictures. Path B gets its own spec with
its own capture.

## Evidence

| Claim | Source | Status |
|---|---|---|
| Step 1: `POST {clientBase}/uploadDownload/uploadTemp`, multipart field `file`, returns `"TEMP\<guid>"` | `UploadDownloadController.cs:92-128`; `WriteTempFile` `:207-216`; routes in `HttpConstants.cs:19-40` (`BaseRoute = "client"`) | Verified |
| Server checks the extension **and** malware-scans before returning a token | `:102-105` (`FileTypeFilter.IsFileTypeAllowedByConfiguration`), `:110` (`MalwareScanner.ScanFileForMalware`) | Verified |
| Step 2: interaction `InvokeFileUploadAction` | `FileUploadActionInteraction.cs:7-10` | Verified |
| Parameter `files` deserialised as `IList<UploadedTempFile>`; all files in one interaction | `FileUploadInteractionExecutionStrategy.cs:20-28`; `FileUploadActionInteraction.cs:13-21` | Verified |
| `UploadedTempFile` has exactly `FileName` + `FileToken` | `UploadedTempFile.cs:13-38` | Verified |
| **The interaction calls `VerifyFormModality()` first** | `FileUploadActionInteraction.cs:13-14` | Verified — a stacked modal invalidates an otherwise valid upload |
| Auth: `server-tenant-id` + `server-session-id` headers, matched against `NavSession.ExternalId` | `SessionIdAttribute.cs:15-39` | Verified |
| Control metadata: `AllowedFileExtensions`, `AllowMultipleFiles`, `ScopeType`, `DefinitionId` | `FileUploadActionControlSerializer.cs:18-33` | Verified |
| **Wire type alias is `fla`** | `ClientFileUploadActionControl.cs:3` — `[TypeAlias("fla", BrowserType = "DN.FileUploadActionControl")]`; property names confirmed at `:6-8` | Verified — this was Gate 2 in the first draft; it is answered |
| Server-side extension preflight endpoint exists | `POST uploadDownload/validate` (`UploadDownloadController.cs:130-148`) | Verified — the first draft ignored it |
| Cleanup: `DELETE uploadDownload/deleteTemp`, JSON body of names, `TEMP\` stripped case-insensitively, per-item `{FileName, Result}` | `:150-200` | Verified |
| An empty/absent file returns `string.Empty`, not an error | `:98-101` | Verified |

## Gate 1 (rewritten — the only remaining gate, and it is bigger than the first draft's)

One live capture of a real attachment upload against Cronus28, recording **all** of:

1. **Transport** — exact URL including the `/client` prefix (the controller attribute carries no
   prefix; the mount point is inferred from `HttpConstants` and must be confirmed), request headers,
   multipart boundary and field name, filename encoding, and the raw response body. An ASP.NET
   `Task<string>` may serialise as a quoted JSON string with an escaped backslash, so
   `postMultipart` needs a stated parsing rule.
2. **Session identity** — which value goes in `server-session-id`. Our `BCSession` captures a field
   named `ServerSessionId` (`src/session/bc-session.ts:125-141`), but the browser initialisation
   payload also writes a `ServerSessionId` sourced from `ClientSession.HandlerSessionId`
   (`BrowserPageSessionInitializationSerializer.cs:90-96`), and exposes both `TenantId` and
   `RuntimeTenantId` (`:103-109`). Same name, possibly different values. Record both.
3. **Antiforgery** — whether the POST/DELETE need a CSRF token. Our provider holds one but exposes
   it only as a WebSocket query parameter, never as an HTTP header
   (`src/connection/auth/ntlm-provider.ts:123-137`).
4. **The interaction payload** — the `InvokeFileUploadAction` JSON the browser sends, specifically
   whether `FileToken` keeps the `TEMP\` prefix or is the bare GUID, and the casing inside
   `namedParameters`. The first draft treated this as settled; nothing in the decompiled source
   settles it. (`deleteTemp` tolerantly strips the prefix, which hints at the prefixed form.)
5. **`AllowedFileExtensions` format** — the delimiter, wildcard behaviour, case sensitivity, and
   what an empty string means. The property name is settled; its grammar is not.

## Design

### Transport

`BCHttpClient` (from the download spec) gains, implemented here:

```ts
postMultipart(relativeUrl, parts, extraHeaders?, timeoutMs?): Promise<HttpPayload>;
deleteJson(relativeUrl, body, extraHeaders?, timeoutMs?): Promise<HttpPayload>;
```

Session headers are assembled by a session-bound wrapper, because `BCSession.sessionId` is
**private with no getter** today — the composition must expose it deliberately rather than the
service reaching in.

### Source resolution

`src/services/file-source.ts`

```ts
export type FileSource =
  | { fileName?: string; filePath: string }
  | { fileName: string; contentBase64: string };
```

Rules:

- Exactly one of `filePath` / `contentBase64`; both or neither is an error.
- `fileName` defaults to the basename of `filePath`; it is **required** with `contentBase64`.
- Base64 is decoded **strictly** — Node's decoder is lenient and silently drops invalid characters.
- Size is measured on the **decoded/read bytes**, not on stat metadata, checked against
  `BC_MAX_UPLOAD_BYTES` (default 50 MB) and against the session's `MaxFileUploadSize` when Gate 1
  establishes its units (file bytes or whole request). Until then the local cap is the only cap we
  claim to enforce.
- Zero-byte files are rejected client-side: BC returns an empty token for them, which would poison
  step 2.
- Filenames are validated against path separators, CR/LF, NUL, and quotes before they reach a
  multipart header.
- **All sources are resolved and validated before any network I/O**, so a bad third file cannot
  leave the first two uploaded.

`filePath` reads from the machine running the server with its own permissions, and no sandbox root.
That is a deliberate product decision for a local stdio server, recorded as such — not waved away.
Remote deployments should use `contentBase64`, and the tool description says so.

### Control discovery

`FileUploadNode` becomes a `FormNode` variant built from a `t === 'fla'` branch in
`form-tree-builder.ts` (the builder dispatches on raw `t` values at `:78-91`; adding `fla` to
`wire-types.ts` alone does nothing). It carries `allowedFileExtensions`, `allowMultipleFiles`,
`definitionId`, plus `visible` / `enabled`.

A memoised `uploadTargets(root)` view feeds `Section.uploadTargets`:

```ts
Array<{ controlPath: string; caption: string; allowedExtensions: string[]; allowMultiple: boolean }>
```

`controlPath` is the identifier — not `DefinitionId`, not `ControlIdentifier` — so the caller's
`control` input can be either the caption or the path. Duplicate captions produce an ambiguity
error listing the paths.

### `UploadService`

1. Resolve the target: by `control` if given; if the section has exactly one visible, enabled
   target, use it; otherwise error listing candidates.
2. Validate client-side against `allowedFileExtensions` / `allowMultipleFiles`.
3. Call `POST uploadDownload/validate` with the filenames for the **server-config** filter. This is
   a different check from the control's own list and is the one that produces
   `FileTypeNotAllowedUpload` after bytes are sent. Free preflight; the first draft ignored it.
4. `postMultipart` each file, collecting tokens.
5. One `InvokeFileUploadAction` carrying all tokens.
6. Classify business errors, detect changed sections and dialogs as every other mutating operation
   does.

Steps 4-5 are not atomic and `VerifyFormModality()` can reject at step 5. So:

- `expectedStateVersion` is checked **before** step 4 and **re-checked** before step 5.
- On any failure after step 4, `deleteTemp` is called with the collected tokens. Caveats recorded:
  cleanup needs the same session headers (impossible on a dead session), a 2xx response can still
  carry `Result: false` per item, and a cleanup failure must never replace the original error.
- If step 5 times out, the outcome is **unknown** — the error says so explicitly rather than
  implying failure, because the attachment may exist.

### Tool

```
bc_upload_file {
  pageContextId, files: [{ fileName?, filePath?, contentBase64? }],
  section?, control?, expectedStateVersion?
}
```

Returns `{ uploaded: [{fileName, sizeBytes}], changedSections, dialogsOpened, requiresDialogResponse }`.

## Files touched

```
new   src/services/upload-service.ts
new   src/services/file-source.ts
new   src/operations/upload-file.ts
new   src/operations/upload-file.tool.ts
edit  src/connection/bc-http.ts            (postMultipart, deleteJson)
edit  src/protocol/types.ts                (FileUploadInteraction)
edit  src/protocol/interaction-encoder.ts  (InvokeFileUploadAction)
edit  src/protocol/form-node.ts            (FileUploadNode)
edit  src/protocol/form-tree-builder.ts    (t === 'fla' branch)
edit  src/protocol/form-views.ts           (uploadTargets)
edit  src/protocol/section-dto.ts          (expose uploadTargets)
edit  src/session/bc-session.ts            (expose session id / upload-size metadata)
edit  src/session/session-factory.ts       (:22-41 constructs the HTTP client)
edit  src/server.ts / src/stdio-server.ts  (both composition roots, :65-111 / :65-108)
edit  src/mcp/schemas.ts                   (UploadFileSchema)
edit  src/mcp/tool-registry.ts             (Operations interface + registration)
edit  src/core/config.ts                   (BC_MAX_UPLOAD_BYTES)
```

REST exposure (`src/api/routes.ts`) is a deliberate decision during planning, not an accident.

## Test plan (TDD order)

**Unit:**

1. Both / neither of `filePath` and `contentBase64` rejected per file.
2. `fileName` from basename; required with base64.
3. Strict base64: malformed input rejected, valid input round-trips byte-identically.
4. Over-cap rejected with zero fetch calls (spy).
5. Zero-byte file rejected client-side.
6. Filename with a path separator / CR / quote rejected before multipart assembly.
7. All sources validated before the first upload (a bad third file → zero uploads).
8. Multipart body: field name `file`, boundary, filename encoding, binary preserved.
9. Token response parsed from both a bare string and a quoted JSON string.
10. Encoder emits `InvokeFileUploadAction` with `files: [{FileName, FileToken}]`.
11. Multiple tokens go in **one** interaction, not several.
12. Tree builder produces a `FileUploadNode` from an `fla` fixture with parsed extensions.
13. `uploadTargets` memoised (same root → same reference).
14. Disallowed extension → rejected before any HTTP call.
15. Two files with `allowMultipleFiles: false` → rejected.
16. `/validate` rejection surfaces before bytes are sent.
17. Interaction failure → `deleteTemp` called with the collected tokens; a cleanup failure does not
    replace the original error.
18. Interaction timeout → error explicitly states the outcome is unknown.
19. Two upload controls, no `control` → error listing both control paths.
20. Stale `expectedStateVersion` rejected before upload **and** re-checked before invoke.
21. HTTP 401 / 413 / 5xx / malformed body mapped distinctly (401 means auth, session, or tenant —
    not only "the header contract broke").

**Integration — Cronus28, destructive:**

22. Attach a small text file to a Sales Order; read the attachment list back; delete it.
23. Attach a PDF (different extension class, exercises the type filter).
24. Multi-file upload against a control with `AllowMultipleFiles: true`.
25. Live `deleteTemp` for an orphaned token.
26. Upload attempted while a modal dialog is stacked → the `VerifyFormModality` error path.
27. Server-side oversize rejection (a file above the session cap but below the local cap).
28. **Round trip with spec 1**: upload a file, download it back via the attachment's download
    action, assert byte equality. Strongest single proof both halves work.

Test 15 in the first draft asserted "no HTTP call made" for a `.exe`; that assertion belongs in the
unit tier (test 14 here), because the integration tier cannot observe it without instrumentation —
and the control's own extension list may permit an extension the *server* config rejects.

## Definition of done

- Gate 1 closed, all five items recorded in the plan and CLAUDE.md.
- Unit + integration green.
- `npx tsc --noEmit` clean.
- CLAUDE.md gains a "File Upload Protocol" section: Path A flow, header contract, token format as
  captured, the modality precondition, the two extension filters, and the temp-token lifecycle.

## Out of scope

- **Path B** (`File.UploadIntoStream`) — its own spec, with its own capture gate.
- Chunked or resumable upload; BC takes one multipart body.
- Uploading by URL.
