import { ok, err, isErr, type Result } from '../core/result.js';
import { ConnectionError } from '../core/errors.js';
import { BCWebSocket } from './bc-websocket.js';
import { BCHttpClient } from './bc-http.js';
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

    // BC 28.3's web server enforces WebSocket Origin validation
    // (RequestOriginValidationMiddleware in Prod.Client.WebCoreApp). A `/csh`
    // upgrade whose Origin header is missing/empty or cross-origin is rejected
    // with a bare 403 before the app handler. A same-origin upgrade is always
    // allowed, so send Origin = scheme+host+port of the base URL (no path).
    // BC 28.0 did not enforce this; adding the header is a no-op there.
    // Verified: decompiled 28.3 RequestOriginValidationMiddleware.IsSameOrigin
    // + live cronus28 (403 without Origin -> 101 with it).
    headers['Origin'] = new URL(this.bcConfig.baseUrl).origin;

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

  createHttpClient(): BCHttpClient {
    return new BCHttpClient(
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
