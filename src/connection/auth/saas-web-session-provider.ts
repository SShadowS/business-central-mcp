import { err, isErr, ok, type Result } from '../../core/result.js';
import { AuthenticationError, ConnectionError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { SaasTarget } from '../saas-url.js';
import type {
  AuthFailure,
  AuthResult,
  ConnectionBinding,
  IBCAuthProvider,
} from './auth-provider.js';
import type { BrowserOpener } from './saas/browser-opener.js';
import { CookieJar } from './saas/cookie-jar.js';
import { FileCookieStore, saasCookieStorePath } from './saas/cookie-store.js';
import { SaasClusterSession } from './saas/cluster-session.js';
import { LoginWindow, type LoginFn } from './saas/login-window.js';
import {
  SAAS_BROWSER_UA,
  SAAS_PORTAL_ORIGIN,
  type FixedEndPointAuth,
  type PreparedConnection,
} from './saas/ests-types.js';
import type { ClientElicitationPort } from '../../mcp/elicitation-port.js';

export interface SaasWebSessionProviderOpts {
  saas: SaasTarget;
  stateDir: string;
  usernamePrefill: string;
  loginTimeoutMs?: number;
  opener: BrowserOpener;
  fetchFn?: typeof fetch;
  logger: Logger;
  elicitation?: ClientElicitationPort;
  loginFn?: LoginFn;
  /** Test seam: share identity with LoginWindow. */
  jar?: CookieJar;
  store?: FileCookieStore;
}

const DEAD_TAB = /HTTP (401|403|500)\b/;

/**
 * Cookie-session provider for BC Online `/csh`. Owns the jar, the store,
 * and the loopback login window. Does not implement getAccessToken.
 */
export class SaasWebSessionProvider implements IBCAuthProvider {
  private readonly jar: CookieJar;
  private readonly store: FileCookieStore;
  private readonly cluster: SaasClusterSession;
  private readonly login: LoginWindow;
  private readonly fetchFn: typeof fetch;
  private tab: PreparedConnection | undefined;
  private clusterMeta: { host: string; runtimeId: string; csrfHint: string } | undefined;
  /** Shell captured by the last successful portalAlive() probe, consumed
   * (single-use) by the next bindAndMint so the authenticate()→prepare()
   * cold-start path fetches the portal shell once, not twice. */
  private pendingShell: { fceToken: string; auth: FixedEndPointAuth } | undefined;
  private authenticated = false;
  private clusterBound = false;
  private inflight: Promise<Result<AuthResult, AuthFailure>> | null = null;

  constructor(private readonly opts: SaasWebSessionProviderOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.jar = opts.jar ?? new CookieJar();
    this.store = opts.store ?? new FileCookieStore(saasCookieStorePath(opts.stateDir));
    this.cluster = new SaasClusterSession(this.fetchFn, opts.logger);
    this.login = new LoginWindow({
      opener: opts.opener,
      portalUrl: opts.saas.portalUrl,
      stateDir: opts.stateDir,
      aadTenantId: opts.saas.aadTenantId,
      environmentName: opts.saas.environmentName,
      usernamePrefill: opts.usernamePrefill,
      timeoutMs: opts.loginTimeoutMs,
      elicitation: opts.elicitation,
      fetchFn: this.fetchFn,
      logger: opts.logger,
      loginFn: opts.loginFn,
      jar: this.jar,
      store: this.store,
    });
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
    if (this.jar.hasPortalAuth()) {
      const probe = await this.portalAlive();
      if (probe === 'ok') {
        this.persistPortalCookies();
        this.authenticated = true;
        return ok(this.authResult());
      }
      if (probe === 'error') {
        // Transient network/portal failure with stored cookies present:
        // fail retryably instead of popping a sign-in window for a session
        // that is probably still valid.
        return err(new ConnectionError(
          'BC Online portal is unreachable (network or portal error); retrying',
        ));
      }
      // probe === 'entra': the portal no longer honors the stored session.
      // Drop the stale auth cookies so a fresh sign-in replaces them.
      this.jar.clearPortalAuth();
      this.authenticated = false;
      this.pendingShell = undefined;
    }

    const signedIn = await this.login.run();
    if (isErr(signedIn)) return signedIn;

    if (!this.jar.hasPortalAuth()) {
      return err(new AuthenticationError(
        'Sign-in completed but portal cookies are missing',
        { nonRetryable: true },
      ));
    }
    this.persistPortalCookies();
    this.authenticated = true;
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.tab = undefined;
    return ok(this.authResult());
  }

  async prepare(): Promise<Result<ConnectionBinding, AuthFailure>> {
    const minted = await this.bindAndMint();
    if (isErr(minted)) return minted;
    this.tab = minted.value;
    return ok({
      wsUrl: `${wsOrigin(minted.value.tabBaseUrl)}/csh`,
      origin: SAAS_PORTAL_ORIGIN,
      httpBaseUrl: minted.value.tabBaseUrl,
      sessionTenantId: minted.value.runtimeId,
    });
  }

  private async bindAndMint(): Promise<Result<PreparedConnection, AuthFailure>> {
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
      return minted;
    }

    const cachedShell = this.pendingShell;
    this.pendingShell = undefined;
    const shell = cachedShell
      ? ok(cachedShell)
      : await this.cluster.readPortalShell(this.jar, this.opts.saas);
    if (isErr(shell)) {
      if (shell.error instanceof AuthenticationError) {
        // Portal redirected to Entra: the stored session is dead. Clear the
        // stale auth cookies too, or isAuthenticated() stays true forever and
        // ConnectionFactory never re-runs authenticate() (sign-in window
        // could never reopen for the lifetime of the process).
        this.authenticated = false;
        this.jar.clearPortalAuth();
        this.pendingShell = undefined;
      }
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
    return minted;
  }

  getWebSocketHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': SAAS_BROWSER_UA,
      Referer: this.opts.saas.portalUrl,
    };
    const cookieUrl = this.tab?.tabBaseUrl ?? this.opts.saas.portalUrl;
    const cookie = this.jar.headerFor(cookieUrl);
    if (cookie) headers['Cookie'] = cookie;
    return headers;
  }

  getWebSocketQueryParams(): Record<string, string> {
    return this.tab?.csrfToken ? { csrftoken: this.tab.csrfToken } : {};
  }

  isAuthenticated(): boolean {
    return this.authenticated || this.jar.hasPortalAuth();
  }

  invalidate(): void {
    this.evictTabCookies();
    this.tab = undefined;
    this.pendingShell = undefined;
  }

  unboundCluster(): void {
    this.evictTabCookies();
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.tab = undefined;
    this.pendingShell = undefined;
  }

  /** A new tab is minted per WebSocket; drop the dead tab's path-scoped cookies. */
  private evictTabCookies(): void {
    if (!this.tab) return;
    try {
      this.jar.evictPathPrefix(new URL(this.tab.tabBaseUrl).pathname);
    } catch {
      // Malformed tab base URL: nothing to evict.
    }
  }

  get isClusterBound(): boolean {
    return this.clusterBound;
  }

  get lastTabWsUrl(): string | undefined {
    return this.tab ? `${wsOrigin(this.tab.tabBaseUrl)}/csh` : undefined;
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
      csrfToken: '',
    };
  }

  /**
   * Liveness = "would readPortalShell hand us a signed-in shell?", so probe
   * with readPortalShell itself: one implementation of shell classification
   * (redirect following, Entra detection, signed-out 2xx shells) instead of
   * a weaker duplicate that misread canonical 302s and sign-in-page 200s.
   */
  private async portalAlive(): Promise<'ok' | 'entra' | 'error'> {
    try {
      const shell = await this.cluster.readPortalShell(this.jar, this.opts.saas);
      if (!isErr(shell)) {
        this.pendingShell = { fceToken: shell.value.fceToken, auth: shell.value.auth };
        return 'ok';
      }
      return shell.error instanceof AuthenticationError ? 'entra' : 'error';
    } catch {
      return 'error';
    }
  }
}

function wsOrigin(httpsBase: string): string {
  return httpsBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}
