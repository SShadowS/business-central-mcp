import type { Logger } from '../core/logger.js';

export class ReportDownloader {
  constructor(
    private readonly baseUrl: string,
    private readonly getAuthHeaders: () => Record<string, string>,
    private readonly logger: Logger,
  ) {}

  async download(): Promise<{ bytes: Buffer; contentType: string }> {
    const url = `${this.baseUrl}/client/uploadDownload/download`;
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
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    this.logger.debug('protocol', `Report downloaded: ${bytes.length} bytes, content-type: ${contentType}`);
    return { bytes, contentType };
  }
}
