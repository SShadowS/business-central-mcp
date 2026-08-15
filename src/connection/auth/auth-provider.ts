import type { Result } from '../../core/result.js';
import type { AuthenticationError } from '../../core/errors.js';

export interface AuthResult {
  cookies: string;
  csrfToken: string;
}

export interface IBCAuthProvider {
  authenticate(): Promise<Result<AuthResult, AuthenticationError>>;
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
}
