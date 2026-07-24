# Generic Download Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every mutating MCP tool captures the file bytes BC emits (Open in Excel, Print, export, report render), returning them inline (or on disk) with per-download error handling, instead of only the report flow doing so.

**Architecture:** A pure `collectDownloads` classifies `FileDownloadReady` events into fetchable same-origin refs vs external URIs (SSRF guard). A session-authenticated `BCHttpClient` streams bytes with a hard size-abort. `DownloadService.capture(events)` ties them together — collect, fetch, cap, map errors per entry, optionally write to disk. The four operations (`bc_execute_action`, `bc_respond_dialog`, `bc_wizard_navigate`, `bc_run_report`) call `capture` and expose `downloads[]` + `externalUris[]`. The report path stops fetching inside `BCSession` and routes through the same service, giving one code path from event to bytes.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest, Node `fetch` + `ReadableStream`, `zlib` (existing decompression), `uuid`.

## Global Constraints

- ESM project — every relative import ends in `.js`. Verified by `npx tsc --noEmit`.
- Windows dev host — use Git-bash with Windows paths; never `2>nul`; no emojis in source.
- Run `npx tsc --noEmit` after every task; run `npx vitest run` (unit) before every commit.
- No stubs, mocks, or skeletons in shipped code — everything fully functional. `postMultipart` is NOT added in this plan (belongs to the file-upload spec).
- Breaking output-shape changes are allowed (project is pre-release); `bc_run_report`'s singular `download` becomes `downloads[]`.
- Security is load-bearing: an authenticated GET is only ever issued for a **same-origin** URL under an allowlisted BC file path, with `redirect: 'manual'`. External/`mailto` URIs are returned, never fetched.
- `UriToShowStyle` ordinals (decompiled `UriToShowStyle.cs`): `View=0, Download=1, Print=2, Preview=3, PreviewWithoutDownload=4, Mailto=5`. Out-of-range → `unknown:<n>`.
- Size caps (env, with these defaults): `BC_MAX_DOWNLOAD_BYTES=5242880` (5 MB per file), `BC_MAX_DOWNLOAD_TOTAL_BYTES=10485760` (10 MB aggregate), `BC_MAX_DOWNLOADS=5` (count), `BC_DOWNLOAD_DIR` (unset = no disk write; falls back to `BC_REPORT_DIR`).

---

## File Structure

```
new     src/protocol/download-collector.ts     pure: events -> {refs, external}; security classification
new     src/connection/http-filename.ts         pure: Content-Disposition / fname parsing (moved from report-downloader)
new     src/connection/bc-http.ts                BCHttpClient: session-auth streaming GET with size abort
new     src/services/download-service.ts         capture(events) -> {downloads, externalUris}; caps + disk + per-entry errors
delete  src/session/report-downloader.ts         logic split into http-filename.ts + bc-http.ts
edit    src/core/config.ts                        DownloadLimits + 4 env vars + BC_DOWNLOAD_DIR
edit    src/connection/connection-factory.ts      createReportDownloader -> createHttpClient
edit    src/session/bc-session.ts                 runReportWithDownload returns events only; drop reportDownloader dep
edit    src/session/session-factory.ts            build BCHttpClient + DownloadService; inject into operations
edit    src/server.ts                             composition: build DownloadService, pass to 4 operations
edit    src/stdio-server.ts                       same composition changes
edit    src/operations/run-report.ts              download -> downloads[]; capture via DownloadService
edit    src/operations/execute-action.ts          + downloads[], externalUris[]
edit    src/operations/respond-dialog.ts          + downloads[], externalUris[]
edit    src/operations/wizard-navigate.ts         + downloads[], externalUris[]
edit    src/operations/*.tool.ts                  describe the new output fields (4 tools)
new     tests/unit/download-collector.test.ts
new     tests/unit/bc-http.test.ts
new     tests/unit/http-filename.test.ts          ported from report-downloader.test.ts
new     tests/unit/download-service.test.ts
edit    tests/integration/report-capture.test.ts  migrate to downloads[0]; build DownloadService
delete  tests/unit/report-downloader.test.ts       superseded by http-filename + bc-http tests
```

---

### Task 1: Config — download limits

**Files:**
- Modify: `src/core/config.ts` (add to `BCConfig` interface ~`:3-21` and `loadConfig` ~`:80-100`)
- Test: `tests/unit/config.test.ts` (existing file — append)

**Interfaces:**
- Produces: `BCConfig.downloadLimits: { maxBytes: number; maxTotalBytes: number; maxDownloads: number; dir?: string }`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/config.test.ts`:

```typescript
describe('download limits', () => {
  const KEYS = ['BC_MAX_DOWNLOAD_BYTES', 'BC_MAX_DOWNLOAD_TOTAL_BYTES', 'BC_MAX_DOWNLOADS', 'BC_DOWNLOAD_DIR', 'BC_REPORT_DIR'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); KEYS.forEach(k => delete process.env[k]); });
  afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('defaults to 5MB / 10MB / 5 / no dir', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    const c = loadConfig();
    expect(c.bc.downloadLimits).toEqual({ maxBytes: 5242880, maxTotalBytes: 10485760, maxDownloads: 5, dir: undefined });
  });

  it('BC_DOWNLOAD_DIR wins over BC_REPORT_DIR', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_REPORT_DIR = '/reports';
    process.env.BC_DOWNLOAD_DIR = '/downloads';
    expect(loadConfig().bc.downloadLimits.dir).toBe('/downloads');
  });

  it('falls back to BC_REPORT_DIR when BC_DOWNLOAD_DIR unset', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_REPORT_DIR = '/reports';
    expect(loadConfig().bc.downloadLimits.dir).toBe('/reports');
  });
});
```

Ensure `beforeEach, afterEach` are imported from `vitest` at the top of the file (add if absent).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts -t "download limits"`
Expected: FAIL — `downloadLimits` is undefined.

- [ ] **Step 3: Implement**

In `src/core/config.ts`, add to the `BCConfig` interface (after `odataCompanyName`):

```typescript
  downloadLimits: {
    maxBytes: number;
    maxTotalBytes: number;
    maxDownloads: number;
    /** Directory to write captured downloads to. undefined = no disk write. */
    dir: string | undefined;
  };
```

