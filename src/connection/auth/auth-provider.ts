import type { Result } from '../../core/result.js';
import type {
  AuthenticationError,
  ConnectionError,
  DeviceLoginRequiredError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../../core/errors.js';
import type { PreparedConnection } from './saas/ests-types.js';

export type { PreparedConnection };

export interface AuthResult {
  cookies: string;
  csrfToken: string;
}

export type AuthFailure =
  | AuthenticationError
  | DeviceLoginRequiredError
  | SignInRequiredError
  | UrlElicitationRequiredError
  | ConnectionError;

/** What ConnectionFactory needs after a successful prepare(). */
export interface ConnectionBinding {
  wsUrl: string;
  origin: string;
  httpBaseUrl: string;
  sessionTenantId: string;
}

export function bindingFromBaseUrl(baseUrl: string, sessionTenantId: string): ConnectionBinding {
  return {
    wsUrl: `${baseUrl.replace(/^http/i, 'ws')}/csh`,
    origin: new URL(baseUrl).origin,
    httpBaseUrl: baseUrl,
    sessionTenantId,
  };
}

export function isDeadClusterStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 500;
}

export interface IBCAuthProvider {
  authenticate(): Promise<Result<AuthResult, AuthFailure>>;
  /** Bind (if needed) and return the WS/HTTP/tenant coordinates for this connection. */
  prepare(): Promise<Result<ConnectionBinding, AuthFailure>>;
  getWebSocketHeaders(): Record<string, string>;
  getWebSocketQueryParams(): Record<string, string>;
  isAuthenticated(): boolean;
  invalidate(): void;
  /** Dead cluster (HTTP 401/403/500 on upgrade). NTLM/OAuth: no-op. */
  unboundCluster(): void;
  getAccessToken?(): Promise<string | undefined>;
}
