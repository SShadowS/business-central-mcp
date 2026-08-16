import { ok, isErr, type Result } from '../core/result.js';
import { BCWebSocket } from './bc-websocket.js';
import { BCHttpClient } from './bc-http.js';
import {
  isDeadClusterStatus,
  type AuthFailure,
  type ConnectionBinding,
  type IBCAuthProvider,
} from './auth/auth-provider.js';
import type { BCConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

export class ConnectionFactory {
  private binding: ConnectionBinding | undefined;

  constructor(
    private readonly authProvider: IBCAuthProvider,
    private readonly bcConfig: BCConfig,
    private readonly logger: Logger,
  ) {}

  /** OpenSession tenant from the last successful prepare(). */
  get sessionTenantId(): string | undefined {
    return this.binding?.sessionTenantId;
  }

  /**
   * HTTP base from the last successful prepare() (the tab base on SaaS,
   * config baseUrl otherwise). Downloads must be classified same-origin
   * against THIS base, not the portal URL — a portal base would classify
   * cluster DynamicFileHandler.axd URLs as external and never fetch them.
   */
  get httpBaseUrl(): string {
    return this.binding?.httpBaseUrl ?? this.bcConfig.baseUrl;
  }

  async create(): Promise<Result<BCWebSocket, AuthFailure>> {
    if (!this.authProvider.isAuthenticated()) {
      const authResult = await this.authProvider.authenticate();
      if (isErr(authResult)) return authResult;
    }

    const prepared = await this.authProvider.prepare();
    if (isErr(prepared)) return prepared;
    this.binding = prepared.value;

    const wsUrl = this.withQuery(this.binding.wsUrl);
    const headers = this.authProvider.getWebSocketHeaders();
    // Do NOT put Origin in getWebSocketHeaders() — BCHttpClient reuses those
    // headers for downloads. Origin is a WS-upgrade concern only.
    headers['Origin'] = this.binding.origin;

    const ws = new BCWebSocket(this.logger);
    const connectResult = await ws.connect({
      url: wsUrl,
      headers,
      timeoutMs: this.bcConfig.timeoutMs,
    });

    if (isErr(connectResult)) {
      this.authProvider.invalidate();
      if (isDeadClusterStatus(connectResult.error.status)) {
        this.authProvider.unboundCluster();
      }
      return connectResult;
    }
    return ok(ws);
  }

  createHttpClient(): BCHttpClient {
    return new BCHttpClient(
      this.httpBaseUrl,
      () => this.authProvider.getWebSocketHeaders(),
      this.logger,
    );
  }

  private withQuery(wsUrl: string): string {
    const queryParams = this.authProvider.getWebSocketQueryParams();
    queryParams['ackseqnb'] = '-1';
    const u = new URL(wsUrl);
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== '') u.searchParams.set(k, v);
    }
    return u.toString();
  }
}