In `loadConfig`, inside the `bc:` object literal (after `odataCompanyName`):

```typescript
      downloadLimits: {
        maxBytes: optionalEnvInt('BC_MAX_DOWNLOAD_BYTES', 5_242_880),
        maxTotalBytes: optionalEnvInt('BC_MAX_DOWNLOAD_TOTAL_BYTES', 10_485_760),
        maxDownloads: optionalEnvInt('BC_MAX_DOWNLOADS', 5),
        dir: process.env['BC_DOWNLOAD_DIR'] || process.env['BC_REPORT_DIR'] || undefined,
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts -t "download limits"`
Expected: PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/unit/config.test.ts
git commit -m "feat(config): download size limits and BC_DOWNLOAD_DIR"
```

---

### Task 2: http-filename — extract pure filename parsing

**Files:**
- Create: `src/connection/http-filename.ts`
- Create: `tests/unit/http-filename.test.ts`
- Reference (copy from, do not yet delete): `src/session/report-downloader.ts:58-88`

**Interfaces:**
- Produces: `fileNameFromResponse(disposition: string, relativeUrl: string): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/http-filename.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fileNameFromResponse } from '../../src/connection/http-filename.js';

describe('fileNameFromResponse', () => {
  it('prefers RFC 5987 filename* and percent-decodes it', () => {
    expect(fileNameFromResponse("attachment; filename*=UTF-8''Trial%20Balance.pdf", 'x')).toBe('Trial Balance.pdf');
  });
  it('falls back to plain filename= verbatim (no decode)', () => {
    expect(fileNameFromResponse('attachment; filename="100% Done.pdf"', 'x')).toBe('100% Done.pdf');
  });
  it('falls back to fname query param when no disposition', () => {
    expect(fileNameFromResponse('', 'DynamicFileHandler.axd?fname=Report.xlsx')).toBe('Report.xlsx');
  });
  it('returns undefined when nothing is available', () => {
    expect(fileNameFromResponse('', 'DynamicFileHandler.axd?form=41D')).toBeUndefined();
  });
  it('does not double-decode a literal % in the fname param', () => {
    expect(fileNameFromResponse('', 'x?fname=100%25%20Done.pdf')).toBe('100% Done.pdf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/http-filename.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/connection/http-filename.ts` — move the two helpers from `report-downloader.ts:58-88` and wrap them:

```typescript
/** Extract a download filename from a Content-Disposition header, else the URL's fname param. */
export function fileNameFromResponse(disposition: string, relativeUrl: string): string | undefined {
  return extractFromDisposition(disposition) ?? extractFromUrl(relativeUrl);
}

function extractFromDisposition(disposition: string): string | undefined {
  // RFC 5987 form (filename*=UTF-8''...) is percent-encoded and takes precedence.
  const extMatch = disposition.match(/filename\*=UTF-8''([^";\r\n]+)/i);
  if (extMatch) {
    const raw = extMatch[1]!.trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  // Plain filename="..." is used verbatim — decoding a literal % would throw.
  const plainMatch = disposition.match(/filename=["']?([^"';\r\n]+)/i);
  return plainMatch ? plainMatch[1]!.trim() : undefined;
}

function extractFromUrl(relativeUrl: string): string | undefined {
  try {
    // URLSearchParams.get already percent-decodes; do NOT decode again.
    const params = new URLSearchParams(relativeUrl.includes('?') ? relativeUrl.split('?')[1] : '');
    return params.get('fname') ?? undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/http-filename.test.ts`
Expected: PASS (5 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/connection/http-filename.ts tests/unit/http-filename.test.ts
git commit -m "feat(connection): extract pure http-filename parsing"
```

---

### Task 3: BCHttpClient — session-auth streaming GET with size abort

**Files:**
- Create: `src/connection/bc-http.ts`
- Create: `tests/unit/bc-http.test.ts`

**Interfaces:**
- Consumes: `fileNameFromResponse` (Task 2); a `Logger` (`src/core/logger.ts`)
- Produces:
  ```typescript
  export interface HttpPayload { bytes: Buffer; contentType: string; fileName?: string; }
  export class BCHttpClient {
    constructor(baseUrl: string, getAuthHeaders: () => Record<string, string>, logger: Logger);
    // Resolves relativeUrl against baseUrl, streams the body, aborts past maxBytes.
    // Throws Error('TOO_LARGE') when the body exceeds maxBytes; Error with HTTP status text on !ok.
    get(relativeUrl: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<HttpPayload>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bc-http.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BCHttpClient } from '../../src/connection/bc-http.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const BASE = 'http://cronus28/BC';
const AUTH = () => ({ Cookie: 'session=abc' });

function streamResponse(chunks: Buffer[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(new Uint8Array(c)); controller.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } });
}

describe('BCHttpClient.get', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs baseUrl + relativeUrl with the auth headers and returns bytes', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(streamResponse([Buffer.from('%PDF-1.7')]));
    const c = new BCHttpClient(BASE, AUTH, logger);
    const r = await c.get('DynamicFileHandler.axd?fname=a.pdf', { maxBytes: 1000 });
    expect(spy).toHaveBeenCalledWith('http://cronus28/BC/DynamicFileHandler.axd?fname=a.pdf', expect.objectContaining({
      method: 'GET', redirect: 'manual', headers: expect.objectContaining({ Cookie: 'session=abc' }),
    }));
    expect(r.bytes.toString()).toBe('%PDF-1.7');
    expect(r.contentType).toBe('application/pdf');
    expect(r.fileName).toBe('a.pdf');
  });

  it('aborts and throws TOO_LARGE when the streamed body exceeds maxBytes without buffering it whole', async () => {
    // Two 600-byte chunks = 1200 bytes; cap is 1000. Must throw after the 2nd chunk, not buffer a 3rd.
    const chunk = Buffer.alloc(600, 0x41);
    let enqueued = 0;
    const body = new ReadableStream({
      pull(controller) { if (enqueued < 5) { controller.enqueue(new Uint8Array(chunk)); enqueued++; } else controller.close(); },
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'x' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow('TOO_LARGE');
    expect(enqueued).toBeLessThan(5); // proves we stopped pulling, did not read the whole body
  });

  it('throws with the HTTP status on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow(/404/);
  });

  it('treats a 3xx (redirect:manual) as an error naming the location', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/SignIn' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow(/redirect|302|SignIn/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bc-http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/connection/bc-http.ts`:

```typescript
import type { Logger } from '../core/logger.js';
import { fileNameFromResponse } from './http-filename.js';

export interface HttpPayload {
  bytes: Buffer;
  contentType: string;
  fileName?: string;
}

/** Redact sensitive query values before logging a BC file URL. */
function redactUrl(url: string): string {
  return url.replace(/([?&](?:sessionid|fid)=)[^&]*/gi, '$1***');
}

export class BCHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAuthHeaders: () => Record<string, string>,
    private readonly logger: Logger,
  ) {}

  async get(relativeUrl: string, opts: { maxBytes: number; timeoutMs?: number }): Promise<HttpPayload> {
    const url = relativeUrl.startsWith('http') ? relativeUrl : `${this.baseUrl}/${relativeUrl}`;
    this.logger.debug('protocol', `GET ${redactUrl(url)} (cap ${opts.maxBytes})`);

    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { ...this.getAuthHeaders(), 'User-Agent': 'BCMCPServer/2.0' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });

    // redirect:manual surfaces a 3xx (or an opaqueredirect status 0) rather than following it.
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Download refused a redirect (HTTP ${res.status} -> ${res.headers.get('location') ?? '?'}) for ${redactUrl(url)}`);
    }
    if (res.status === 0) {
      throw new Error(`Download hit an opaque redirect for ${redactUrl(url)}`);
    }
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} from ${redactUrl(url)}`);
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const fileName = fileNameFromResponse(res.headers.get('content-disposition') ?? '', relativeUrl);
    const bytes = await this.readCapped(res, opts.maxBytes);
    return { bytes, contentType, fileName };
  }

  /** Stream the body, aborting as soon as the running total exceeds maxBytes. */
  private async readCapped(res: Response, maxBytes: number): Promise<Buffer> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('TOO_LARGE');
      }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bc-http.test.ts`
Expected: PASS (4 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/connection/bc-http.ts tests/unit/bc-http.test.ts
git commit -m "feat(connection): BCHttpClient streaming GET with size abort"
```

---

### Task 4: download-collector — pure security classification

**Files:**
- Create: `src/protocol/download-collector.ts`
- Create: `tests/unit/download-collector.test.ts`
- Reference: `src/protocol/types.ts:182-189` (`FileDownloadReadyEvent`)

**Interfaces:**
- Consumes: `BCEvent` (`src/protocol/types.ts`)
- Produces:
  ```typescript
  export interface DownloadRef { relativeUrl: string; style: string; suggestedFileName?: string; }
  export interface ExternalUri { uri: string; style: string; }
  export function collectDownloads(events: readonly BCEvent[], origin: { baseUrl: string }): { refs: DownloadRef[]; external: ExternalUri[] };
  export const STYLE_NAMES: readonly string[]; // index = ordinal
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/download-collector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { collectDownloads } from '../../src/protocol/download-collector.js';
import type { BCEvent } from '../../src/protocol/types.js';

const BASE = 'http://cronus28/BC';
const dl = (relativeUrl: string, style = '1'): BCEvent => ({ type: 'FileDownloadReady', formId: '', relativeUrl, style } as BCEvent);

describe('collectDownloads', () => {
  it('returns empty for events with no FileDownloadReady', () => {
    const r = collectDownloads([{ type: 'InvokeCompleted' } as BCEvent], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toEqual([]);
  });

  it('classifies a relative DynamicFileHandler.axd URL as a fetchable ref', () => {
    const r = collectDownloads([dl('DynamicFileHandler.axd?form=41D&fname=a.pdf')], { baseUrl: BASE });
    expect(r.refs).toHaveLength(1);
    expect(r.refs[0]).toMatchObject({ relativeUrl: 'DynamicFileHandler.axd?form=41D&fname=a.pdf', style: 'download', suggestedFileName: 'a.pdf' });
    expect(r.external).toEqual([]);
  });

  it('maps style ordinals 0..5 to names, and out-of-range to unknown:<n>', () => {
    const styles = ['0', '1', '2', '3', '4', '5', '9'].map(s => collectDownloads([dl('DynamicFileHandler.axd', s)], { baseUrl: BASE }));
    // ordinals 0..4 are same-origin file styles -> refs; 5 (mailto) has a file path here so still a ref by origin, name still 'mailto'
    expect(styles[0].refs[0].style).toBe('view');
    expect(styles[1].refs[0].style).toBe('download');
    expect(styles[2].refs[0].style).toBe('print');
    expect(styles[3].refs[0].style).toBe('preview');
    expect(styles[4].refs[0].style).toBe('previewWithoutDownload');
    expect(styles[5].refs[0].style).toBe('mailto');
    expect(styles[6].refs[0].style).toBe('unknown:9');
  });

  it('routes an off-origin absolute URL to external, never a ref', () => {
    const r = collectDownloads([dl('http://evil.example.com/x.pdf')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toEqual([{ uri: 'http://evil.example.com/x.pdf', style: 'download' }]);
  });

  it('routes a mailto: URI to external', () => {
    const r = collectDownloads([dl('mailto:a@b.com', '5')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external[0]).toMatchObject({ uri: 'mailto:a@b.com' });
  });

  it('routes a same-origin URL on a NON-allowlisted path to external', () => {
    const r = collectDownloads([dl('http://cronus28/BC/SignIn?x=1')], { baseUrl: BASE });
    expect(r.refs).toEqual([]);
    expect(r.external).toHaveLength(1);
  });

  it('preserves order across multiple FileDownloadReady events', () => {
    const r = collectDownloads([dl('DynamicFileHandler.axd?fname=1.pdf'), dl('DynamicFileHandler.axd?fname=2.pdf')], { baseUrl: BASE });
    expect(r.refs.map(x => x.suggestedFileName)).toEqual(['1.pdf', '2.pdf']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/download-collector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/protocol/download-collector.ts`:

```typescript
import type { BCEvent } from './types.js';
import { fileNameFromResponse } from '../connection/http-filename.js';

export interface DownloadRef { relativeUrl: string; style: string; suggestedFileName?: string; }
export interface ExternalUri { uri: string; style: string; }

// Index = UriToShowStyle ordinal (decompiled UriToShowStyle.cs).
export const STYLE_NAMES = ['view', 'download', 'print', 'preview', 'previewWithoutDownload', 'mailto'] as const;

// Paths under the BC origin that legitimately serve files.
const ALLOWED_PATH_RE = /(^|\/)(DynamicFileHandler\.axd|client\/uploadDownload\/download)(\/|$|\?)/i;

function styleName(raw: string): string {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < STYLE_NAMES.length ? STYLE_NAMES[n]! : `unknown:${raw}`;
}

/** Same scheme+host+port as baseUrl AND an allowlisted file path. */
function isFetchable(relativeUrl: string, baseUrl: string): boolean {
  let resolved: URL;
  try {
    resolved = new URL(relativeUrl, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  } catch {
    return false; // e.g. mailto: with no host, or a malformed URI
  }
  const base = new URL(baseUrl);
  if (resolved.origin !== base.origin) return false;
  return ALLOWED_PATH_RE.test(resolved.pathname);
}

export function collectDownloads(
  events: readonly BCEvent[],
  origin: { baseUrl: string },
): { refs: DownloadRef[]; external: ExternalUri[] } {
  const refs: DownloadRef[] = [];
  const external: ExternalUri[] = [];
  for (const e of events) {
    if (e.type !== 'FileDownloadReady') continue;
    const style = styleName(e.style);
    if (isFetchable(e.relativeUrl, origin.baseUrl)) {
      refs.push({ relativeUrl: e.relativeUrl, style, suggestedFileName: fileNameFromResponse('', e.relativeUrl) });
    } else {
      external.push({ uri: e.relativeUrl, style });
    }
  }
  return { refs, external };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/download-collector.test.ts`
Expected: PASS (7 tests). Then `npx tsc --noEmit` → clean.

Note: the mailto test uses style `'5'` with `mailto:a@b.com` — `new URL('mailto:a@b.com', base)` yields origin `null` ≠ base origin, so it lands in `external`. The style-name test at ordinal 5 uses a `DynamicFileHandler.axd` path (same origin, allowlisted) so it stays a ref while still named `mailto` — this deliberately checks name mapping independent of routing.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/download-collector.ts tests/unit/download-collector.test.ts
git commit -m "feat(protocol): download-collector with same-origin SSRF guard"
```

---

### Task 5: DownloadService — capture, cap, disk, per-entry errors

**Files:**
- Create: `src/services/download-service.ts`
- Create: `tests/unit/download-service.test.ts`

**Interfaces:**
- Consumes: `collectDownloads` (Task 4), `BCHttpClient` (Task 3), `BCConfig['downloadLimits']` (Task 1)
- Produces:
  ```typescript
  export interface Download {
    fileName: string; contentType: string; sizeBytes: number; style: string;
    bytes?: string;               // base64; omitted when error set or written to disk-only
    savedPath?: string;
    error?: { code: 'TOO_LARGE' | 'FETCH_FAILED'; message: string };
  }
  export interface CaptureResult { downloads: Download[]; externalUris: Array<{ uri: string; style: string }>; }
  export class DownloadService {
    constructor(http: BCHttpClient, limits: BCConfig['downloadLimits'], logger: Logger);
    capture(events: readonly BCEvent[], opts?: { timeoutMs?: number }): Promise<CaptureResult>;
  }
  ```
- Note: `capture` needs the base URL for the collector — take it in the constructor too (`baseUrl: string`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/download-service.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DownloadService } from '../../src/services/download-service.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const BASE = 'http://cronus28/BC';
const LIMITS = { maxBytes: 1000, maxTotalBytes: 1500, maxDownloads: 3, dir: undefined };
const dl = (fname: string, style = '1'): BCEvent => ({ type: 'FileDownloadReady', formId: '', relativeUrl: `DynamicFileHandler.axd?fname=${fname}`, style } as BCEvent);

function fakeHttp(impl: (url: string) => Promise<{ bytes: Buffer; contentType: string; fileName?: string }>) {
  return { get: vi.fn((relativeUrl: string) => impl(relativeUrl)) } as never;
}

describe('DownloadService.capture', () => {
  it('returns empty arrays when no downloads and no externals', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('unused'); }), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'InvokeCompleted' } as BCEvent]);
    expect(r).toEqual({ downloads: [], externalUris: [] });
  });

  it('fetches a ref and returns base64 bytes', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'a.pdf' })), BASE, LIMITS, logger);
    const r = await svc.capture([dl('a.pdf')]);
    expect(r.downloads[0]).toMatchObject({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4, style: 'download' });
    expect(Buffer.from(r.downloads[0]!.bytes!, 'base64').toString()).toBe('%PDF');
  });

  it('maps a TOO_LARGE fetch to a per-entry error, not a whole failure', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('TOO_LARGE'); }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('big.xlsx')]);
    expect(r.downloads[0]!.error?.code).toBe('TOO_LARGE');
    expect(r.downloads[0]!.bytes).toBeUndefined();
  });

  it('maps a generic fetch failure to FETCH_FAILED per entry', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('HTTP 404 Not Found'); }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('gone.pdf')]);
    expect(r.downloads[0]!.error?.code).toBe('FETCH_FAILED');
    expect(r.downloads[0]!.error?.message).toContain('404');
  });

  it('one failing entry does not remove the others, order preserved', async () => {
    const svc = new DownloadService(fakeHttp(async (u) => {
      if (u.includes('bad')) throw new Error('HTTP 500');
      return { bytes: Buffer.from('ok'), contentType: 'x', fileName: undefined };
    }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('good1.pdf'), dl('bad.pdf'), dl('good2.pdf')]);
    expect(r.downloads.map(d => d.error?.code ?? 'ok')).toEqual(['ok', 'FETCH_FAILED', 'ok']);
  });

  it('assigns a fallback filename when none is available', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('x'), contentType: 'application/pdf', fileName: undefined })), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'FileDownloadReady', formId: '', relativeUrl: 'DynamicFileHandler.axd?form=41D', style: '1' } as BCEvent]);
    expect(r.downloads[0]!.fileName).toBe('download-0.pdf');
  });

  it('enforces the count cap and reports the drop', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('x'), contentType: 'x', fileName: undefined })), BASE, { ...LIMITS, maxDownloads: 2 }, logger);
    const r = await svc.capture([dl('1'), dl('2'), dl('3')]);
    expect(r.downloads).toHaveLength(3);
    expect(r.downloads[2]!.error?.code).toBe('TOO_LARGE'); // dropped-by-count reuses TOO_LARGE with an explanatory message
    expect(r.downloads[2]!.error?.message).toMatch(/count|maximum/i);
  });

  it('surfaces external URIs untouched', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('unused'); }), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'FileDownloadReady', formId: '', relativeUrl: 'http://evil.com/x', style: '1' } as BCEvent]);
    expect(r.downloads).toEqual([]);
    expect(r.externalUris).toEqual([{ uri: 'http://evil.com/x', style: 'download' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/download-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/services/download-service.ts`:

```typescript
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { BCConfig } from '../core/config.js';
import type { BCEvent } from '../protocol/types.js';
import type { BCHttpClient } from '../connection/bc-http.js';
import { collectDownloads, type ExternalUri } from '../protocol/download-collector.js';

export interface Download {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  style: string;
  bytes?: string;
  savedPath?: string;
  error?: { code: 'TOO_LARGE' | 'FETCH_FAILED'; message: string };
}
export interface CaptureResult { downloads: Download[]; externalUris: ExternalUri[]; }

const EXT_BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export class DownloadService {
  constructor(
    private readonly http: BCHttpClient,
    private readonly baseUrl: string,
    private readonly limits: BCConfig['downloadLimits'],
    private readonly logger: Logger,
  ) {}

  async capture(events: readonly BCEvent[], opts?: { timeoutMs?: number }): Promise<CaptureResult> {
    const { refs, external } = collectDownloads(events, { baseUrl: this.baseUrl });
    const downloads: Download[] = [];
    let totalBytes = 0;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      if (i >= this.limits.maxDownloads) {
        downloads.push({ fileName: ref.suggestedFileName ?? `download-${i}`, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
          error: { code: 'TOO_LARGE', message: `Dropped: exceeds the maximum of ${this.limits.maxDownloads} downloads per operation.` } });
        continue;
      }
      try {
        const payload = await this.http.get(ref.relativeUrl, { maxBytes: this.limits.maxBytes, timeoutMs: opts?.timeoutMs });
        const fileName = payload.fileName ?? ref.suggestedFileName ?? `download-${i}${EXT_BY_TYPE[payload.contentType] ?? '.bin'}`;
        totalBytes += payload.bytes.byteLength;
        if (totalBytes > this.limits.maxTotalBytes) {
          downloads.push({ fileName, contentType: payload.contentType, sizeBytes: payload.bytes.byteLength, style: ref.style,
            error: { code: 'TOO_LARGE', message: `Dropped: operation exceeded the aggregate cap of ${this.limits.maxTotalBytes} bytes.` } });
          continue;
        }
        downloads.push(this.finish({ fileName, contentType: payload.contentType, sizeBytes: payload.bytes.byteLength, style: ref.style }, payload.bytes));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const fileName = ref.suggestedFileName ?? `download-${i}`;
        if (msg === 'TOO_LARGE') {
          downloads.push({ fileName, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
            error: { code: 'TOO_LARGE', message: `Download exceeded the per-file cap of ${this.limits.maxBytes} bytes. The action committed server-side; retrieve the file via the UI or raise BC_MAX_DOWNLOAD_BYTES.` } });
        } else {
          downloads.push({ fileName, contentType: 'application/octet-stream', sizeBytes: 0, style: ref.style,
            error: { code: 'FETCH_FAILED', message: `The action committed server-side but the file could not be fetched: ${msg}` } });
        }
      }
    }
    return { downloads, externalUris: external };
  }

  /** Encode inline and/or write to disk per BC_DOWNLOAD_DIR. */
  private finish(base: Omit<Download, 'bytes' | 'savedPath' | 'error'>, bytes: Buffer): Download {
    const d: Download = { ...base };
    if (this.limits.dir) {
      try {
        if (!existsSync(this.limits.dir)) mkdirSync(this.limits.dir, { recursive: true });
        const name = extname(base.fileName) ? base.fileName : `${base.fileName}.bin`;
        d.savedPath = join(this.limits.dir, name);
        writeFileSync(d.savedPath, bytes);
      } catch (e) {
        this.logger.warn(`download disk write failed: ${e instanceof Error ? e.message : String(e)}`);
        d.savedPath = undefined;
      }
    }
    d.bytes = bytes.toString('base64');
    return d;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/download-service.test.ts`
Expected: PASS (8 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/download-service.ts tests/unit/download-service.test.ts
git commit -m "feat(services): DownloadService capture with caps, disk and per-entry errors"
```

---

### Task 6: Rewire — BCHttpClient in the factory, report path returns events, delete report-downloader

**Files:**
- Modify: `src/connection/connection-factory.ts:44-50` (`createReportDownloader` → `createHttpClient`)
- Modify: `src/session/bc-session.ts` (`runReportWithDownload` return type + body; drop `reportDownloader` ctor param and import)
- Modify: `src/session/session-factory.ts:24-35` (build the client; stop passing a downloader to BCSession)
- Delete: `src/session/report-downloader.ts`
- Delete: `tests/unit/report-downloader.test.ts`

**Interfaces:**
- Consumes: `BCHttpClient` (Task 3)
- Produces:
  - `ConnectionFactory.createHttpClient(): BCHttpClient`
  - `BCSession.runReportWithDownload(reportId, format, options?): Promise<Result<{ events: BCEvent[] }, ProtocolError>>` (bytes/contentType/fileName removed — the operation now fetches)

- [ ] **Step 1: Change the factory**

In `src/connection/connection-factory.ts`, replace the `createReportDownloader` method and its import:

```typescript
import { BCHttpClient } from './bc-http.js';   // replaces: import { ReportDownloader } ...

  createHttpClient(): BCHttpClient {
    return new BCHttpClient(
      this.bcConfig.baseUrl,
      () => this.authProvider.getWebSocketHeaders(),
      this.logger,
    );
  }
```

- [ ] **Step 2: Change BCSession**

In `src/session/bc-session.ts`: remove `import type { ReportDownloader }` (`:13`), remove the `reportDownloader` constructor parameter (`:41`) and every reference. Change `runReportWithDownload` to return events and drop the fetch:

- Signature → `Promise<Result<{ events: BCEvent[] }, ProtocolError>>`.
- Delete the `if (!this.reportDownloader)` guard (`:588`).
- Keep steps 1–4 (open request page, SendTo, select format, OK) unchanged.
- Replace step 5 (`:649-657`) with:

```typescript
    const dlReady = okResult.value.find(e => e.type === 'FileDownloadReady');
    if (!dlReady || dlReady.type !== 'FileDownloadReady') {
      return err(new ProtocolError('Report rendered but no download URL received (FileDownloadReady event missing)'));
    }
    return ok({ events: allEvents });
```

- [ ] **Step 3: Change SessionFactory**

In `src/session/session-factory.ts`, delete the `createReportDownloader()` line (`:24`) and the `reportDownloader` argument to `new BCSession(...)` (`:34`). The factory no longer needs the client; the composition root builds it separately (Task 7 wiring).

- [ ] **Step 4: Delete the old module and its test**

```bash
git rm src/session/report-downloader.ts tests/unit/report-downloader.test.ts
```

- [ ] **Step 5: Verify compile + full unit suite**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `src/operations/run-report.ts`, `src/server.ts`, `src/stdio-server.ts`, `tests/integration/report-capture.test.ts` (consumers fixed in Tasks 7-8). If errors appear elsewhere, a reference to `reportDownloader` was missed — fix it.

Run: `npx vitest run tests/unit`
Expected: PASS except any run-report-related unit tests (addressed next). `http-filename`, `bc-http`, `download-collector`, `download-service` all green.

- [ ] **Step 6: Commit**

```bash
git add -A src/connection/connection-factory.ts src/session/bc-session.ts src/session/session-factory.ts
git commit -m "refactor(session): report path returns events; BCHttpClient replaces ReportDownloader"
```

---

### Task 7: run-report — downloads[] via DownloadService; migrate tests

**Files:**
- Modify: `src/operations/run-report.ts` (constructor + `executeWithDownload` + output type)
- Modify: `src/operations/run-report.tool.ts` (describe `downloads[]`)
- Modify: `tests/integration/report-capture.test.ts` (build DownloadService; assert `downloads[0]`)

**Interfaces:**
- Consumes: `DownloadService`, `Download` (Task 5); `BCSession.runReportWithDownload` returning `{ events }` (Task 6)
- Produces: `RunReportOutput.downloads: Download[]` (replaces `download?`)

- [ ] **Step 1: Change the operation**

In `src/operations/run-report.ts`:
- Add constructor param: `private readonly downloadService: DownloadService`. Import `Download`, `DownloadService` from `../services/download-service.js`.
- Remove the `fs`/`path` imports and the disk-write block (now in DownloadService).
- Replace the `download?` field in `RunReportOutput` with `downloads: Download[]`.
- Rewrite `executeWithDownload`:

```typescript
  private async executeWithDownload(
    reportId: number,
    format: 'pdf' | 'excel' | 'word',
  ): Promise<Result<RunReportOutput, ProtocolError>> {
    const result = await this.session.runReportWithDownload(reportId, format);
    if (isErr(result)) return result;
    const captured = await this.downloadService.capture(result.value.events, { timeoutMs: 120_000 });
    return ok({
      success: true,
      reportId,
      dialogsOpened: [],
      requiresDialogResponse: false,
      downloads: captured.downloads,
    });
  }
```

- In the non-download `execute` path, add `downloads: []` to the returned object so the field is always present.

- [ ] **Step 2: Update the tool description**

In `src/operations/run-report.tool.ts`, add a sentence to the description: "When `format` is set, rendered file bytes are returned in `downloads[]` (base64 in `bytes`, or `savedPath` when `BC_DOWNLOAD_DIR` is set); an oversized file reports a per-entry `error` instead of bytes."

- [ ] **Step 3: Migrate the integration test**

In `tests/integration/report-capture.test.ts`:
- Import `BCHttpClient`, `DownloadService`, and `loadConfig`.
- Replace each `new RunReportOperation(session)` with a helper that also builds the service:

```typescript
import { BCHttpClient } from '../../src/connection/bc-http.js';
import { DownloadService } from '../../src/services/download-service.js';
import { loadConfig } from '../../src/core/config.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';

function buildOp(session: BCSession) {
  const cfg = loadConfig();
  const http = new BCHttpClient(cfg.bc.baseUrl, () => (session as any).ws.getAuthHeaders?.() ?? {}, (session as any).logger ?? console as any);
  const svc = new DownloadService(http, cfg.bc.baseUrl, cfg.bc.downloadLimits, (session as any).logger ?? console as any);
  return new RunReportOperation(session, new PageContextRepository(), svc);
}
```

- Note: the pool session exposes auth headers via its connection. If `session.ws.getAuthHeaders` is not reachable, build the `BCHttpClient` from a fresh `NTLMAuthProvider` the same way `scripts/gate-a-isexecuting.ts` does, and note it in the test. Confirm the exact accessor during implementation — this is the one place the plan cannot fully pin without running it.
- Replace assertions: `result.value.download!.bytes` → `result.value.downloads[0]!.bytes`; add `expect(result.value.downloads).toHaveLength(1)` and `expect(result.value.downloads[0]!.error).toBeUndefined()`.

- [ ] **Step 4: Run type-check + the migrated unit tests**

Run: `npx tsc --noEmit`
Expected: errors now only in `src/server.ts` and `src/stdio-server.ts` (Task 8 wiring) and the three other operations (Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/operations/run-report.ts src/operations/run-report.tool.ts tests/integration/report-capture.test.ts
git commit -m "feat(run-report): downloads[] via DownloadService, disk output preserved"
```

---

### Task 8: execute-action, respond-dialog, wizard — downloads[] + externalUris[], and composition

**Files:**
- Modify: `src/operations/execute-action.ts` (output + capture)
- Modify: `src/operations/respond-dialog.ts` (output + capture)
- Modify: `src/operations/wizard-navigate.ts` (output + capture)
- Modify: `src/operations/execute-action.tool.ts`, `respond-dialog.tool.ts`, `wizard-navigate.tool.ts` (describe new fields)
- Modify: `src/server.ts:70-105`, `src/stdio-server.ts:73-100` (build DownloadService once, inject into the four operations)

**Interfaces:**
- Consumes: `DownloadService`, `CaptureResult` (Task 5)
- Produces: each of `ExecuteActionOutput`, `RespondDialogOutput`, `WizardNavigateOutput` gains `downloads: Download[]` and `externalUris: Array<{ uri: string; style: string }>`

- [ ] **Step 1: Write the failing wiring test (execute-action)**

Create `tests/unit/execute-action-downloads.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';

describe('ExecuteActionOperation downloads', () => {
  it('captures downloads from the action events and returns them', async () => {
    const events = [{ type: 'FileDownloadReady', formId: '', relativeUrl: 'DynamicFileHandler.axd?fname=x.xlsx', style: '1' }];
    const actionService = { executeAction: vi.fn(async () => ({ ok: true, value: { success: true, events } })) } as never;
    const repo = { get: vi.fn(() => ({ rootFormId: 'f', generation: 1 })), getByFormId: vi.fn(() => undefined) } as never;
    const nav = {} as never;
    const captured = { downloads: [{ fileName: 'x.xlsx', contentType: 'app/xlsx', sizeBytes: 4, style: 'download', bytes: 'AAAA' }], externalUris: [] };
    const downloadService = { capture: vi.fn(async () => captured) } as never;

    const op = new ExecuteActionOperation(actionService, repo, nav, downloadService);
    const result = await op.execute({ pageContextId: 'p', action: 'SendToExcel' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.downloads).toEqual(captured.downloads);
      expect(downloadService.capture).toHaveBeenCalled();
    }
  });
});
```

Adjust the `actionService.executeAction` mock's return to match the real `Result` shape (`{ ok: true, value: ActionResult }` — check `src/core/result.ts` for the exact discriminant; it is `isOk`-based, so the object is `{ ok: true, value }`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/execute-action-downloads.test.ts`
Expected: FAIL — constructor takes 3 args, `downloads` undefined.

- [ ] **Step 3: Implement the three operations**

For each operation, follow the same pattern (shown for execute-action; repeat for respond-dialog and wizard, capturing from their respective event arrays — `ar.events` in execute-action and wizard, `events`/`closeResult.value` in respond-dialog):

`execute-action.ts`:
- Add ctor param `private readonly downloadService: DownloadService` (import from `../services/download-service.js`), plus `Download` import.
- Add to `ExecuteActionOutput`: `downloads: Download[];` and `externalUris: Array<{ uri: string; style: string }>;`.
- In `buildOutput`, it currently has `ar.events`. Make `buildOutput` async or capture in `execute` before returning. Simplest: after `ok(this.buildOutput(...))` compute capture. Change the two `return ok(this.buildOutput(pageContextId, result.value))` sites to:

```typescript
      const out = this.buildOutput(pageContextId, result.value);
      const captured = await this.downloadService.capture(result.value.events);
      return ok({ ...out, downloads: captured.downloads, externalUris: captured.externalUris });
```

  and give `buildOutput`'s return type `Omit<ExecuteActionOutput, 'downloads' | 'externalUris'>`.

`respond-dialog.ts`: in each of the two `return ok({...})` sites, capture from the events in scope (`closeResult.value` in the close branch, `events` in the main branch) and spread `downloads` / `externalUris`.

`wizard-navigate.ts`: `mapResult` builds the object from `ar`. Change `execute` to await capture on `ar.events` and merge. Because `mapResult` is synchronous, restructure: after the `mapResult`, if `isOk`, run `await this.downloadService.capture(ar.events)` and attach. Simplest is to compute capture before building the mapped object; refactor the `mapResult` call into an explicit `if (isOk(result))` block that awaits capture. Add the two fields to `WizardNavigateOutput`.

- [ ] **Step 4: Update the three tool descriptions**

Add to each of `execute-action.tool.ts`, `respond-dialog.tool.ts`, `wizard-navigate.tool.ts`: "If the action produces a file (Open in Excel, Print, export), its bytes appear in `downloads[]`; links BC would open externally appear in `externalUris[]` and are never fetched by the server."

- [ ] **Step 5: Wire composition (both roots)**

In `src/server.ts` `buildServices` (after `const actionService = ...`):

```typescript
    const httpClient = connectionFactory.createHttpClient();
    const downloadService = new DownloadService(httpClient, config.bc.baseUrl, config.bc.downloadLimits, logger);
```

Pass `downloadService` as the new last arg to `RunReportOperation`, `ExecuteActionOperation`, `RespondDialogOperation`, `WizardNavigateOperation`. Add the imports for `DownloadService`. `connectionFactory` is in scope in `server.ts`; confirm it is reachable inside `buildServices` (it is a module-level const there).

Apply the identical change in `src/stdio-server.ts` `buildServices`. Note `stdio-server` builds a `staticTools = buildServices({} as BCSession)` for metadata extraction — the `DownloadService` construction must tolerate a dummy session; since it only needs `connectionFactory` (not the session), this is fine, but confirm `createHttpClient` does not touch the session.

- [ ] **Step 6: Run the full type-check and unit suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: all unit + protocol tests PASS. The new `execute-action-downloads` test passes.

- [ ] **Step 7: Commit**

```bash
git add src/operations src/server.ts src/stdio-server.ts tests/unit/execute-action-downloads.test.ts
git commit -m "feat(operations): downloads[]/externalUris[] on action, dialog, wizard; wire DownloadService"
```

---

### Task 9: Integration verification against Cronus281

**Files:**
- Modify: `tests/integration/report-capture.test.ts` (already migrated; confirm green)
- Create: `tests/integration/download-capture.test.ts`

**Interfaces:**
- Consumes: everything above. Uses `integrationPool` (`tests/integration/helpers/session-pool.ts`).

- [ ] **Step 1: Write the integration tests**

Create `tests/integration/download-capture.test.ts` following the `report-capture.test.ts` structure (pool checkout in `beforeAll`, checkin in `afterAll`). Build the operations with a real `DownloadService` (same helper as Task 7). Tests:

```typescript
// 1. Customer List (page 22) -> "Open in Excel" / "Send to Excel" -> one download, PK magic bytes.
//    Open page 22, find the export action name via bc_read_data's actions, execute it, assert:
//      expect(out.downloads).toHaveLength(1);
//      const b = Buffer.from(out.downloads[0].bytes, 'base64');
//      expect(b.subarray(0, 2).toString('latin1')).toBe('PK');
//      expect(out.downloads[0].error).toBeUndefined();
// 2. An action with no file (Refresh) -> downloads: [] and externalUris: [].
// 3. Report 6 PDF via run-report (already covered by report-capture.test.ts) -> downloads[0], %PDF.
```

Pin the exact Excel action caption during implementation by first reading page 22's actions live — the ribbon may expose "Open in Excel" (add-in, NOT UriToShow) vs "Send to Excel" (UriToShow). Use the one that emits a download; if only the add-in variant exists on this build, document it and fall back to a page whose "Send to Excel" is present, noting the substitution in the test.

- [ ] **Step 2: Run the integration suite**

Run: `BC_BASE_URL=http://cronus281/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx vitest run --config vitest.integration.config.ts tests/integration/download-capture.test.ts tests/integration/report-capture.test.ts`
Expected: PASS. (Cronus28 is BC 28.3 and had a `/csh` 403 on 2026-07-24; use Cronus281 = BC 28.0. If Cronus28 has recovered, either works.)

If the port/host env differs, mirror the `.env` values; the default `.env` points at Cronus28.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/download-capture.test.ts
git commit -m "test(integration): download capture on list export, report, and no-download paths"
```

---

### Task 10: Docs — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` ("Report Output Capture" section)

- [ ] **Step 1: Rewrite the section**

Rename "Report Output Capture — IMPLEMENTED" to "File Download Capture — IMPLEMENTED" and add: downloads are captured generically on `bc_execute_action`, `bc_respond_dialog`, `bc_wizard_navigate`, and `bc_run_report` via `DownloadService`, which uses the same-origin `collectDownloads` guard and the streaming `BCHttpClient`. Only same-origin `DynamicFileHandler.axd` / `uploadDownload/download` URLs are fetched; external and `mailto` URIs return in `externalUris[]` and are never dereferenced. Per-file cap `BC_MAX_DOWNLOAD_BYTES` (5 MB), aggregate `BC_MAX_DOWNLOAD_TOTAL_BYTES` (10 MB), count `BC_MAX_DOWNLOADS` (5); `BC_DOWNLOAD_DIR` (falls back to `BC_REPORT_DIR`) writes bytes to disk and sets `savedPath`. An oversized or failed fetch is a per-entry `error`, never a whole-operation failure. `UriToShowStyle` ordinals: `View=0, Download=1, Print=2, Preview=3, PreviewWithoutDownload=4, Mailto=5`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: File Download Capture section for the generic path"
```

---

## Self-Review

**Spec coverage** (against `2026-07-24-download-capture-design.md`):
- Security model (same-origin, allowlist, no-redirect, external split, mailto) → Task 4 + Task 3. ✓
- `DownloadCollector` pure → Task 4. ✓
- `BCHttpClient` transport with streaming abort → Task 3. ✓
- `http-filename` extraction + ported tests → Task 2. ✓
- `DownloadService.capture(events)` boundary → Task 5. ✓
- Output DTO `downloads[]` + `externalUris[]` on all four tools → Tasks 7-8. ✓
- Per-entry error, not whole-operation failure → Task 5 tests + Task 8. ✓
- Size caps (per-file, aggregate, count) → Task 1 + Task 5. ✓
- `savedPath` / `BC_DOWNLOAD_DIR` preserved (not dropped) → Task 5 + Task 7. ✓
- Business-error-before-capture ordering → execute/wizard already classify business errors before `buildOutput`; capture runs on the same events after, no network before classification (Task 8 keeps the existing `classifyBusinessError` call ahead of capture). ✓
- One code path `FileDownloadReady` → bytes (report path routed through the service) → Task 6-7. ✓
- Gate 1 (style enum) → closed in spec; ordinals in Global Constraints + Task 4. ✓
- `postMultipart` NOT declared → honored (Global Constraints). ✓
- Files-touched incl. `schemas.ts`? — download capture adds no tool *inputs*, only outputs, so `src/mcp/schemas.ts` is untouched; the `.tool.ts` description edits suffice. ✓
- Nested-hydration limitation documented → carried in the spec; no task needed (out of scope). ✓

**Placeholder scan:** One acknowledged live-confirmation point — the auth-header accessor for the integration `DownloadService` (Task 7 Step 3) and the exact Excel action caption (Task 9). Both are genuinely undecidable without a live session and are flagged inline with a concrete fallback, not left as "TODO".

**Type consistency:** `Download` / `CaptureResult` defined in Task 5 are consumed unchanged in Tasks 7-8. `BCHttpClient.get(relativeUrl, {maxBytes, timeoutMs})` (Task 3) matches the call in Task 5. `collectDownloads(events, {baseUrl})` (Task 4) matches the call in Task 5. `runReportWithDownload` return `{events}` (Task 6) matches the consumer in Task 7. `DownloadService` constructor arity `(http, baseUrl, limits, logger)` is consistent across Task 5 definition and Tasks 7-8 construction.

---

## Execution notes

- Tasks 1–5 are pure/leaf and have zero live dependencies — safe to implement and green entirely offline.
- Task 6 is the breaking rewire; after it, only the four named consumers should fail to compile. That is the checkpoint.
- Tasks 9 needs Cronus281 (BC 28.0); Cronus28 (BC 28.3) had a `/csh` 403 as of 2026-07-24.
