import * as cheerio from 'cheerio';
import { ok, err, type Result } from '../../core/result.js';
import { AuthenticationError } from '../../core/errors.js';
import { bindingFromBaseUrl, type IBCAuthProvider, type AuthResult, type ConnectionBinding } from './auth-provider.js';
import { mergeSetCookies } from './set-cookie-merge.js';
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
      this.cookies = mergeSetCookies('', setCookies);

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

      // Detect rejected credentials. A successful sign-in 302-redirects to the
      // app root; a failure re-renders the login page as a 2xx that still
      // carries the antiforgery-token input. Positively matching that re-render
      // (rather than trusting the presence of a CfDJ8 cookie, which the
      // antiforgery cookie ALSO has) avoids reporting success for bad creds.
      // Verified against decompiled BC28 SignIn behavior + NavUserPasswordValidator.
      if (postResponse.status < 300) {
        const postHtml = await postResponse.text();
        if (postHtml.includes('__RequestVerificationToken')) {
          return err(new AuthenticationError(
            'Sign-in failed: Business Central re-rendered the login page (credentials rejected or account locked).',
            { baseUrl: this.config.baseUrl, username: this.config.username },
          ));
        }
      }

      // Merge updated cookies (honors server cookie deletions via Max-Age/Expires)
      const postCookies = postResponse.headers.getSetCookie?.() ?? [];
      if (postCookies.length > 0) {
        this.cookies = mergeSetCookies(this.cookies, postCookies);
      }

      // Extract CSRF token from antiforgery cookie. Prefer the cookie whose
      // NAME contains "Antiforgery" — every ASP.NET Core data-protection
      // cookie value shares the CfDJ8 prefix (auth cookie included), so a
      // value-prefix scan alone would let cookie ordering pick the wrong one.
      const allCookieParts = this.cookies.split('; ');
      for (const part of allCookieParts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx >= 0 && part.substring(0, eqIdx).toLowerCase().includes('antiforgery')) {
          this.csrfToken = part.substring(eqIdx + 1);
          break;
        }
      }
      if (!this.csrfToken) {
        // Fallback: first cookie whose value carries the data-protection prefix
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

  invalidate(): void {
    this.cookies = '';
    this.csrfToken = '';
    this.authenticated = false;
  }

  async prepare(): Promise<Result<ConnectionBinding, AuthenticationError>> {
    return ok(bindingFromBaseUrl(this.config.baseUrl, this.config.tenantId));
  }

  unboundCluster(): void {}
}
