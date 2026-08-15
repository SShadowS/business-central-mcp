import { err, isErr, ok, type Result } from '../../core/result.js';
import {
  AuthenticationError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { isEntraLoginUrl, type SaasTarget } from '../saas-url.js';
import type { AuthFailure, AuthResult, IBCAuthProvider } from './auth-provider.js';
import type { BrowserOpener } from './saas/browser-opener.js';
import { CookieJar } from './saas/cookie-jar.js';
import { FileCookieStore, saasCookieStorePath } from './saas/cookie-store.js';
import { SaasClusterSession } from './saas/cluster-session.js';
import {
  SAAS_BROWSER_UA,
  SAAS_PORTAL_ORIGIN,
  type PreparedConnection,
} from './saas/ests-types.js';
import type { ClientElicitationPort } from '../../mcp/elicitation-port.js';

export interface SaasWebSessionProviderOpts {
  saas: SaasTarget;
  stateDir: string;
  usernamePrefill: string;
  loginTimeoutMs: number;
  opener: BrowserOpener;
  ensurePortalSession: () => Promise<
    Result<void, SignInRequiredError | AuthenticationError | UrlElicitationRequiredError>
  >;
  elicitation?: ClientElicitationPort;
  fetchFn?: typeof fetch;
  logger: Logger;
}

const DEAD_TAB = /HTTP (401|403|500)\b/;

/**
 * Cookie-session provider for BC Online `/csh`. Portal cookies persist on
 * disk; every WebSocket mints a new cluster tab. Does not implement
 * getAccessToken — `bc_query` uses a separate OAuthAuthProvider.
 */
export class SaasWebSessionProvider implements IBCAuthProvider {
  private readonly jar = new CookieJar();
  private readonly store: FileCookieStore;
  private readonly cluster: SaasClusterSession;
  private readonly fetchFn: typeof fetch;
  private prepared: PreparedConnection | undefined;
  private clusterMeta: { host: string; runtimeId: string; csrfHint: string } | undefined;
  private authenticated = false;
  private clusterBound = false;
  private inflight: Promise<Result<AuthResult, AuthFailure>> | null = null;

  constructor(private readonly opts: SaasWebSessionProviderOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.store = new FileCookieStore(saasCookieStorePath(opts.stateDir));
    this.cluster = new SaasClusterSession(this.fetchFn, opts.logger);
  }

  async authenticate(): Promise<Result<AuthResult, AuthFailure>> {
    if (this.inflight) return this.inflight;
    this.inflight = this.authenticateOnce();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async authenticateOnce(): Promise<Result<AuthResult, AuthFailure>> {
    this.loadStoredCookies();
    if (this.jar.hasPortalAuth(this.opts.saas.aadTenantId)) {
      const probe = await this.probePortal();
      if (probe === 'ok') {
        this.persistPortalCookies();
        this.authenticated = true;
        return ok(this.authResult());
      }
    }

    const signedIn = await this.opts.ensurePortalSession();
    if (isErr(signedIn)) return signedIn;

    this.loadStoredCookies();
    if (!this.jar.hasPortalAuth(this.opts.saas.aadTenantId)) {
      return err(new AuthenticationError(
        'Sign-in completed but portal cookies are missing',
        { nonRetryable: true },
      ));
    }
    this.persistPortalCookies();
    this.authenticated = true;
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.prepared = undefined;
    return ok(this.authResult());
  }

  async prepareConnection(): Promise<Result<PreparedConnection, AuthFailure>> {
    if (this.clusterBound && this.clusterMeta) {
      const minted = await this.cluster.mintTab(
        this.jar,
        this.clusterMeta.host,
        this.clusterMeta.runtimeId,
        this.opts.saas.portalUrl,
        this.clusterMeta.csrfHint,
      );
      if (isErr(minted)) {
        if (DEAD_TAB.test(minted.error.message)) this.clusterBound = false;
        return minted;
      }
      this.prepared = minted.value;
      return minted;
    }

    const shell = await this.cluster.readPortalShell(this.jar, this.opts.saas);
    if (isErr(shell)) {
      if (shell.error instanceof AuthenticationError) this.authenticated = false;
      return shell;
    }

    const discovered = await this.cluster.discover(this.jar, this.opts.saas);
    if (isErr(discovered)) return discovered;

    const shared = await this.cluster.shareAuthCookie(
      this.jar,
      this.opts.saas,
      discovered.value.runtimeId,
      shell.value.fceToken,
    );
    if (isErr(shared)) return shared;

    const clusterHost = new URL(discovered.value.clusterAddress).host;
    const authed = await this.cluster.authenticateToken(
      this.jar,
      clusterHost,
      discovered.value.runtimeId,
      discovered.value.tid,
      shell.value.auth,
    );
    if (isErr(authed)) return authed;

    this.clusterBound = true;
    this.clusterMeta = {
      host: clusterHost,
      runtimeId: discovered.value.runtimeId,
      csrfHint: authed.value,
    };

    const minted = await this.cluster.mintTab(
      this.jar,
      clusterHost,
      discovered.value.runtimeId,
      this.opts.saas.portalUrl,
      authed.value,
    );
    if (isErr(minted)) {
      if (DEAD_TAB.test(minted.error.message)) this.clusterBound = false;
      return minted;
    }
    this.prepared = minted.value;
    return minted;
  }

  getWebSocketHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': SAAS_BROWSER_UA,
      Referer: this.opts.saas.portalUrl,
    };
    const cookieUrl = this.prepared?.tabBaseUrl ?? this.opts.saas.portalUrl;
    const cookie = this.jar.headerFor(cookieUrl);
    if (cookie) headers['Cookie'] = cookie;
    return headers;
  }

  getWebSocketQueryParams(): Record<string, string> {
    return this.prepared?.csrfToken ? { csrftoken: this.prepared.csrfToken } : {};
  }

  isAuthenticated(): boolean {
    return this.authenticated || this.jar.hasPortalAuth(this.opts.saas.aadTenantId);
  }

  invalidate(): void {
    this.prepared = undefined;
  }

  markClusterUnbound(): void {
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.prepared = undefined;
  }

  getWebSocketUrl(): string | undefined {
    if (!this.prepared) return undefined;
    return `${wsOrigin(this.prepared.tabBaseUrl)}/csh`;
  }

  getOrigin(): string {
    return SAAS_PORTAL_ORIGIN;
  }

  getHttpBaseUrl(): string | undefined {
    return this.prepared?.tabBaseUrl;
  }

  getSessionTenantId(): string | undefined {
    return this.prepared?.runtimeId ?? this.clusterMeta?.runtimeId;
  }

  /** Test/inspection: whether AUTHENTICATETOKEN has been applied this login. */
  get isClusterBound(): boolean {
    return this.clusterBound;
  }

  private loadStoredCookies(): void {
    const records = this.store.load(this.opts.saas.aadTenantId, this.opts.saas.environmentName);
    if (records) this.jar.load(records);
  }

  private persistPortalCookies(): void {
    this.store.save(
      this.opts.saas.aadTenantId,
      this.opts.saas.environmentName,
      this.jar.persistable(),
    );
  }

  private authResult(): AuthResult {
    return {
      cookies: this.jar.headerFor(this.opts.saas.portalUrl),
      csrfToken: this.prepared?.csrfToken ?? '',
    };
  }

  private async probePortal(): Promise<'ok' | 'entra' | 'error'> {
    try {
      const headers: Record<string, string> = {
        'User-Agent': SAAS_BROWSER_UA,
        Origin: SAAS_PORTAL_ORIGIN,
      };
      const cookie = this.jar.headerFor(this.opts.saas.portalUrl);
      if (cookie) headers['Cookie'] = cookie;
      const res = await this.fetchFn(this.opts.saas.portalUrl, {
        method: 'GET',
        redirect: 'manual',
        headers,
      });
      this.jar.absorb(res, this.opts.saas.portalUrl);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') ?? '';
        return isEntraLoginUrl(location) ? 'entra' : 'error';
      }
      if (res.status >= 200 && res.status < 300) return 'ok';
      return 'error';
    } catch {
      return 'error';
    }
  }
}

function wsOrigin(httpsBase: string): string {
  return httpsBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}
