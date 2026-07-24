# Generic Download Capture — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/01-download-*.md`)
**Size:** M (was S — the security and streaming work is real)
**Build order:** 1 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/download-capture`

## Problem

BC delivers client-bound files as an inline `DN.LogicalClientEventRaisingHandler` event named
`UriToShow`. The decoder already turns it into a `FileDownloadReady` event
(`src/protocol/event-decoder.ts:173-192`).

Only one caller consumes it: `BCSession.runReportWithDownload` (`src/session/bc-session.ts:644-659`).
Every other path discards it — `ExecuteActionOutput` (`src/operations/execute-action.ts:29-37`),
`RespondDialogOutput` (`src/operations/respond-dialog.ts:14-20`), and `WizardNavigateOutput`
(`src/operations/wizard-navigate.ts:18-34`) have no download field.

So the LLM can drive "Open in Excel", "Print", an attachment download, or a config-package export
to completion, see `success: true`, and get nothing back.

## Evidence

| Claim | Source | Status |
|---|---|---|
| `UriToShow` is registered as `DN.LogicalClientEventRaisingHandler` | `ResponseManager.RegisterUriToShowEvents` (`Microsoft.Dynamics.Framework.UI.Web/ResponseManager.cs:205-219`, loop at `:248-267`) | Verified |
| Parameters are `[uri, style]`, style serialized as a decimal ordinal | `ResponseManager.AddUriToShowEventResponseParameters` (`:516-522`) writes `FormattedUri ?? Address` then `Style.ToString("D")` | Verified |
| **The URI is a generic address, not necessarily a file URL** | Same line — `FormattedUri ?? Address`. AL `HYPERLINK` to an external site travels the same event | Verified. Drives the security design below |
| One particular provider builds a relative `DynamicFileHandler.axd?form=&sessionid=&type=&fid=` URL | `FileUrlAddressProvider.cs:11-23` | Verified — but it is one producer among several, and it does **not** emit `fname` |
| Style mapping `View=0, Download=1, Print=2, Preview=3, PreviewWithoutDownload=4, Mailto=5` | `Microsoft.Dynamics.Framework.UI/UriToShowStyle.cs:3-11` | **Verified — Gate 1 closed.** Note `Mailto=5` is a mail link, not a file |
| Multiple `UriToShow` events can arrive in one batch | `RegisterUriToShowEvents` iterates all logical changes (`:248-267`) | Verified |
| Auth is a session **cookie** from the BC SignIn form flow, not NTLM | `src/connection/auth/ntlm-provider.ts:129-131` returns only a `Cookie` header; the class name is a misnomer and CLAUDE.md documents the environment as NavUserPassword | Verified — spec wording corrected throughout |

### Gate 1 — style enum — CLOSED (2026-07-24)

`Microsoft.Dynamics.Framework.UI/UriToShowStyle.cs`:
`View=0, Download=1, Print=2, Preview=3, PreviewWithoutDownload=4, Mailto=5`.

The collector maps all six by ordinal and preserves an out-of-range ordinal verbatim as
`unknown:<n>` (never coerced to `download`). `Mailto` is a mail link, not a file — the same-origin
rule routes it to `externalUris` and it is never fetched.

## Design

### Security model (new — this is the part the first draft got wrong)

`UriToShow` carries arbitrary URIs. Fetching every one of them with the session cookie attached is
an SSRF and credential-leak vector, and it mis-handles ordinary `HYPERLINK` actions.

Rules, enforced in the collector before any network call:

1. **Same-origin only.** The URI must resolve, against `baseUrl`, to the same scheme + host + port.
   A relative URI qualifies by construction. An absolute URI to any other origin does not.
2. **Path allowlist.** The resolved path must sit under BC's known file-serving paths
   (`DynamicFileHandler.axd`, and the `client/uploadDownload/download` route). Anything else is
   classified as external.
3. **External URIs are returned, never fetched.** They surface as
   `externalUris: Array<{ uri, style }>` on the same outputs — the caller still learns the action
   produced a link, without the server dereferencing it.
4. **No automatic redirect following.** `fetch` is called with `redirect: 'manual'`. A 3xx is an
   error naming the location; it is not followed, because a stale dynamic URL redirects to SignIn
   and a hostile one redirects off-origin.
5. **Style `view` is not auto-fetched** unless it also passes rules 1-2. A same-origin
   `DynamicFileHandler.axd` view URL is a file; anything else is a link.
6. **URLs are redacted in logs and error messages** — `sessionid` and `fid` query values are
   replaced before any log line or error string is built.

### New unit: `DownloadCollector` (pure)

`src/protocol/download-collector.ts`

```ts
export interface DownloadRef {
  relativeUrl: string;
  style: 'view' | 'download' | 'print' | `unknown:${string}`;
  suggestedFileName?: string;
}
export interface ExternalUri { uri: string; style: string; }

