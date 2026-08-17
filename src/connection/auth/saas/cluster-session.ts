import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../../../core/result.js';
import { AuthenticationError, ConnectionError } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import { isEntraLoginUrl, type SaasTarget } from '../../saas-url.js';
import { CookieJar } from './cookie-jar.js';
import { extractFceToken, extractFixedEndPointAuth, parseDeploymentJson, parseFixedEndPoint } from './html-extract.js';
import { redactingLogger } from './redact.js';
import { fetchWithJar } from './saas-http.js';
import {
  SAAS_PORTAL_ORIGIN,
  type DeploymentReady,
  type FixedEndPointAuth,
  type PreparedConnection,
} from './ests-types.js';

const MAX_SHELL_REDIRECTS = 5;

/**
 * A 2xx portal response with no FixedEndPoint.start at all — reachable, but
 * neither provably signed-in nor provably signed-out. Distinguished from
 * plain ConnectionError so the provider can count these toward sign-in
 * escalation while network/HTTP failures stay purely retryable.
 */
export class ShellUnclassifiableError extends ConnectionError {}

/**
 * A tab endpoint answered in a way that means the cluster no longer honors
 * the session (401/403/500 per the design spec, or a redirect pointing at
 * Entra / off the cluster origin). Typed so the provider unbinds by
 * instanceof, not by string-matching the message. A benign SAME-ORIGIN 3xx
 * (canonicalization/affinity re-pin) is NOT dead — treating it as dead
 * created an unbounded rebind loop on a live session.
 */
export class DeadTabError extends ConnectionError {}

/** Non-empty reason when a tab response means the session is dead. */
function deadTabReason(res: Response, tabBaseUrl: string): string | undefined {
  if (res.status === 401 || res.status === 403 || res.status === 500) {
    return `HTTP ${res.status}`;
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '';
    if (isEntraLoginUrl(location)) return `redirected to Entra sign-in`;
    let next: URL | undefined;
    try {
      next = location ? new URL(location, tabBaseUrl) : undefined;
    } catch { /* unusable Location — treat as dead below */ }
    if (!next || next.origin !== new URL(tabBaseUrl).origin) {
      return `HTTP ${res.status} off-origin`;
    }
    // Benign same-origin redirect on a live session: not dead.
  }
  return undefined;
}

export class SaasClusterSession {
  private readonly log: Logger;

  constructor(
    private readonly fetchFn: typeof fetch,
    logger: Logger,
  ) {
    this.log = redactingLogger(logger);
  }

