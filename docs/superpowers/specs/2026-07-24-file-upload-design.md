# File Upload — Design

**Date:** 2026-07-24
**Size:** L
**Build order:** 6 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/file-upload`
**Depends on:** [download-capture](2026-07-24-download-capture-design.md) for `BCHttpClient`

## Problem

There is no upload path of any kind. `src/protocol/interaction-encoder.ts:165-193` encodes ten
interaction types; none of them moves bytes to the server, and nothing in `src/` touches BC's
upload endpoints.

Blocked flows, all common: attaching a document to a Sales Order or Customer, Incoming Documents
(the whole OCR/e-invoice on-ramp), importing a Configuration Package, importing a bank statement,
setting an Item picture, importing a data-exchange definition.

This is the largest single class of unreachable functionality in the server.

## Evidence

The mechanism is fully mapped in the decompiled source — no protocol spike is required for the
core path, only a live confirmation of which host serves it (see the gate below).

### Two distinct upload paths

**Path A — `FileUploadActionControl` (page-embedded upload area).** Used by Attachments,
Incoming Documents, Item pictures. Two steps:

1. `POST {clientBase}/uploadDownload/uploadTemp`, `multipart/form-data`, form field named `file`.
   Returns the string `"TEMP\<guid>"` — the file token.
   - `Microsoft.Dynamics.Nav.Service.ClientService/UploadDownloadController.cs:92-128`
   - Route constants: `Microsoft.Dynamics.Nav.Types/Constants/HttpConstants.cs:20-40`
     (`BaseRoute = "client"`, `UploadDownloadRoute = "uploadDownload"`, `UploadTempRoute = "uploadTemp"`)
   - Extension check happens server-side first: `FileTypeFilter.IsFileTypeAllowedByConfiguration`
     (line 102), then a malware scan (line 110) which deletes the temp file and throws on detection.
2. Send interaction `InvokeFileUploadAction` against the control, with
   `namedParameters.files = [{ FileName, FileToken }]`.
   - `Microsoft.Dynamics.Framework.UI/FileUploadActionInteraction.cs:10` — the interaction name
   - `FileUploadInteractionExecutionStrategy.cs:24-27` — reads the `files` parameter as
     `IList<UploadedTempFile>` off a resolved `FileUploadActionControl`
   - `Microsoft.Dynamics.Nav.Types/UploadedTempFile.cs` — exactly two members, `FileName` and `FileToken`

**Path B — `Session.UploadAction` (AL `File.UploadIntoStream` modal dialog).** One step:
`POST {clientBase}/uploadDownload/upload` with the same multipart shape. The server hands the
stream straight to the pending `UploadAction` and returns an `UploadResponse`
(`UploadDownloadController.cs:39-67`). Note this route is declared `SessionUsage.None` (line 38) —
it attaches to the session's pending upload action rather than opening a session scope.

### Auth

`UploadDownloadController` is decorated `[SessionId]`
(`UploadDownloadController.cs:19`), whose filter requires two headers and rejects with 401
otherwise:

- `server-tenant-id`
- `server-session-id`, matched against `NavSession.ExternalId`

Source: `Microsoft.Dynamics.Nav.Service.AspNetCore/Filters/SessionIdAttribute.cs:15-39`.

### Control metadata available to us

`FileUploadActionControlSerializer.cs:18-33` writes `DefinitionId`, `ScopeType`,
`AllowedFileExtensions`, `AllowMultipleFiles`, `ShortcutKeys`. The web client maps the control as
`BrowserFileUploadActionControl`
(`Microsoft.Dynamics.Framework.UI.Web/BrowserLogicalControlSerializerMappingRules.cs:30`) and
publishes a size cap as `MaxFileUploadSize` in the session init payload
(`BrowserPageSessionInitializationSerializer.cs:218`).

## Verification gates (close before writing the service)

Two unknowns, both cheap to settle, both capable of changing the transport code:

**Gate 1 — endpoint reachability and session id.** Our socket is `/csh`
(`src/connection/connection-factory.ts:61`), served by the web-client stack, while
`UploadDownloadController` lives in `Microsoft.Dynamics.Nav.Service.ClientService`. On BC28 both
are hosted by the same NST process, so `http://cronus28/BC/client/uploadDownload/uploadTemp`
should serve our session — but "should" is not verification, and the earlier report-download work
found the web client using an entirely different handler (`DynamicFileHandler.axd`) for downloads.

