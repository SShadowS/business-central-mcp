import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../../../core/result.js';
import { AuthenticationError, ConnectionError } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import { isEntraLoginUrl, type SaasTarget } from '../../saas-url.js';
import { CookieJar } from './cookie-jar.js';
import { extractFceToken, extractFixedEndPointAuth, parseDeploymentJson, parseFixedEndPoint } from './html-extract.js';
import { redactingLogger } from './redact.js';
import {
  SAAS_BROWSER_UA,
  SAAS_PORTAL_ORIGIN,
  type DeploymentReady,
  type FixedEndPointAuth,
  type PreparedConnection,
} from './ests-types.js';

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
    const page = await this.request(jar, saas.portalUrl, {
      headers: { Origin: SAAS_PORTAL_ORIGIN, Referer: saas.portalUrl },
    });
    if (page.res.status >= 300 && page.res.status < 400) {
      const location = page.res.headers.get('location') ?? '';
      if (isEntraLoginUrl(location)) {
        return err(new AuthenticationError('Portal redirected to Entra sign-in'));
      }
    }
    const fp = parseFixedEndPoint(page.html);
    const auth = fp ? extractFixedEndPointAuth(fp) : {
      accessToken: '', authorizationCode: '', homeAccountId: '', sharedAuthCookieName: '',
    };
    this.log.info('saas-web: portal shell', { hasAccess: Boolean(auth.accessToken), hasCode: Boolean(auth.authorizationCode) });
    if (!auth.accessToken) {
      return err(new ConnectionError(
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
      const page = await this.request(jar, `${tabBaseUrl}${path}`, { headers: clusterHeaders });
      if (page.res.status === 401 || page.res.status === 403 || page.res.status === 500) {
        return err(new ConnectionError(`tab ${path} HTTP ${page.res.status}`));
      }
    }
    const csrfPage = await this.request(jar, `${tabBaseUrl}/csrf`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...clusterHeaders },
    });
    if (csrfPage.res.status === 401 || csrfPage.res.status === 403 || csrfPage.res.status === 500) {
      return err(new ConnectionError(`tab /csrf HTTP ${csrfPage.res.status}`));
    }
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

  private async request(jar: CookieJar, url: string, init: RequestInit = {}): Promise<{ res: Response; html: string }> {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', SAAS_BROWSER_UA);
    const cookie = jar.headerFor(url);
    if (cookie) headers.set('Cookie', cookie);
    const res = await this.fetchFn(url, { ...init, headers, redirect: 'manual' });
    jar.absorb(res, url);
    return { res, html: await res.text() };
  }
}
