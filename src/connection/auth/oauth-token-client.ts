import { AuthenticationError } from '../../core/errors.js';
import { err, ok, type Result } from '../../core/result.js';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | undefined;
  idToken?: string;
  expiresAt: number;
  tokenType: string;
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message: string;
  intervalSec: number;
  expiresAt: number;
}

export interface OAuthClientConfig {
  aadTenantId: string;
  clientId: string;
  scope: string;
}

export type Sleeper = (ms: number) => Promise<void>;

const DEFAULT_SLEEP: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface TokenResponseJson {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface DeviceCodeJson {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  error?: string;
  error_description?: string;
}

/**
 * Minimal OAuth 2.0 client for Microsoft Entra ID.
 *
 * Device-code (public client) and refresh_token. No MSAL.
 * Scope: user_impersonation + offline_access.
 */
export class OAuthTokenClient {
  constructor(
    private readonly config: OAuthClientConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: Sleeper = DEFAULT_SLEEP,
  ) {}

  get authority(): string {
    return `https://login.microsoftonline.com/${this.config.aadTenantId}`;
  }

  async startDeviceCode(): Promise<Result<DeviceCodeStart, AuthenticationError>> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      scope: this.config.scope,
    });
    let response: Response;
    try {
      response = await this.fetchFn(`${this.authority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (e) {
      return err(new AuthenticationError(
        `Device-code request failed: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }

    const json = await this.readJson<DeviceCodeJson>(response);
    if (json.error || !json.device_code || !json.user_code || !json.verification_uri) {
      return err(new AuthenticationError(
        `Device-code start failed: ${json.error_description ?? json.error ?? `HTTP ${response.status}`}`,
        { error: json.error },
      ));
    }

    const expiresIn = json.expires_in ?? 900;
    return ok({
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      message: json.message ?? `To sign in, open ${json.verification_uri} and enter ${json.user_code}`,
      intervalSec: json.interval ?? 5,
      expiresAt: Date.now() + expiresIn * 1000,
    });
  }

  /** One token poll, no sleep. Used so bc_query can fail fast and retry. */
  async pollDeviceCodeOnce(start: DeviceCodeStart): Promise<Result<TokenSet, AuthenticationError>> {
    return this.tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: this.config.clientId,
      device_code: start.deviceCode,
    }, { pendingIsNotError: true });
  }

  async pollDeviceCode(start: DeviceCodeStart): Promise<Result<TokenSet, AuthenticationError>> {
    let intervalMs = Math.max(1, start.intervalSec) * 1000;
    while (Date.now() < start.expiresAt) {
      await this.sleep(intervalMs);
      const result = await this.tokenRequest({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: this.config.clientId,
        device_code: start.deviceCode,
      }, { pendingIsNotError: true });
      if (result.ok) return result;
      const code = result.error.context?.['oauthError'];
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      return result;
    }
    return err(new AuthenticationError(
      'Device-code sign-in timed out. Re-run and complete the login at https://microsoft.com/devicelogin.',
    ));
  }

  async refresh(refreshToken: string): Promise<Result<TokenSet, AuthenticationError>> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: refreshToken,
      scope: this.config.scope,
    });
  }

  private async tokenRequest(
    params: Record<string, string>,
    opts: { pendingIsNotError?: boolean } = {},
  ): Promise<Result<TokenSet, AuthenticationError>> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    } catch (e) {
      return err(new AuthenticationError(
        `Token request failed: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }

    const json = await this.readJson<TokenResponseJson>(response);
    if (json.error || !json.access_token) {
      const oauthError = json.error ?? `http_${response.status}`;
      if (opts.pendingIsNotError && (oauthError === 'authorization_pending' || oauthError === 'slow_down')) {
        return err(new AuthenticationError(oauthError, { oauthError }));
      }
      return err(new AuthenticationError(
        `Token request failed: ${json.error_description ?? json.error ?? `HTTP ${response.status}`}`,
        { oauthError },
      ));
    }

    const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
    return ok({
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      idToken: json.id_token,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: json.token_type ?? 'Bearer',
    });
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      return {} as T;
    }
  }
}