export function collectDownloads(
  events: readonly BCEvent[],
  origin: { baseUrl: string },
): { refs: DownloadRef[]; external: ExternalUri[] };
```

Pure, no I/O. Applies the same-origin + path rules, normalises known styles, preserves unknown
styles verbatim, and extracts `fname` when present — `fname` is **optional**, since
`FileUrlAddressProvider` does not emit it.

### New unit: `BCHttpClient` (transport)

`src/connection/bc-http.ts` — extracted from `ReportDownloader`, which is a general side-channel
HTTP client wearing a report-specific name.

```ts
export class BCHttpClient {
  constructor(baseUrl: string, getAuthHeaders: () => Record<string, string>, logger: Logger);
  get(relativeUrl: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<HttpPayload>;
}
```

`get` streams the response body and **aborts at `maxBytes + 1`** rather than calling
`arrayBuffer()` — a `Content-Length` check alone is not a cap, because the header can be absent,
wrong, or smaller than the body. It keeps the caller-supplied timeout (the report path currently
uses `max(timeoutMs, 120000)`; that must not regress).

`postMultipart` is **not** declared here. The file-upload spec adds it when it implements it —
declaring an unimplemented method now violates the project's no-stubs rule.

`src/session/report-downloader.ts` is deleted; its filename parsing moves to
`src/connection/http-filename.ts` with its existing tests ported verbatim.

### New unit: `DownloadService`

`src/services/download-service.ts`

```ts
export class DownloadService {
  constructor(private http: BCHttpClient, private limits: DownloadLimits, private logger: Logger) {}
  async capture(events: readonly BCEvent[], opts?: { timeoutMs?: number }): Promise<CaptureResult>;
}
```

The public boundary takes **events**, not refs — collection and fetching must not be two things
every caller has to remember, or the omission this feature exists to fix comes straight back.
`collectDownloads` stays exported for unit testing.

### Output DTO

```ts
export interface Download {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  style: string;
  bytes?: string;              // base64; omitted when error is set
  savedPath?: string;          // when BC_DOWNLOAD_DIR is configured
  error?: { code: 'TOO_LARGE' | 'FETCH_FAILED'; message: string };
}
```

Added as `downloads: Download[]` and `externalUris: ExternalUri[]` (both always present, possibly
empty) to `ExecuteActionOutput`, `RespondDialogOutput`, `WizardNavigateOutput`, and
`RunReportOutput`.

**A failed or oversized download is a per-entry `error`, never a whole-operation failure.** The
action already committed server-side; discarding `openedPages` and `changedSections` because a
fetch failed would leave the caller worse off than today. Only a genuine protocol error fails the
operation.

`fileName` precedence, deterministic: `Content-Disposition` filename → `fname` query value →
`download-{index}{ext}` where `ext` is inferred from `contentType` and defaults to `.bin`. Header
filenames are sanitised (path separators and control characters stripped).

### Disk output — preserved, not dropped

`RunReportOperation` already writes bytes to disk when `BC_REPORT_DIR` is set and returns
`savedPath` (`src/operations/run-report.ts:35-36,103-131`). The first draft silently removed this.
Instead it is **generalised**: `DownloadService` writes every captured download when
`BC_DOWNLOAD_DIR` is set, falling back to `BC_REPORT_DIR` for compatibility, and sets `savedPath`.
This also gives large files a route that does not go through the context window.

### Limits

| Env var | Default | Meaning |
|---|---|---|
| `BC_MAX_DOWNLOAD_BYTES` | 5 MB | Per-file inline cap. Above it: `savedPath` if a directory is configured, plus a per-entry `TOO_LARGE` error and no `bytes`. |
| `BC_MAX_DOWNLOAD_TOTAL_BYTES` | 10 MB | Aggregate per operation. |
| `BC_MAX_DOWNLOADS` | 5 | Count cap per operation; extras are reported as skipped. |

5 MB inline is already ~6.7 MB of base64 after encoding and pretty-printing in
`src/mcp/handler.ts:153-165`. Anything larger belongs on disk.

### Ordering against business errors

`ExecuteActionOperation` and `WizardNavigateOperation` classify business errors from the event
batch **before** capture runs. A batch carrying a BC error does not trigger network I/O. Stated
explicitly because the alternative (fetch first, classify later) causes an authenticated GET on
behalf of a failed action.

### Known limitation, documented not fixed

Nested invokes performed by hydration strategies (`ChildFormHydrationStrategy` calls
`session.invoke` internally, `src/services/strategies/child-form-hydration.ts:103-156`) apply their
events internally and do not propagate them to the originating operation. A `UriToShow` emitted
during hydration is therefore still lost. Out of scope here; recorded so the claim of "generic
capture" is not overstated.

## Files touched

```
new     src/protocol/download-collector.ts
new     src/connection/bc-http.ts
new     src/connection/http-filename.ts
new     src/services/download-service.ts
delete  src/session/report-downloader.ts
edit    src/connection/connection-factory.ts    (createReportDownloader -> createHttpClient)
edit    src/session/session-factory.ts          (constructs/injects the client today, :22-41)
edit    src/server.ts                           (composition root, :65-111)
edit    src/stdio-server.ts                     (duplicate composition root, :65-108)
edit    src/session/bc-session.ts               (runReportWithDownload uses DownloadService)
edit    src/services/action-service.ts          (inject DownloadService)
edit    src/operations/execute-action.ts        (+ downloads, externalUris)
edit    src/operations/respond-dialog.ts        (+ downloads; invokes BCSession directly, so
                                                 capture is wired here, not in a dialog service)
edit    src/operations/wizard-navigate.ts       (+ downloads)
edit    src/operations/run-report.ts            (download -> downloads; savedPath preserved)
edit    src/operations/*.tool.ts                (describe the new output fields)
edit    src/core/config.ts                      (three limits + BC_DOWNLOAD_DIR)
```

## Test plan (TDD order)

**Unit — security first, they are the reason this spec grew:**

1. Relative URI under `DynamicFileHandler.axd` → ref.
2. Absolute same-origin URI under an allowed path → ref.
3. Absolute **off-origin** URI → `external`, and no fetch is attempted (spy asserts zero calls).
4. Same-origin URI on a non-allowlisted path → `external`.
5. `style: view` off-origin → `external`; `style: view` same-origin file path → ref.
6. Unknown style ordinal → preserved as `unknown:<n>`, not coerced to download.
7. 3xx response with `redirect: 'manual'` → `FETCH_FAILED` naming the location, body not read.
8. Log/error strings redact `sessionid` and `fid`.
9. Streaming abort: a body exceeding the cap aborts after `maxBytes + 1` and never buffers the
   whole payload (assert the read count, not just the error).
10. Missing / malformed / lying `Content-Length` all still capped by the streaming check.
11. Aggregate cap and count cap produce reported skips, not silent truncation.
12. Filename precedence chain, including the `download-0.pdf` fallback and header sanitisation.
13. Existing `http-filename` cases ported verbatim (RFC 5987, plain, literal `%`).
14. Multiple downloads preserve order; one failing entry does not remove the others.
15. Business error in the batch → capture skipped, no fetch.
16. `BC_DOWNLOAD_DIR` set → `savedPath` written; unset → omitted. `BC_REPORT_DIR` still honoured.
17. Config rejects zero/negative/malformed limit values (current `optionalEnvInt` accepts partial
    `parseInt` results, `src/core/config.ts:47-52`).
18. All four operations return `downloads: []` and `externalUris: []` when nothing was emitted.

**Integration — Cronus28:**

19. Customer List (22) → "Open in Excel" → one download, `PK` magic bytes. If the ribbon exposes
    "Edit in Excel" instead, that is the add-in path and does **not** emit `UriToShow` — the plan
    must pin the exact action caption from a live read first.
20. Sales Order (42) → Print → request dialog → `bc_respond_dialog` OK → `%PDF` bytes.
21. Wizard path: an export wizard finishing on a download (the wizard output is a deliverable and
    had zero coverage in the first draft).
22. An action invoking `HYPERLINK` to an external site → `externalUris` populated, `downloads` empty,
    and no outbound request to that host.
23. Existing `tests/integration/report-capture.test.ts` migrated to `downloads[0]`, retaining its
    PDF **and** Excel **and** Word cases.
24. Refresh → both arrays empty.

## Definition of done

- Unit + integration green, including the security tests.
- `npx tsc --noEmit` clean.
- Gate 1 closed (style enum located or captured).
- One code path from `FileDownloadReady` to bytes.
- CLAUDE.md "Report Output Capture" rewritten as "File Download Capture", covering the generic
  path, the same-origin rule, and the disk-output behaviour.

## Out of scope

- A fetch-token / deferred-download mode. `savedPath` covers the large-file case.
- Propagating downloads out of nested hydration invokes (documented above).
- `postMultipart` — belongs to the file-upload spec.
