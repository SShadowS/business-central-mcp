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
}