Settle it by capturing a real upload from the browser against Cronus28 (attach a small file to a
Sales Order) and recording: the exact URL, the request headers, the multipart field name, and the
response body. Then confirm whether `server-session-id` equals the `ServerSessionId` we already
capture at `src/session/bc-session.ts:131`, or something else.

If the web client turns out to use a different endpoint, the design below is unchanged apart from
the URL and header assembly inside `UploadService` — the interaction half is settled either way.

**Gate 2 — wire type of the upload control.** `src/protocol/wire-types.ts:38-46` lists only four
control-type aliases; the rest are discovered live. Capture a page with an upload area (Incoming
Documents, or the Attachments factbox on a Sales Order) and record the `Type` value BC actually
emits for `FileUploadActionControl`, plus the spelling of `AllowedFileExtensions` /
`AllowMultipleFiles` (long name or alias). Feeds the tree-builder work directly.

## Design

### Transport

`BCHttpClient.postMultipart` (declared in the download-capture spec, implemented here):

```ts
postMultipart(
  relativeUrl: string,
  parts: Array<{ name: string; fileName: string; contentType: string; body: Buffer }>,
  extraHeaders?: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpPayload>;
```

Same auth headers, same base-URL joining, same error mapping as `get`. One HTTP client for the
whole server.

### Source resolution

`src/services/file-source.ts` — pure-ish, one job: turn caller input into bytes.

```ts
export type FileSource =
  | { fileName: string; filePath: string }
  | { fileName: string; contentBase64: string };

export async function readFileSource(src: FileSource, maxBytes: number): Promise<FileBytes>;
```

Rules:

- `filePath` is read from the machine running the MCP server, with the server's own permissions.
  It is resolved to an absolute path and read directly — no sandbox root, because the server
  already runs as the user and the user is asking for their own file. The tool description says
  this plainly so a remote-server deployment knows to use `contentBase64` instead.
- Exactly one of `filePath` / `contentBase64` per file; both or neither is an error.
- `fileName` is always caller-supplied (it is what BC stores and what the extension check runs
  against), defaulting to the basename of `filePath`.
- Size is checked against `BC_MAX_UPLOAD_BYTES` (default 50 MB) before any network call, and
  against the session's `MaxFileUploadSize` when we have captured it.

### Control discovery

`FileUploadNode` becomes a first-class `FormNode` variant (like `StackGroupNode` / `CueFieldNode`),
carrying `allowedFileExtensions: string[]` and `allowMultipleFiles: boolean`. A memoised view
`uploadTargets(root)` in `form-views.ts` lists them, and `Section` gains
`uploadTargets?: Array<{ id, caption, allowedExtensions, allowMultiple }>` so the LLM can see that
a page accepts files at all — discovery is half the feature.

### `UploadService`

`src/services/upload-service.ts`

```ts
class UploadService {
  uploadToControl(pcId, files: FileSource[], opts: { section?, control? }): Promise<Result<UploadResult, BCError>>;
  uploadToDialog(pcId, file: FileSource): Promise<Result<UploadResult, BCError>>;   // path B
}
```

`uploadToControl`:

1. Resolve the target upload control (by caption/id if `control` given; if the section has exactly
   one, use it; if several and none named, error listing them).
2. Validate client-side against `allowedFileExtensions` and `allowMultipleFiles`, with a clear
   message — BC's own rejection is a generic `FileTypeNotAllowedUpload` and arrives after the bytes
   have been sent.
3. `postMultipart` each file, collect `{FileName, FileToken}`.
4. One `InvokeFileUploadAction` carrying all tokens (BC's parameter is a list; multiple files are
   one interaction, not N).
5. Return the resulting events through the normal machinery — changed sections, dialogs opened,
   validation errors classified by `classifyBusinessError`.

Temp-file hygiene: if step 3 succeeds for some files and step 4 never runs (validation failure,
session death), the tokens are orphaned server-side. `DELETE {clientBase}/uploadDownload/deleteTemp`
with the token list cleans up (`UploadDownloadController.cs:150-200`); the service calls it on any
failure path after a successful upload. Without this a retry loop litters the AL temp directory.

