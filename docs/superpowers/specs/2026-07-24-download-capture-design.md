# Generic Download Capture — Design

**Date:** 2026-07-24
**Size:** S
**Build order:** 1 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/download-capture`

## Problem

BC delivers every client-bound file the same way: an inline
`DN.LogicalClientEventRaisingHandler` event named `UriToShow`, carrying a relative
`DynamicFileHandler.axd` URL. The decoder already turns that into a `FileDownloadReady`
event (`src/protocol/event-decoder.ts:173-188`).

Only one caller consumes it. `BCSession.runReportWithDownload` looks for the event
(`src/session/bc-session.ts:644`) and fetches the bytes through `ReportDownloader`.
Every other path throws it away:

- `bc_execute_action` — "Open in Excel" / "Send to Excel" on any list, "Print" on a
  document, "Export" on a config package, downloading an attachment from the Attachments
  factbox. `ExecuteActionOutput` (`src/operations/execute-action.ts:29-37`) has no download field.
- `bc_respond_dialog` — the OK on a format or export dialog is exactly where BC emits the URI.
- `bc_wizard_navigate` — export wizards finish on a download.

So the LLM can drive the flow to completion, sees `success: true`, and gets nothing back.
The bytes existed and were discarded.

## Evidence

| Claim | Source |
|---|---|
| Downloads arrive inline as `UriToShow` on the invoke callback for `/csh` sessions | `Microsoft.Dynamics.Framework.UI.Web/ResponseManager.cs` — `RegisterUriToShowEvents`; live wire capture 2026-06-15 |
| Style parameter: `0`=View, `1`=Download, `2`=Print | `src/protocol/event-decoder.ts:176-177`, confirmed against `ResponseManager` |
| URL is served by `DynamicFileHandler.axd` keyed on the web client `HandlerSessionId` | `Microsoft.Dynamics.Framework.UI.Web/FileUrlAddressProvider.cs` |
| The existing NTLM/cookie headers suffice — no separate auth token | `src/session/report-downloader.ts:14-22`, verified live (Trial Balance PDF) |

Nothing new needs to be discovered. This spec is plumbing, not protocol archaeology.

## Design

### New unit: `DownloadCollector` (pure)

`src/protocol/download-collector.ts`

```ts
export interface DownloadRef {
  relativeUrl: string;
  style: 'view' | 'download' | 'print';
  suggestedFileName?: string;
}

