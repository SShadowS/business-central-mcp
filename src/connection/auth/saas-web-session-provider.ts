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
import { DeadTabError, SaasClusterSession, ShellUnclassifiableError } from './saas/cluster-session.js';
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

/** Consecutive unclassifiable-shell reads (ShellUnclassifiableError: a 2xx
 * with no FixedEndPoint.start, a token-less shell, or a bare 401/403 —
 * counted across BOTH the authenticate() probe and bindAndMint) before the
 * stored session is treated as dead and interactive sign-in reopens.
 * Network failures and portal 5xx are evidence of nothing about the session
 * and stay purely retryable, so a transient outage never destroys valid
 * cookies. */
const SHELL_UNCLASSIFIABLE_ESCALATION = 3;
/** Minimum time the unclassifiable state must have persisted before the
 * streak may escalate. SessionManager's backoff ladder can produce 3+
 * attempts within a few seconds, and a portal interstitial lasting seconds
 * must never destroy valid persisted cookies. */
const SHELL_ESCALATION_WINDOW_MS = 60_000;
/** Gap after which an unclassifiable streak is stale: a persistent portal
 * state keeps failing every retry/tool call within minutes, so a longer
 * silence means the old burst is no longer evidence about the current state.
 * Must exceed SHELL_ESCALATION_WINDOW_MS, or spanning the window would
 * itself reset the streak. */
