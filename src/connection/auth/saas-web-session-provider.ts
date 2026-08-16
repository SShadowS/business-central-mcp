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
import { SaasClusterSession, ShellUnclassifiableError } from './saas/cluster-session.js';
import { LoginWindow, type LoginFn } from './saas/login-window.js';
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
/** Consecutive unclassifiable-shell reads (2xx with no FixedEndPoint.start,
 * counted across BOTH the authenticate() probe and bindAndMint) before the
 * stored session is treated as dead and interactive sign-in reopens. Only
 * "portal reachable but shell unclassifiable" counts — network failures and
 * portal 4xx/5xx are evidence of nothing about the session and stay purely
 * retryable, so a transient outage never destroys valid cookies. */
const SHELL_UNCLASSIFIABLE_ESCALATION = 3;
/** Minimum time the unclassifiable state must have persisted before the
 * streak may escalate. SessionManager's backoff ladder can produce 3+
 * attempts within a few seconds, and a portal interstitial lasting seconds
 * must never destroy valid persisted cookies. */
const SHELL_ESCALATION_WINDOW_MS = 60_000;

/**
 * Cookie-session provider for BC Online `/csh`. Owns the jar, the store,
 * and the loopback login window. Does not implement getAccessToken.
 */
export class SaasWebSessionProvider implements IBCAuthProvider {
  private readonly jar: CookieJar;
  private readonly store: FileCookieStore;
  private readonly cluster: SaasClusterSession;
  private readonly login: LoginWindow;
  private tab: PreparedConnection | undefined;
  private clusterMeta: { host: string; runtimeId: string; csrfHint: string } | undefined;
  private shellUnclassifiableStreak = 0;
  private shellUnclassifiableSince: number | undefined;
  private authenticated = false;
  private clusterBound = false;
  private inflight: Promise<Result<AuthResult, AuthFailure>> | null = null;

  constructor(private readonly opts: SaasWebSessionProviderOpts) {
    // Deliberately not kept as a field: every portal fetch must go through
    // SaasClusterSession (redirect/Entra classification) or LoginWindow — a
    // direct fetch here would re-create the weaker duplicate probe this
    // provider used to have.
    const fetchFn = opts.fetchFn ?? fetch;
    this.jar = opts.jar ?? new CookieJar();
    this.store = opts.store ?? new FileCookieStore(saasCookieStorePath(opts.stateDir));
    this.cluster = new SaasClusterSession(fetchFn, opts.logger);
    this.login = new LoginWindow({
      opener: opts.opener,
      portalUrl: opts.saas.portalUrl,
      stateDir: opts.stateDir,
      aadTenantId: opts.saas.aadTenantId,
      environmentName: opts.saas.environmentName,
      usernamePrefill: opts.usernamePrefill,
      timeoutMs: opts.loginTimeoutMs,
      elicitation: opts.elicitation,
      fetchFn,
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
      const probe = await this.probePortal();
      if (!isErr(probe)) {
        this.recordShellSuccess();
        this.persistPortalCookies();
        this.authenticated = true;
        return ok(this.authResult());
      }
      if (this.recordShellFailure(probe.error) === 'retryable') {
        // Transient network/portal failure with stored cookies present:
        // fail retryably instead of popping a sign-in window for a session
        // that is probably still valid.
        return err(new ConnectionError(
          'BC Online portal is unreachable (network or portal error); retrying',
        ));
      }
      // 'fatal': Entra redirect, or the unclassifiable streak spanned the
      // escalation window. Tear down and fall through to interactive sign-in.
      this.markSessionDead();
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
    this.recordShellSuccess();
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.tab = undefined;
    return ok(this.authResult());
  }

  async prepare(): Promise<Result<ConnectionBinding, AuthFailure>> {
    let minted: Result<PreparedConnection, AuthFailure>;
    try {
      minted = await this.bindAndMint();
    } catch (e) {
      // A thrown network error (typed ConnectionError from
      // SaasClusterSession.request, or anything unexpected) must surface as
      // a retryable Result — the same outage during authenticate() does.
      return err(e instanceof ConnectionError ? e : new ConnectionError(
        `prepare failed: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
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

    // This shell read may repeat one the authenticate() probe just did on a
    // cold start. That is deliberate: an earlier single-use cache of the
    // probe's shell (a short-lived JWT plus one-shot authorization code)
    // needed a TTL and three clear sites to stay safe — one extra HTTPS GET
    // per cold start is negligible next to the discover/shareAuthCookie/
    // authenticateToken chain that follows.
    const shell = await this.cluster.readPortalShell(this.jar, this.opts.saas);
    if (isErr(shell)) {
      // ConnectionFactory.create skips authenticate() while isAuthenticated()
      // is true, so fatal shell outcomes seen HERE must tear the session down
      // too — otherwise the sign-in window could never reopen for the
      // lifetime of the process.
      if (this.recordShellFailure(shell.error) === 'fatal') this.markSessionDead();
      return shell;
    }
    this.recordShellSuccess();

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
  }

  unboundCluster(): void {
    this.evictTabCookies();
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.tab = undefined;
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
   * A thrown fetch error becomes a plain ConnectionError — retryable and
   * never counted toward escalation.
   */
  private async probePortal(): Promise<Result<unknown, ConnectionError | AuthenticationError>> {
    try {
      return await this.cluster.readPortalShell(this.jar, this.opts.saas);
    } catch (e) {
      return err(new ConnectionError(
        `portal probe failed: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * Record a readPortalShell failure — the ONLY writer of the escalation
   * streak, so classification and bookkeeping cannot drift apart across
   * call sites. 'fatal' means the stored session must be treated as dead:
   * an Entra redirect (immediately), or an unclassifiable shell once the
   * streak has reached the limit AND spanned the minimum window (the
   * backoff ladder can burn 3 attempts in seconds; a brief interstitial
   * must never kill a session). Network/HTTP failures never touch the
   * streak and are always 'retryable'.
   */
  private recordShellFailure(e: unknown): 'fatal' | 'retryable' {
    if (e instanceof AuthenticationError) return 'fatal';
    if (e instanceof ShellUnclassifiableError) {
      this.shellUnclassifiableStreak++;
      this.shellUnclassifiableSince ??= Date.now();
      if (this.shellUnclassifiableStreak >= SHELL_UNCLASSIFIABLE_ESCALATION
        && Date.now() - this.shellUnclassifiableSince >= SHELL_ESCALATION_WINDOW_MS) {
        return 'fatal';
      }
    }
    return 'retryable';
  }

  /** The only reset of the escalation streak, called on every signed-in
   * outcome (successful probe, shell read, or fresh login). */
  private recordShellSuccess(): void {
    this.shellUnclassifiableStreak = 0;
    this.shellUnclassifiableSince = undefined;
  }

  /**
   * Tear down a proven-dead session: reset the streak, drop the auth cookies,
   * and PERSIST the cleared jar — otherwise loadStoredCookies() resurrects
   * the dead cookies from disk on every authenticate() and a canceled
   * sign-in is followed by fresh retryable cycles instead of being
   * re-offered immediately.
   */
  private markSessionDead(): void {
    this.recordShellSuccess();
    this.authenticated = false;
    this.jar.clearPortalAuth();
    this.persistPortalCookies();
  }
}

function wsOrigin(httpsBase: string): string {
  return httpsBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}