export function collectDownloads(events: readonly BCEvent[]): DownloadRef[];
```

Pure function over an event array. No I/O, no session. Filters `FileDownloadReady`,
normalises the numeric style to a union, and pulls `fname` from the query string as the
suggested name. Unit-testable in isolation; this is the piece that currently does not exist
and is the reason the logic could not be shared.

### New unit: `BCHttpClient` (transport)

`src/connection/bc-http.ts`

`ReportDownloader` is a general BC-side-channel HTTP client wearing a report-specific name.
Extract the transport, keep the filename parsing:

```ts
export class BCHttpClient {
  constructor(baseUrl: string, getAuthHeaders: () => Record<string, string>, logger: Logger);
  get(relativeOrAbsoluteUrl: string, timeoutMs?: number): Promise<HttpPayload>;
  postMultipart(relativeUrl: string, parts: MultipartPart[], extraHeaders?, timeoutMs?): Promise<HttpPayload>;
}
```

`postMultipart` is not used by this spec — it is declared here because
[file-upload](2026-07-24-file-upload-design.md) needs the identical auth and base-URL joining,
and building a second HTTP client there would duplicate the auth story. Implement `get` now,
`postMultipart` in spec 6. (Alternative considered: leave the extraction to spec 6. Rejected —
spec 6 then either duplicates or does a drive-by refactor of code it does not own.)

`src/session/report-downloader.ts` is deleted. Its filename-extraction helpers move to
`src/connection/http-filename.ts` (pure, already unit-tested behaviour preserved).

### New unit: `DownloadService`

`src/services/download-service.ts`

```ts
export class DownloadService {
  constructor(private http: BCHttpClient, private maxBytes: number, private logger: Logger) {}
  async fetchAll(refs: readonly DownloadRef[]): Promise<Download[]>;
}
```

Single responsibility: turn refs into payloads, enforce the size cap, map HTTP failures into
`ProtocolError`. Injected into `ActionService`, `DialogService`-equivalent (`respond-dialog`'s
service), and the wizard path via their constructors — dependency inversion, no service reaches
for a global.

`BCSession.runReportWithDownload` drops its bespoke fetch and calls the same service, so there is
exactly one code path from `FileDownloadReady` to bytes.

### Output DTO

Uniform across all four tools. `bc_run_report`'s existing singular `download` field is replaced
(the project takes breaking changes freely):

```ts
export interface Download {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  style: 'view' | 'download' | 'print';
  bytes: string;      // base64
}
```

Added as `downloads: Download[]` (empty array, never undefined) to:

- `ExecuteActionOutput`
- `RespondDialogOutput`
- `WizardNavigateOutput`
- `RunReportOutput` (replacing `download`)

Empty-array-not-optional so callers never branch on presence vs emptiness.

### Size cap

`BC_MAX_DOWNLOAD_BYTES`, default 10 MB. A payload above the cap is not base64-encoded into the
response. Instead the operation returns a `ProtocolError` with code `DOWNLOAD_TOO_LARGE`, the
actual `sizeBytes`, and the filename, so the caller knows the export succeeded server-side and
only the transfer was refused. Rationale: a 200 MB Excel export inlined as base64 would blow the
context window, and silently truncating bytes is worse than failing loudly.

### Error handling

| Condition | Behaviour |
|---|---|
| Action succeeds, no `UriToShow` | `downloads: []`, `success: true`. Not an error — most actions do not download. |
| `UriToShow` present, HTTP fetch fails | `ProtocolError` code `DOWNLOAD_FAILED`, message includes the HTTP status and URL. The action already committed server-side; the message must say so. |
| Payload over cap | `DOWNLOAD_TOO_LARGE` as above. |
| Multiple `UriToShow` in one batch | All fetched, all returned, order preserved. |

## Files touched

```
new     src/protocol/download-collector.ts
new     src/connection/bc-http.ts
new     src/connection/http-filename.ts
new     src/services/download-service.ts
delete  src/session/report-downloader.ts
edit    src/connection/connection-factory.ts     (createReportDownloader -> createHttpClient)
edit    src/session/bc-session.ts                (runReportWithDownload uses DownloadService)
edit    src/services/action-service.ts           (inject DownloadService, populate downloads)
edit    src/operations/execute-action.ts         (+ downloads)
edit    src/operations/respond-dialog.ts         (+ downloads)
edit    src/operations/wizard-navigate.ts        (+ downloads)
edit    src/operations/run-report.ts             (download -> downloads)
edit    src/operations/*.tool.ts                 (describe downloads in the 4 tool definitions)
edit    src/core/config.ts                       (BC_MAX_DOWNLOAD_BYTES)
```

## Test plan (TDD order)

**Unit — write first, all failing:**

1. `collectDownloads` returns `[]` for an event array with no `FileDownloadReady`.
2. `collectDownloads` maps style `"0"/"1"/"2"` to `view/download/print`; unknown style defaults to `download`.
3. `collectDownloads` extracts `fname` from the query string, and returns `undefined` when absent.
4. `collectDownloads` preserves order for two `FileDownloadReady` events in one batch.
5. `http-filename`: existing `filename*=UTF-8''`, plain `filename=`, and literal-`%` cases (port the current tests verbatim — behaviour must not regress).
6. `DownloadService.fetchAll` rejects with `DOWNLOAD_TOO_LARGE` when `content-length` or the body exceeds the cap.
7. `DownloadService.fetchAll` maps a 404 to `DOWNLOAD_FAILED` carrying status and URL.

**Integration — Cronus28, destructive allowed but none of these mutate:**

8. Customer List (page 22) -> "Open in Excel" / "Send to Excel" -> assert one download, `contentType`
   is an Excel type, bytes start with `PK` (zip magic).
9. Sales Order (page 42) -> "Print" -> request-page dialog -> `bc_respond_dialog` OK -> assert PDF
   bytes starting `%PDF`.
10. Existing `tests/integration/report-capture.test.ts` migrated to `downloads[0]` and still passes
    for PDF and Excel — proves the refactor did not break the working path.
11. An action with no download (e.g. Refresh) returns `downloads: []`.

## Definition of done

- All unit tests green, integration tests 8-11 green against Cronus28.
- `npx tsc --noEmit` clean.
- One and only one code path from `FileDownloadReady` to bytes (grep: `DynamicFileHandler` and
  `fetch(` appear once each outside tests).
- CLAUDE.md "Report Output Capture" section rewritten as "File Download Capture", covering the
  generic path.

## Out of scope

- Writing downloads to disk. Bytes are returned; the caller decides.
- A fetch-token / deferred-download mode. Inline with a cap was the chosen trade-off.
- `style: 'view'` special handling (opening a preview). Treated as a normal download.