const SHELL_STREAK_STALE_MS = 10 * 60_000;

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
  private shellUnclassifiableLast: number | undefined;
  private failedEpisodes = 0;
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
      const probe = await this.readShellTracked();
      if (!isErr(probe)) {
        this.persistPortalCookies();
        return ok(this.authResult());
      }
      if (probe.error instanceof ConnectionError) {
        // Transient failure with stored cookies present: fail retryably
        // (preserving the typed error and its detail — network vs
        // unclassifiable shell) instead of popping a sign-in window for a
        // session that is probably still valid.
        return err(probe.error);
      }
      // Fatal (AuthenticationError from readShellTracked): teardown already
      // applied there — fall through to interactive sign-in.
    }

    const signedIn = await this.login.run();
    if (isErr(signedIn)) return signedIn;

    if (!this.jar.hasPortalAuth()) {
      return err(new AuthenticationError(
        'Sign-in completed but portal cookies are missing',
        { nonRetryable: true },
      ));
    }
    const verified = await this.verifyFreshLogin();
    if (isErr(verified)) return verified;
    this.persistPortalCookies();
    this.recordShellSuccess();
    this.clusterBound = false;
    this.clusterMeta = undefined;
    this.tab = undefined;
    return ok(this.authResult());
  }

  /**
   * A fresh sign-in can complete with an account the configured portal does
   * not accept (multi-account user picking the wrong one at Entra): cookie
   * presence alone cannot detect this since the auth cookie is named by the
   * RESOLVED tenant GUID. Verify behaviorally — the portal at the configured
   * URL must hand back a SIGNED-IN shell. An Entra redirect and a token-less
   * or unclassifiable shell both fail verification (a wrong-tenant session
   * often surfaces as the latter; accepting it would persist wrong-tenant
   * cookies as "success" and later degrade into unexplained repeat sign-in
   * prompts). Only a plain network failure passes on benefit of the doubt —
   * the next create's probe re-checks.
   */
  private async verifyFreshLogin(): Promise<Result<void, AuthFailure>> {
    // Deliberately untracked (probePortal, not readShellTracked): this read
    // verifies the sign-in that just happened and must not feed the streak.
    // An unclassifiable shell gets ONE retry — this is the first real shell
    // classification after an MFA sign-in, and a single transient
    // interstitial must not destroy the session the user just created. A
    // wrong tenant fails deterministically, so the retry cannot admit one.
    let rejected = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const probe = await this.probePortal();
      if (!isErr(probe)) return ok(undefined);
      if (probe.error instanceof AuthenticationError) { rejected = true; break; }
      if (!(probe.error instanceof ShellUnclassifiableError)) return ok(undefined);
      rejected = true;
    }
    if (rejected) {
      this.markSessionDead();
      // Reset the login window too: its cached completed-ok would otherwise
      // short-circuit the next run() and surface a misleading
      // "portal cookies are missing" instead of this message.
      await this.login.close();
      return err(new AuthenticationError(
        `Sign-in completed, but ${this.opts.saas.portalUrl} did not return a signed-in session — `
        + 'signed in with a different account or tenant than configured, or the portal is degraded? '
        + 'The sign-in was not saved.',
        { nonRetryable: true },
      ));
    }
    return ok(undefined);
  }

  async prepare(): Promise<Result<ConnectionBinding, AuthFailure>> {
    let minted: Result<PreparedConnection, AuthFailure>;
    try {
      minted = await this.bindAndMint();
    } catch (e) {
      // A thrown network error (typed ConnectionError from
      // SaasClusterSession.request) surfaces as a retryable Result — the
      // same outage during authenticate() does. Anything else is a
      // programming bug and propagates raw (stack intact) rather than being
      // relabeled a retryable outage.
      if (e instanceof ConnectionError) return err(e);
      throw e;
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
        if (minted.error instanceof DeadTabError) this.clusterBound = false;
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
    const shell = await this.readShellTracked();
    if (isErr(shell)) return shell;

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
      if (minted.error instanceof DeadTabError) this.clusterBound = false;
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
    // The jar is the single source of truth: a shadow flag diverged from it
    // exactly once — on cookie expiry — and reported a session that no
    // longer existed.
    return this.jar.hasPortalAuth();
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
  private async probePortal(): Promise<ReturnType<SaasClusterSession['readPortalShell']>> {
    try {
      return await this.cluster.readPortalShell(this.jar, this.opts.saas);
    } catch (e) {
      // request() throws typed ConnectionErrors — preserve the instance.
      // Anything else is a programming bug and propagates raw (stack
      // intact), matching prepare()'s policy.
      if (e instanceof ConnectionError) return err(e);
      throw e;
    }
  }

  /**
   * Read the portal shell WITH escalation bookkeeping — the tracked entry
   * every liveness decision must use. (verifyFreshLogin deliberately probes
   * untracked: a post-login shell read is a verification of the sign-in
   * that just happened, not evidence about the pre-existing session, and
   * must never count toward killing the session it just created.)
   * Liveness = "would readPortalShell hand us a signed-in shell?": one
   * implementation of shell classification (redirect following, Entra
   * detection, signed-out 2xx shells) instead of a weaker duplicate.
   * A fatal outcome (Entra redirect, or an escalated unclassifiable streak)
   * tears the session down here and surfaces as AuthenticationError, so
   * callers distinguish fatal from retryable by error type alone.
   */
  private async readShellTracked(): Promise<ReturnType<SaasClusterSession['readPortalShell']>> {
    const shell = await this.probePortal();
    if (!isErr(shell)) {
      this.recordShellSuccess();
      return shell;
    }
    if (this.recordShellFailure(shell.error) === 'fatal') {
      this.markSessionDead();
      return err(shell.error instanceof AuthenticationError
        ? shell.error
        : new AuthenticationError(shell.error.message));
    }
    return shell;
  }

  /**
   * Record a readPortalShell failure — the ONLY writer of the escalation
   * streak, so classification and bookkeeping cannot drift apart across
   * call sites. 'fatal' means the stored session must be treated as dead:
   * an Entra redirect (immediately), or an unclassifiable shell once EITHER
   * the streak has reached the limit AND spanned the minimum window (the
   * backoff ladder can burn 3 attempts in seconds; a brief interstitial
   * must never kill a session), OR two full episodes have already failed
   * (sporadic usage — attempts more than the staleness gap apart — would
   * otherwise never satisfy streak+window and wedge retryable forever).
   * Network/HTTP failures never touch the streak and are always 'retryable'.
   */
  private recordShellFailure(e: unknown): 'fatal' | 'retryable' {
    if (e instanceof AuthenticationError) return 'fatal';
    if (e instanceof ShellUnclassifiableError) {
      const now = Date.now();
      // A streak ages out: an old burst separated from this failure by a
      // long gap is no longer evidence about the current state — a fresh
      // 5-second interstitial days later must start a fresh streak, not
      // inherit an escalation-ready one. Any aged-out failures count as a
      // failed episode (a single probe per tool call is a supported cadence
      // via BC_RECONNECT_MAX_RETRIES=0, so episodes cannot require full
      // bursts); a brief blip still never kills the session because any
      // intervening SUCCESS resets everything, and escalation needs three
      // failure occasions with zero successes in between.
      if (this.shellUnclassifiableLast !== undefined
        && now - this.shellUnclassifiableLast > SHELL_STREAK_STALE_MS) {
        this.failedEpisodes++;
        this.shellUnclassifiableStreak = 0;
        this.shellUnclassifiableSince = undefined;
      }
      this.shellUnclassifiableLast = now;
      this.shellUnclassifiableStreak++;
      this.shellUnclassifiableSince ??= now;
      if (this.failedEpisodes >= 2) return 'fatal';
      if (this.shellUnclassifiableStreak >= SHELL_UNCLASSIFIABLE_ESCALATION
        && now - this.shellUnclassifiableSince >= SHELL_ESCALATION_WINDOW_MS) {
        return 'fatal';
      }
    }
    return 'retryable';
  }

  /** Recorded on every signed-in outcome (successful probe, shell read, or
   * fresh login). */
  private recordShellSuccess(): void {
    this.resetShellStreak();
  }

  /** The only reset of the escalation state — reached from a signed-in
   * outcome or from tearing down a proven-dead session. */
  private resetShellStreak(): void {
    this.shellUnclassifiableStreak = 0;
    this.shellUnclassifiableSince = undefined;
    this.shellUnclassifiableLast = undefined;
    this.failedEpisodes = 0;
  }

  /**
   * Tear down a proven-dead session: reset the streak, drop the auth cookies,
   * and PERSIST the cleared jar — otherwise loadStoredCookies() resurrects
   * the dead cookies from disk on every authenticate() and a canceled
   * sign-in is followed by fresh retryable cycles instead of being
   * re-offered immediately.
   */
  private markSessionDead(): void {
    this.resetShellStreak();
    this.jar.clearPortalAuth();
    this.persistPortalCookies();
  }
}

function wsOrigin(httpsBase: string): string {
  return httpsBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}
