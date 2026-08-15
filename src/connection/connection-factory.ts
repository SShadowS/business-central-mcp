import { ok, isErr, type Result } from '../core/result.js';
import { BCWebSocket } from './bc-websocket.js';
import { BCHttpClient } from './bc-http.js';
import type { AuthFailure, IBCAuthProvider } from './auth/auth-provider.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

export class ConnectionFactory {
  constructor(
    private readonly authProvider: IBCAuthProvider,
    private readonly bcConfig: BCConfig,
    private readonly logger: Logger,
  ) {}

  async create(): Promise<Result<BCWebSocket, AuthFailure>> {
    if (!this.authProvider.isAuthenticated()) {
      const authResult = await this.authProvider.authenticate();
      if (isErr(authResult)) return authResult;
    }

    if (this.authProvider.prepareConnection) {
      const prepared = await this.authProvider.prepareConnection();
      if (isErr(prepared)) return prepared;
    }

    const wsUrl = this.buildWebSocketUrl();
    const headers = this.authProvider.getWebSocketHeaders();

    // BC 28.3's web server enforces WebSocket Origin validation
    // (RequestOriginValidationMiddleware in Prod.Client.WebCoreApp). A `/csh`
    // upgrade whose Origin header is missing/empty or cross-origin is rejected
    // with a bare 403 before the app handler. A same-origin upgrade is always
    // allowed, so send Origin = scheme+host+port of the base URL (no path).
    // SaaS providers override via getOrigin() — the cluster host must NOT be
    // used (verified: cluster Origin → HTTP 500).
    // Do NOT put Origin in getWebSocketHeaders() — BCHttpClient reuses those
    // headers for downloads.
    headers['Origin'] = this.authProvider.getOrigin?.() ?? new URL(this.bcConfig.baseUrl).origin;

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
      this.authProvider.getHttpBaseUrl?.() ?? this.bcConfig.baseUrl,
      () => this.authProvider.getWebSocketHeaders(),
      this.logger,
    );
  }

  private buildWebSocketUrl(): string {
    const queryParams = this.authProvider.getWebSocketQueryParams();
    queryParams['ackseqnb'] = '-1';

    const custom = this.authProvider.getWebSocketUrl?.();
    if (custom) {
      const u = new URL(custom);
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== '') u.searchParams.set(k, v);
      }
      return u.toString();
    }

    const base = this.bcConfig.baseUrl.replace(/^http/, 'ws');
    const queryString = Object.entries(queryParams)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    return `${base}/csh?${queryString}`;
  }
}