  async readPortalShell(
    jar: CookieJar,
    saas: SaasTarget,
  ): Promise<Result<{ fceToken: string; auth: FixedEndPointAuth; html: string }, ConnectionError | AuthenticationError>> {
    // A valid session may 302 to a canonical/locale URL before serving the
    // shell; follow same-origin hops so a signed-in user is not misread as
    // signed out. Entra redirects still mean sign-in is required, and
    // off-origin redirects are never followed (cookies stay on the portal).
    // Deliberately NOT shared with EstsLoginClient.followRedirects: the login
    // flow must follow cross-origin hops to Entra and back, exactly what this
    // read must fail closed on.
    let url = saas.portalUrl;
    let page: { res: Response; html: string };
    for (let hop = 0; ; hop++) {
      page = await this.request(jar, url, {
        headers: { Origin: SAAS_PORTAL_ORIGIN, Referer: saas.portalUrl },
      });
      if (page.res.status < 300 || page.res.status >= 400) break;
      const location = page.res.headers.get('location') ?? '';
      // Entra classification outranks the hop cap: a sign-in redirect arriving
      // exactly at the cap must still surface as auth-required, or the stale
      // cookies are kept and retried forever.
      if (isEntraLoginUrl(location)) {
        return err(new AuthenticationError('Portal redirected to Entra sign-in'));
      }
      if (hop === MAX_SHELL_REDIRECTS) {
        return err(new ConnectionError(`Portal redirect chain exceeded ${MAX_SHELL_REDIRECTS} hops`));
      }
      let next: URL | undefined;
      try {
        // new URL('', base) resolves to base itself — an empty Location must
        // not silently refetch the same URL until the hop cap trips.
        next = location ? new URL(location, url) : undefined;
      } catch { /* handled below */ }
      if (!next) {
        return err(new ConnectionError('Portal redirect has no usable Location'));
      }
      if (next.origin !== saas.origin) {
        return err(new ConnectionError(`Portal redirected off-origin to ${next.host}`));
      }
      url = next.href;
    }
    if (page.res.status === 401 || page.res.status === 403) {
      // A bare 401/403 on the shell GET with cookies attached suggests the
      // session was revoked without an Entra redirect — it rides the
      // windowed escalation streak so sign-in eventually reopens, instead of
      // staying retryable forever.
      return err(new ShellUnclassifiableError(`Portal shell HTTP ${page.res.status}`));
    }
    if (page.res.status >= 400) {
      // A 5xx/other error page carries no FixedEndPoint auth; it must fail
      // retryably, not fall through to the signed-out-shell classification
      // (which would destroy valid stored cookies).
      return err(new ConnectionError(`Portal shell HTTP ${page.res.status}`));
    }
    const fp = parseFixedEndPoint(page.html);
    if (!fp) {
      // No FixedEndPoint.start at all: an interstitial/consent/unknown page,
      // not proof the session is signed out. Fail retryably — clearing valid
      // cookies here would force interactive sign-in on a transient page.
      return err(new ShellUnclassifiableError(
        'Portal 2xx response has no FixedEndPoint.start; not a portal shell',
      ));
    }
    const auth = extractFixedEndPointAuth(fp);
    this.log.info('saas-web: portal shell', { hasAccess: Boolean(auth.accessToken), hasCode: Boolean(auth.authorizationCode) });
    if (!auth.accessToken) {
      // A shell rendering FixedEndPoint WITHOUT an accessToken is strong but
      // not conclusive evidence of a signed-out session — the portal's
      // server-side silent token acquisition can transiently fail on a LIVE
      // session. It escalates via the provider's windowed streak (like a
      // missing FixedEndPoint) rather than destroying cookies on one
      // sighting; the Entra redirect above remains the immediate
      // dead-session signal.
      return err(new ShellUnclassifiableError(
        'FixedEndPoint.start has no accessToken; portal shell is not a signed-in session',
      ));
    }
    return ok({ fceToken: extractFceToken(page.html), auth, html: page.html });
  }

