import { join } from 'node:path';
import { ok, isErr, type Result } from '../../core/result.js';
import { AuthenticationError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { bindingFromBaseUrl, type IBCAuthProvider, type AuthResult, type ConnectionBinding } from './auth-provider.js';
import { isSaasHost } from '../saas-url.js';
import { OAuthTokenClient, type TokenSet } from './oauth-token-client.js';
import { FileTokenCache } from './token-cache.js';

export interface OAuthProviderConfig {
  baseUrl: string;
  aadTenantId: string;
  /** BC tenant (e.g. "default") for OpenSession on AAD-configured on-prem servers. */
  tenantId?: string;
  clientId: string;
  scope: string;
  stateDir: string;
}

const EXPIRY_SKEW_MS = 60_000;

/**
 * Entra ID device-code auth for the BC Standard API (`bc_query`).
 *
 * `/csh` on SaaS is a different surface (ESTS cookie session). This
 * provider still tries a Bearer GET of the portal; a 302 to Entra means
 * no web session. bc_query does not need /csh.
 */
export class OAuthAuthProvider implements IBCAuthProvider {
  private cookies = '';
  private csrfToken = '';
  private authenticated = false;
  private tokens: TokenSet | undefined;
  private readonly client: OAuthTokenClient;
  private readonly cache: FileTokenCache;
  private inflight: Promise<Result<AuthResult, AuthenticationError>> | null = null;

  constructor(
    private readonly config: OAuthProviderConfig,
    private readonly logger: Logger,
    client?: OAuthTokenClient,
    cache?: FileTokenCache,
  ) {
    this.client = client ?? new OAuthTokenClient({
      aadTenantId: config.aadTenantId,
      clientId: config.clientId,
      scope: config.scope,
    });
    this.cache = cache ?? new FileTokenCache(join(config.stateDir, 'oauth-tokens.json'));
  }

  async authenticate(): Promise<Result<AuthResult, AuthenticationError>> {
    if (this.inflight) return this.inflight;
    this.inflight = this.authenticateOnce();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async authenticateOnce(): Promise<Result<AuthResult, AuthenticationError>> {
    const tokenResult = await this.ensureToken();
    if (isErr(tokenResult)) return tokenResult;

    await this.bootstrapWebSession(tokenResult.value.accessToken);

    this.authenticated = true;
    this.logger.info(`Authenticated to ${this.config.baseUrl} via Entra ID (tenant ${this.config.aadTenantId})`);
    return ok({ cookies: this.cookies, csrfToken: this.csrfToken });
  }

  async getAccessToken(): Promise<string | undefined> {
    const result = await this.ensureToken();
    if (isErr(result)) {
      this.logger.warn(`OAuth token acquisition failed: ${result.error.message}`);
      return undefined;
    }
    return result.value.accessToken;
  }

  getWebSocketHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.cookies) headers['Cookie'] = this.cookies;
    if (this.tokens?.accessToken) headers['Authorization'] = `Bearer ${this.tokens.accessToken}`;
    return headers;
  }

  getWebSocketQueryParams(): Record<string, string> {
    return this.csrfToken ? { csrftoken: this.csrfToken } : {};
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  invalidate(): void {
    this.cookies = '';
    this.csrfToken = '';
    this.authenticated = false;
    // Keep refresh token. ConnectionFactory calls invalidate() on a failed
    // /csh upgrade (stale cookies); dropping the refresh token would force
    // another device-code prompt on every reconnect.
  }

  async prepare(): Promise<Result<ConnectionBinding, AuthenticationError>> {
    // OpenSession tenant: on SaaS the portal path segment is the AAD GUID,
    // but on AAD-configured on-prem the BC tenant (e.g. "default") must be
    // sent — the AAD GUID would target a nonexistent BC tenant.
    let saas = false;
    try {
      saas = isSaasHost(new URL(this.config.baseUrl).hostname);
    } catch {
      // Malformed baseUrl: treat as on-prem; connect will fail with a clearer error.
    }
    const sessionTenant = saas
      ? this.config.aadTenantId
      : (this.config.tenantId ?? this.config.aadTenantId);
    return ok(bindingFromBaseUrl(this.config.baseUrl, sessionTenant));
  }

  unboundCluster(): void {}

  private async ensureToken(): Promise<Result<TokenSet, AuthenticationError>> {
    if (this.tokens && this.tokens.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return ok(this.tokens);
    }

    const cached = this.cache.load(this.config.clientId, this.config.aadTenantId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      this.tokens = {
        accessToken: cached.accessToken,
        refreshToken: cached.refreshToken,
        expiresAt: cached.expiresAt,
        tokenType: 'Bearer',
      };
      return ok(this.tokens);
    }

    if (cached?.refreshToken) {
      const refreshed = await this.client.refresh(cached.refreshToken);
      if (refreshed.ok) {
        this.persist(refreshed.value, cached.refreshToken);
        return ok(refreshed.value);
      }
      this.logger.warn(`Refresh token rejected (${refreshed.error.message}); falling back to device-code`);
      this.cache.clear();
    }

    const acquired = await this.deviceCode();
    if (isErr(acquired)) return acquired;
    this.persist(acquired.value, acquired.value.refreshToken);
    return acquired;
  }

  private async deviceCode(): Promise<Result<TokenSet, AuthenticationError>> {
    const started = await this.client.startDeviceCode();
    if (isErr(started)) return started;
    this.logger.info(started.value.message);
    this.logger.info(`OAuth device code: ${started.value.userCode} — open ${started.value.verificationUri}`);
    return this.client.pollDeviceCode(started.value);
  }

  private persist(tokens: TokenSet, previousRefresh: string | undefined): void {
    this.tokens = {
      ...tokens,
      refreshToken: tokens.refreshToken ?? previousRefresh,
    };
    this.cache.save({
      accessToken: this.tokens.accessToken,
      refreshToken: this.tokens.refreshToken,
      expiresAt: this.tokens.expiresAt,
      clientId: this.config.clientId,
      aadTenantId: this.config.aadTenantId,
    });
  }

  /**
   * Best-effort portal GET with the API Bearer token. Same-origin redirects
   * are followed and Set-Cookie is merged. A 302 to login.microsoftonline.com
   * means the front door wants the first-party OIDC cookie session — we stop
   * and leave cookies empty rather than pretending SignIn succeeded.
   */
  private async bootstrapWebSession(accessToken: string): Promise<void> {
    this.cookies = '';
    this.csrfToken = '';

    let url = this.config.baseUrl;
    for (let hop = 0; hop < 8; hop++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'BCMCPServer/2.0',
            ...(this.cookies ? { Cookie: this.cookies } : {}),
          },
        });
      } catch (e) {
        this.logger.warn(`SaaS web-session bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) {
        this.cookies = mergeSetCookies(this.cookies, setCookies);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          break;
        }
        if (isEntraLogin(next.hostname)) {
          this.logger.warn(
            'SaaS web client redirected to Entra login. The /csh WebSocket needs the first-party web-client cookie session; bc_query (OData) still works with this token.',
          );
          this.cookies = '';
          this.csrfToken = '';
          return;
        }
        const baseHost = hostnameOf(this.config.baseUrl);
        if (next.hostname !== baseHost && !next.hostname.endsWith('.businesscentral.dynamics.com')) {
          this.logger.warn(`SaaS web-session bootstrap stopped at cross-origin redirect ${next.origin}`);
          break;
        }
        url = next.toString();
        continue;
      }

      break;
    }

    this.csrfToken = extractCsrf(this.cookies);
  }
}

function isEntraLogin(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'login.microsoftonline.com'
    || host === 'login.windows.net'
    || host === 'login.microsoft.com'
    || host.endsWith('.microsoftonline.com');
}

function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

export function mergeSetCookies(existing: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split('; ').filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq >= 0) map.set(part.slice(0, eq), part.slice(eq + 1));
    else map.set(part, '');
  }
  for (const header of setCookieHeaders) {
    const nameValue = header.split(';')[0];
    if (!nameValue) continue;
    const eq = nameValue.indexOf('=');
    if (eq >= 0) map.set(nameValue.slice(0, eq), nameValue.slice(eq + 1));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function extractCsrf(cookies: string): string {
  const parts = cookies.split('; ').filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) {
      return part.slice(eq + 1);
    }
  }
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(eq + 1).startsWith('CfDJ8')) {
      return part.slice(eq + 1);
    }
  }
  return '';
}
