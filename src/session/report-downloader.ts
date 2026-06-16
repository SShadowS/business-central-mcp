import type { Logger } from '../core/logger.js';

export class ReportDownloader {
  constructor(
    readonly baseUrl: string,
    private readonly getAuthHeaders: () => Record<string, string>,
    private readonly logger: Logger,
  ) {}

  /**
   * Download a report file from `relativeUrl` (e.g. the value from a
   * `FileDownloadReady` event). The URL is joined with `baseUrl` when it does
   * not start with `http`.
   *
   * Authenticated with the same NTLM headers used for the WebSocket connection.
   * The BC web server issues the file from `DynamicFileHandler.axd` using the
   * session's HandlerSessionId embedded in the query string — no separate auth
   * token is needed beyond the NTLM cookie/header already in `getAuthHeaders()`.
   *
   * Reference: FileUrlAddressProvider.cs (decompiled
   *   Microsoft.Dynamics.Framework.UI.Web). Verified from live BC28 wire capture
   *   (2026-06-15): Trial Balance PDF, DynamicFileHandler.axd.
   */
  async downloadFromUrl(relativeUrl: string): Promise<{ bytes: Buffer; contentType: string; fileName?: string }> {
    const url = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${this.baseUrl}/${relativeUrl}`;

    this.logger.debug('protocol', `Downloading report from ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...this.getAuthHeaders(),
        'User-Agent': 'BCMCPServer/2.0',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Report download failed: HTTP ${response.status} ${response.statusText} from ${url}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const disposition = response.headers.get('content-disposition') ?? '';
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const fileName = fnMatch ? decodeURIComponent(fnMatch[1]!.trim()) : extractFileNameFromUrl(relativeUrl);

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    this.logger.debug('protocol', `Report downloaded: ${bytes.length} bytes, content-type: ${contentType}${fileName ? `, fileName: ${fileName}` : ''}`);
    return { bytes, contentType, fileName };
  }
}

function extractFileNameFromUrl(relativeUrl: string): string | undefined {
  try {
    // URLSearchParams.get() already percent-decodes the value, so do NOT
    // decodeURIComponent again — a second decode mangles names containing a
    // literal `%` (e.g. an fname `100%25 Done.pdf` would wrongly become
    // `100% Done.pdf` -> `100`-truncation on malformed sequences).
    const params = new URLSearchParams(relativeUrl.includes('?') ? relativeUrl.split('?')[1] : '');
    const fname = params.get('fname');
    return fname ?? undefined;
  } catch {
    return undefined;
  }
}