  async discover(jar: CookieJar, saas: SaasTarget): Promise<Result<DeploymentReady, ConnectionError>> {
    const url = `${saas.portalUrl}/api/deployment?${new URLSearchParams({
      redirectedFromSignup: 'false',
      autoProvision: 'true',
    })}`;
    const page = await this.request(jar, url, {
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: saas.origin,
      },
    });
    if (page.res.status >= 400) {
      return err(new ConnectionError(`deployment HTTP ${page.res.status}`));
    }
    const parsed = parseDeploymentJson(page.html);
    if (!parsed) return err(new ConnectionError('deployment did not return Ready'));
    this.log.info('saas-web: deployment Ready', { runtimeId: parsed.runtimeId, host: new URL(parsed.clusterAddress).host });
    return ok(parsed);
  }

  async shareAuthCookie(
    jar: CookieJar,
    saas: SaasTarget,
    runtimeId: string,
    fceToken: string,
  ): Promise<Result<void, ConnectionError>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: saas.origin,
      Referer: saas.portalUrl,
    };
    if (fceToken) headers['FCE-CSRF-TOKEN'] = fceToken;
    const page = await this.request(jar, `${saas.portalUrl}/api/authcookie/setcookie`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ subPath: `/tenant/${runtimeId}` }),
    });
    if (page.res.status >= 400) {
      return err(new ConnectionError(`setcookie HTTP ${page.res.status}`));
    }
    return ok(undefined);
  }

  async authenticateToken(
    jar: CookieJar,
    clusterHost: string,
    runtimeId: string,
    tid: string,
    auth: FixedEndPointAuth,
  ): Promise<Result<string, ConnectionError>> {
    const qs = new URLSearchParams({ tenant: runtimeId, deviceCategory: '0' });
    if (tid) qs.set('tid', tid);
    const authUrl = `https://${clusterHost}/auth?${qs}`;
    this.log.info('saas-web: AUTHENTICATETOKEN', { hasAccess: Boolean(auth.accessToken), hasCode: Boolean(auth.authorizationCode) });
    const id = `|${randomUUID().replace(/-/g, '')}.${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const page = await this.request(jar, authUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: SAAS_PORTAL_ORIGIN,
        Referer: `${SAAS_PORTAL_ORIGIN}/`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'AUTHENTICATETOKEN',
        params: ['OAUTH', auth.accessToken, false, auth.authorizationCode, auth.homeAccountId, auth.sharedAuthCookieName],
        id,
      }),
    });
    if (page.res.status >= 400) {
      return err(new ConnectionError(`AUTHENTICATETOKEN HTTP ${page.res.status}`));
    }
    try {
      const rpc = JSON.parse(page.html) as { result?: { csrfToken?: string }; error?: { message?: string } };
      if (rpc.error) return err(new ConnectionError(`AUTHENTICATETOKEN ${rpc.error.message ?? 'rpc error'}`));
      return ok(rpc.result?.csrfToken ?? '');
    } catch {
      return err(new ConnectionError('AUTHENTICATETOKEN response was not JSON'));
    }
  }

  async mintTab(
    jar: CookieJar,
    clusterHost: string,
    runtimeId: string,
    portalUrl: string,
    csrfHint: string,
  ): Promise<Result<PreparedConnection, ConnectionError>> {
    const tabId = randomUUID();
    const tabBaseUrl = `https://${clusterHost}/tenant/${runtimeId}/tab/${tabId}`;
    const clusterHeaders = {
      Origin: SAAS_PORTAL_ORIGIN,
      Referer: portalUrl,
    };
    for (const path of ['/v', '/boot/browser/desktop']) {
      // Status-only checks: discard the body (the boot payload is the full
      // web-client bootstrap document — no reason to download it per mint).
      const page = await this.request(jar, `${tabBaseUrl}${path}`, { headers: clusterHeaders }, { discardBody: true });
      const dead = deadTabReason(page.res, tabBaseUrl);
      if (dead) return err(new DeadTabError(`tab ${path} ${dead}`));
    }
    const csrfPage = await this.request(jar, `${tabBaseUrl}/csrf`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...clusterHeaders },
    });
    const dead = deadTabReason(csrfPage.res, tabBaseUrl);
    if (dead) return err(new DeadTabError(`tab /csrf ${dead}`));
    let csrf = csrfHint;
    try {
      const j = JSON.parse(csrfPage.html) as { csrfToken?: string };
      if (j.csrfToken) csrf = j.csrfToken;
    } catch { /* cookie / hint */ }
    if (!csrf) {
      const header = jar.headerFor(tabBaseUrl);
      for (const part of header.split('; ')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) {
          csrf = part.slice(eq + 1);
          break;
        }
      }
    }
    this.log.info('saas-web: tab', { tabId });
    return ok({ tabId, tabBaseUrl, clusterHost, runtimeId, csrfToken: csrf });
  }

  private request(
    jar: CookieJar,
    url: string,
    init: RequestInit = {},
    opts: { discardBody?: boolean } = {},
  ): Promise<{ res: Response; html: string }> {
    return fetchWithJar(this.fetchFn, jar, url, init, opts);
  }
}
