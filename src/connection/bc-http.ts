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
