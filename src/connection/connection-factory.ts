import { ok, err, isErr, type Result } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import { BCWebSocket } from './bc-websocket.js';
import { ReportDownloader } from '../session/report-downloader.js';
import type { IBCAuthProvider } from './auth/auth-provider.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

export class ConnectionFactory {
  constructor(
    private readonly authProvider: IBCAuthProvider,
    private readonly bcConfig: BCConfig,
    private readonly logger: Logger,
  ) {}

  async create(): Promise<Result<BCWebSocket, ConnectionError>> {
    if (!this.authProvider.isAuthenticated()) {
      const authResult = await this.authProvider.authenticate();
      if (isErr(authResult)) {
        return err(new ConnectionError(`Authentication failed: ${authResult.error.message}`));
      }
    }

    const wsUrl = this.buildWebSocketUrl();
    const headers = this.authProvider.getWebSocketHeaders();

    const ws = new BCWebSocket(this.logger);
    const connectResult = await ws.connect({
      url: wsUrl,
      headers,
      timeoutMs: this.bcConfig.timeoutMs,
    });

    if (isErr(connectResult)) {
      // Cached auth cookies may be stale (BC restart / cookie expiry). Drop them
      // so the next create() re-authenticates instead of reusing dead cookies on
      // every backoff retry, which would otherwise brick recovery permanently.
      this.authProvider.invalidate();
      return connectResult;
    }
    return ok(ws);
  }

  createReportDownloader(): ReportDownloader {
    return new ReportDownloader(
      this.bcConfig.baseUrl,
      () => this.authProvider.getWebSocketHeaders(),
      this.logger,
    );
  }

  private buildWebSocketUrl(): string {
    const base = this.bcConfig.baseUrl.replace(/^http/, 'ws');
    const queryParams = this.authProvider.getWebSocketQueryParams();
    queryParams['ackseqnb'] = '-1';

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    return `${base}/csh?${queryString}`;
  }
}
