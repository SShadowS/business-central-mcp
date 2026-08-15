import type { Result } from '../../core/result.js';
import type {
  AuthenticationError,
  ConnectionError,
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
  | SignInRequiredError
  | UrlElicitationRequiredError
  | ConnectionError;

export interface IBCAuthProvider {
  authenticate(): Promise<Result<AuthResult, AuthFailure>>;
  getWebSocketHeaders(): Record<string, string>;
  getWebSocketQueryParams(): Record<string, string>;
  isAuthenticated(): boolean;
  /** Drop cached credentials so the next authenticate() re-runs the login flow.
   * Called when a WebSocket connect fails (cookies may be stale after a BC
   * restart or cookie expiry). */
  invalidate(): void;
  /**
   * Entra access token for HTTP APIs (OData / Standard API). Cookie-only
   * providers (NavUserPassword) leave this unimplemented.
   */
  getAccessToken?(): Promise<string | undefined>;

  /** Bind cluster if needed, then mint a new tab. Called on every WS create. */
  prepareConnection?(): Promise<Result<PreparedConnection, AuthFailure>>;
  /** Absolute WS URL without query (factory still appends ackseqnb + csrf). */
  getWebSocketUrl?(): string | undefined;
  /** WebSocket Origin. SaaS: https://businesscentral.dynamics.com */
  getOrigin?(): string | undefined;
  /** HTTPS base for same-session downloads (SaaS tab URL). */
  getHttpBaseUrl?(): string | undefined;
  /** OpenSession tenantId (SaaS runtime id). */
  getSessionTenantId?(): string | undefined;
  /** Dead cluster session: next prepareConnection must re-bind. */
  markClusterUnbound?(): void;
}