### Tool

```
bc_upload_file {
  pageContextId: string,
  files: Array<{ fileName?: string, filePath?: string, contentBase64?: string }>,
  section?: string,
  control?: string,
  expectedStateVersion?: number,
}
```

Returns `{ uploaded: [{fileName, sizeBytes}], changedSections, dialogsOpened, requiresDialogResponse }`.

Path B (`uploadToDialog`) is reached through the same tool: when the page context's active form is
a file-upload dialog rather than a page with an upload control, the service takes the one-step
route. The caller does not choose the path — it is a property of what BC has open, and making the
LLM guess would be a design error. Detection rule is pinned during gate 1's capture.

### Error handling

| Condition | Result |
|---|---|
| Both / neither of `filePath` and `contentBase64` | `ProtocolError`, per-file, before any I/O |
| File missing or unreadable | `ProtocolError` with the resolved absolute path |
| Over `BC_MAX_UPLOAD_BYTES` or session cap | `ProtocolError` naming both the size and the cap |
| Extension not in `allowedFileExtensions` | `ProtocolError` listing the allowed set |
| Multiple files, `allowMultipleFiles: false` | `ProtocolError` |
| HTTP 401 from the upload endpoint | `ProtocolError` code `UPLOAD_AUTH` — means the session-id header contract broke; points at gate 1 |
| Malware scanner rejection (BC throws) | Surfaced verbatim; do not soften or retry |
| Upload succeeded, interaction failed | Temp tokens deleted, error returned, message states the file reached the server but was not attached |

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
edit  src/protocol/form-tree-builder.ts    (build it, per gate 2)
edit  src/protocol/form-views.ts           (uploadTargets view)
edit  src/protocol/section-dto.ts          (expose uploadTargets)
edit  src/protocol/wire-types.ts           (alias from gate 2)
edit  src/mcp/tool-registry.ts             (register bc_upload_file)
edit  src/core/config.ts                   (BC_MAX_UPLOAD_BYTES)
```

## Test plan (TDD order)

**Unit — write first:**

1. `readFileSource` rejects both-supplied and neither-supplied.
2. `readFileSource` derives `fileName` from `filePath` basename when omitted.
3. `readFileSource` rejects over-cap files without touching the network (spy: no fetch).
4. `readFileSource` decodes base64 to identical bytes (round-trip a fixture).
5. Encoder emits `InvokeFileUploadAction` with `files: [{FileName, FileToken}]` and the control path.
6. Encoder puts multiple tokens in a single interaction, not several.
7. Tree builder produces a `FileUploadNode` with parsed `allowedFileExtensions` (from the gate-2 fixture).
8. `uploadTargets` view is memoised (same root -> same reference).
9. Service rejects a disallowed extension before any HTTP call.
10. Service rejects 2 files when `allowMultipleFiles: false`.
11. Service calls `deleteTemp` with the collected tokens when the interaction step fails (mocked HTTP).
12. Service errors, listing candidates, when a section has two upload controls and `control` is omitted.

**Integration — Cronus28, destructive:**

13. Attach a small text file to a Sales Order via the Attachments factbox; re-read the attachment
    list and assert the filename appears; then delete the attachment and assert it is gone.
14. Upload a PDF and assert BC accepts it (different extension class, exercises the type filter).
15. Upload a file with a disallowed extension (e.g. `.exe`) and assert a clear client-side rejection
    with no HTTP call made.
16. Round trip against spec 1: upload a file, then download it back through the attachment's
    download action, and assert byte equality. This is the strongest single proof that both halves
    of the file story work.

## Definition of done

- Both gates closed and their answers recorded in the plan and in CLAUDE.md.
- Unit + integration green.
- `npx tsc --noEmit` clean.
- CLAUDE.md gains a "File Upload Protocol" section with both paths, the header contract, and the
  temp-token lifecycle.

## Out of scope

- Drag-and-drop / clipboard semantics. Irrelevant to a programmatic client.
- Chunked or resumable upload. BC's endpoint takes one multipart body.
- Uploading by URL (server fetches the file itself). No BC mechanism for it.
