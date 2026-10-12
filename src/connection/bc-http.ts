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

  /**
   * Multipart POST of a single file, for BC's web-client upload handler
   * (`DynamicFileUploadHandler.axd?form=<formId>&sessionid=<handlerSessionId>`).
   * Reuses the session auth headers (cookie). `redirect: 'manual'` so a 302 to
   * SignIn surfaces as an auth error rather than silently following to an HTML
   * login page. Field name `file` matches the web client; the controller reads
   * `Request.Form.Files[0]` regardless of name.
   */
  async postFile(
    relativeUrl: string,
    file: { bytes: Buffer; fileName: string; contentType: string },
    opts: { csrfToken?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: string }> {
    const url = relativeUrl.startsWith('http') ? relativeUrl : `${this.baseUrl}/${relativeUrl}`;
    this.logger.debug('protocol', `POST ${redactUrl(url)} (${file.bytes.byteLength} bytes)`);

    const form = new FormData();
    form.append('file', new File([new Uint8Array(file.bytes)], file.fileName, { type: file.contentType }), file.fileName);

    // The antiforgery token MUST ride in the X-CSRF-TOKEN header (ASP.NET
    // options.HeaderName). As a `csrftoken` query param alone BC returns HTTP 400
    // -- the query->header middleware does not cover the upload path. Get the
    // token from `fetchCsrfToken()` (POST /csrf).
    const headers: Record<string, string> = { ...this.getAuthHeaders(), 'User-Agent': 'BCMCPServer/2.0' };
    if (opts.csrfToken) headers['X-CSRF-TOKEN'] = opts.csrfToken;

    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Upload refused a redirect (HTTP ${res.status} -> ${res.headers.get('location') ?? '?'}) for ${redactUrl(url)} -- the session may be unauthenticated.`);
    }
    if (res.status === 0) {
      throw new Error(`Upload hit an opaque redirect for ${redactUrl(url)}`);
    }
    if (!res.ok) {
      throw new Error(`Upload failed: HTTP ${res.status} ${res.statusText} from ${redactUrl(url)}`);
    }
    const body = await res.text().catch(() => '');
    return { status: res.status, body };
  }

  /**
   * Fetch the web-client antiforgery request token from `POST /csrf`
   * (`[IgnoreAntiforgeryToken]`, `[Authorize]`). Returns the `csrfToken` JSON
   * field, which pairs with the antiforgery cookie already in the session jar.
   * Required to authorize the upload POST (see `postFile`).
   */
  async fetchCsrfToken(opts: { timeoutMs?: number } = {}): Promise<string> {
    const url = `${this.baseUrl}/csrf`;
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...this.getAuthHeaders(), 'User-Agent': 'BCMCPServer/2.0' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Failed to fetch antiforgery token: HTTP ${res.status} from ${this.baseUrl}/csrf`);
    const body = await res.text();
    let token: string | undefined;
    try { token = (JSON.parse(body) as { csrfToken?: string }).csrfToken; } catch { /* not json */ }
    if (!token) throw new Error('The /csrf endpoint did not return a csrfToken (antiforgery token).');
    return token;
  }

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
