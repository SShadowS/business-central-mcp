import * as cheerio from 'cheerio';
import { ok, err, type Result } from '../../core/result.js';
import { AuthenticationError } from '../../core/errors.js';
import type { IBCAuthProvider, AuthResult } from './auth-provider.js';
import type { Logger } from '../../core/logger.js';

interface NTLMProviderConfig {
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
}

export class NTLMAuthProvider implements IBCAuthProvider {
  private cookies = '';
  private csrfToken = '';
  private authenticated = false;

  constructor(
    private readonly config: NTLMProviderConfig,
    private readonly logger: Logger
  ) {}

  async authenticate(): Promise<Result<AuthResult, AuthenticationError>> {
    try {
      // Step 1: GET /SignIn
      const signInUrl = `${this.config.baseUrl}/SignIn?tenant=${this.config.tenantId}`;
      const getResponse = await fetch(signInUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'BCMCPServer/2.0' },
      });

      const setCookies = getResponse.headers.getSetCookie?.() ?? [];
      this.cookies = setCookies.map(c => c.split(';')[0]!).join('; ');

      const html = await getResponse.text();
      const $ = cheerio.load(html);
      const verificationToken = $('input[name="__RequestVerificationToken"]').val() as string;

      if (!verificationToken) {
        return err(new AuthenticationError('Failed to extract __RequestVerificationToken from login page'));
      }

      // Step 2: POST /SignIn
      const postBody = new URLSearchParams({
        userName: this.config.username,
        password: this.config.password,
        __RequestVerificationToken: verificationToken,
      });

      const postResponse = await fetch(signInUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.cookies,
          'User-Agent': 'BCMCPServer/2.0',
        },
        body: postBody.toString(),
      });

      // Merge updated cookies
      const postCookies = postResponse.headers.getSetCookie?.() ?? [];
      if (postCookies.length > 0) {
        const existingMap = new Map(this.cookies.split('; ').filter(c => c).map(c => {
          const eqIdx = c.indexOf('=');
          return eqIdx >= 0 ? [c.substring(0, eqIdx), c.substring(eqIdx + 1)] as [string, string] : [c, ''] as [string, string];
        }));
        for (const cookie of postCookies) {
          const [nameValue] = cookie.split(';');
          if (nameValue) {
            const eqIdx = nameValue.indexOf('=');
            if (eqIdx >= 0) {
              existingMap.set(nameValue.substring(0, eqIdx), nameValue.substring(eqIdx + 1));
            }
          }
        }
        this.cookies = Array.from(existingMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      }

      // Extract CSRF token from antiforgery cookie
      const allCookieParts = this.cookies.split('; ');
      for (const part of allCookieParts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx >= 0) {
          const value = part.substring(eqIdx + 1);
          if (value.startsWith('CfDJ8')) {
            this.csrfToken = value;
            break;
          }
        }
      }

      if (!this.csrfToken) {
        return err(new AuthenticationError('Failed to extract CSRF token from antiforgery cookie'));
      }

      this.authenticated = true;
      this.logger.info(`Authenticated as ${this.config.username} to ${this.config.baseUrl}`);
      return ok({ cookies: this.cookies, csrfToken: this.csrfToken });

    } catch (e) {
      return err(new AuthenticationError(
        `Authentication failed: ${e instanceof Error ? e.message : String(e)}`,
        { baseUrl: this.config.baseUrl, username: this.config.username }
      ));
    }
  }

  getWebSocketHeaders(): Record<string, string> {
    return { Cookie: this.cookies };
  }

  getWebSocketQueryParams(): Record<string, string> {
    return { csrftoken: this.csrfToken };
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }
}
