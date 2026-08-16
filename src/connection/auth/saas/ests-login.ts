import { err, ok, type Result } from '../../../core/result.js';
import { AuthenticationError } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import { parseSaasUrl } from '../../saas-url.js';
import { CookieJar } from './cookie-jar.js';
import {
  extractForm,
  isRemoteSignIn,
  pageInfo,
  parseConfig,
} from './html-extract.js';
import { redactingLogger } from './redact.js';
import { SAAS_BROWSER_UA, type EstsStatus, type SasJson } from './ests-types.js';

const ESTS_ORIGIN = 'https://login.microsoftonline.com';
const MAX_REDIRECTS = 8;
const MFA_POLL_MS = 2000;
const MFA_TIMEOUT_MS = 90_000;

type FetchFn = typeof fetch;
type Sleeper = (ms: number) => Promise<void>;

interface Page {
  res: Response;
  html: string;
  url: string;
}



function str(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  return typeof v === 'string' ? v : '';
}

function absUrl(url: string, base: string): string {
  return new URL(url, base).toString();
}

function looksLikeMfa(html: string): boolean {
  const info = pageInfo(html);
  if (info.proofs.length > 0) return true;
  const id = `${info.pgid} ${info.hpgid}`.toLowerCase();
  return /tfa|sas|mfa|authmethod|convergedtfa|phoneapp/i.test(id);
}

function looksLikeKmsi(html: string): boolean {
  return /kmsi/i.test(pageInfo(html).pgid) || /kmsi/i.test(html.slice(0, 4000));
}

export class EstsLoginClient {
  private readonly log: Logger;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly jar: CookieJar,
    logger: Logger,
    private readonly onStatus: (s: EstsStatus) => void,
    private readonly sleep: Sleeper,
    private readonly now: () => number = Date.now,
  ) {
    this.log = redactingLogger(logger);
  }

  async login(opts: {
    username: string;
    password: string;
    portalUrl: string;
    waitForOtp?: () => Promise<string>;
  }): Promise<Result<void, AuthenticationError>> {
    const saas = parseSaasUrl(opts.portalUrl.replace(/\/+$/, ''));
    if (!saas) {
      return err(new AuthenticationError('not a SaaS portal URL', { nonRetryable: true }));
    }
    this.log.info('saas-web: ESTS phase=signing-in');
    this.onStatus({ phase: 'signing-in', message: 'Contacting Microsoft sign-in…' });
    try {
      await this.loginInner(opts.username, opts.password, saas.portalUrl, saas.aadTenantId, opts.waitForOtp);
      if (!this.jar.hasPortalAuth()) {
        return err(new AuthenticationError('ESTS finished without a portal session cookie', { nonRetryable: true }));
      }
      this.log.info('saas-web: ESTS phase=done');
      this.onStatus({ phase: 'done', message: 'Signed in.' });
      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.onStatus({ phase: 'error', message });
      // A typed AuthenticationError keeps its own retryability (e.g. the MFA
      // throttle is retryable); everything else is a hard sign-in failure.
      if (e instanceof AuthenticationError) return err(e);
      return err(new AuthenticationError(message, { nonRetryable: true }));
    }
  }

  private async loginInner(
    username: string,
    password: string,
    portalUrl: string,
    _aadTenantId: string,
    waitForOtp?: () => Promise<string>,
  ): Promise<void> {
    let page = await this.request(portalUrl);
    page = await this.followRedirects(page);
    if (!page.url.includes('login.microsoftonline.com') && !parseConfig(page.html)) {
      throw new Error('portal did not redirect to Entra authorize');
    }
    const cfg = parseConfig(page.html);
    if (!cfg) throw new Error('no $Config on Entra login page');

    const gctUrl = str(cfg, 'urlGetCredentialType') || `${ESTS_ORIGIN}/common/GetCredentialType?mkt=en-US`;
    await this.request(gctUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username,
        isOtherIdpSupported: true,
        checkPhones: false,
        isRemoteNGCSupported: true,
        isCookieBannerShown: false,
        isFidoSupported: true,
        originalRequest: str(cfg, 'sCtx'),
        flowToken: str(cfg, 'sFT'),
      }),
    });

    this.onStatus({ phase: 'signing-in', message: 'Checking password…' });
    const postUrl = absUrl(str(cfg, 'urlPost'), ESTS_ORIGIN);
    page = await this.request(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: ESTS_ORIGIN,
        Referer: page.url,
      },
      body: new URLSearchParams({
        login: username,
        loginfmt: username,
        passwd: password,
        PPFT: str(cfg, 'sFT'),
        PPSX: 'PassportRN',
        canary: str(cfg, 'canary'),
        ctx: str(cfg, 'sCtx'),
        hpgrequestid: '',
        flowToken: str(cfg, 'sFT'),
        NewUser: '1',
        FoundMSAs: '',
        fspost: '0',
        i21: '0',
        CookieDisclosure: '0',
        IsFidoSupported: '1',
        isSignupPost: '0',
        i13: '0',
        type: '11',
        LoginOptions: '3',
        lrt: '',
        lrtPartition: '',
        hisRegion: '',
        hisScaleUnit: '',
      }).toString(),
    });
    page = await this.followRedirects(page);
    page = await this.drainInterrupts(page, username, waitForOtp);

    const signed = extractForm(page.html);
    if (signed && isRemoteSignIn(signed)) {
      this.onStatus({ phase: 'finishing', message: 'Opening Business Central…' });
      page = await this.finishOidc(page);
    }

    const leftover = pageInfo(page.html);
    if (leftover.err) {
      throw new Error(leftover.err);
    }
    if (page.url.includes('login.microsoftonline.com') && parseConfig(page.html) && !extractForm(page.html)?.fields['code']) {
      throw new Error(`still on Entra (${leftover.pgid || 'unknown page'})`);
    }
  }

  private async drainInterrupts(
    start: Page,
    username: string,
    waitForOtp?: () => Promise<string>,
  ): Promise<Page> {
    let page = start;
    for (let i = 0; i < 10; i++) {
      const form = extractForm(page.html);
      if (form && isRemoteSignIn(form)) {
        return this.finishOidc(page);
      }
      const info = pageInfo(page.html);
      if (info.err) throw new Error(info.err);
      if (looksLikeKmsi(page.html)) {
        page = await this.postKmsi(page);
        continue;
      }
      if (looksLikeMfa(page.html)) {
        page = await this.completeMfa(page, username, waitForOtp);
        continue;
      }
      return page;
    }
    throw new Error('too many Entra interrupts');
  }

  private async postKmsi(page: Page): Promise<Page> {
    const cfg = parseConfig(page.html);
    if (!cfg) throw new Error('KMSI page has no $Config');
    const action = absUrl(str(cfg, 'urlPost') || '/kmsi', page.url);
    const next = await this.postForm(action, {
      LoginOptions: '1',
      type: '28',
      ctx: str(cfg, 'sCtx'),
      hpgrequestid: '',
      flowToken: str(cfg, 'sFT'),
      canary: str(cfg, 'canary'),
      i19: '',
    }, page.url);
    return this.followRedirects(next);
  }

  private async completeMfa(
    page: Page,
    username: string,
    waitForOtp?: () => Promise<string>,
  ): Promise<Page> {
    const cfg = parseConfig(page.html);
    if (!cfg) throw new Error('MFA page has no $Config');
    const info = pageInfo(page.html);
    const beginUrl = str(cfg, 'urlBeginAuth') || `${ESTS_ORIGIN}/common/SAS/BeginAuth`;
    const endUrl = str(cfg, 'urlEndAuth') || `${ESTS_ORIGIN}/common/SAS/EndAuth`;
    const processUrl = str(cfg, 'urlPost') ? absUrl(str(cfg, 'urlPost'), page.url) : `${ESTS_ORIGIN}/common/SAS/ProcessAuth`;

    const preferred = info.proofs.includes('PhoneAppNotification')
      ? 'PhoneAppNotification'
      : info.proofs.includes('PhoneAppOTP')
        ? 'PhoneAppOTP'
        : info.proofs[0] || 'PhoneAppNotification';

    let flowToken = str(cfg, 'sFT');
    let ctx = str(cfg, 'sCtx');

    if (preferred === 'PhoneAppNotification') {
      // Push needs an auth session to poll (EndAuth's SessionId is
      // began.CorrelationId), so BeginAuth is retried on Retry:true
      // (throttle) and an explicit rejection WITHOUT a CorrelationId fails
      // fast — polling would run 90s against an undefined SessionId. The
      // presence test is deliberately vocabulary-free (ESTS's ResultValue
      // set is large and undocumented; the EndAuth poll judges everything
      // else), and an unparseable body ({} from sasPost) falls through.
      // Known trade-off: a hard failure that carries a request-correlation
      // id proceeds to polling, where EndAuth's own error handling (or the
      // 90s cap) judges it — no reliable wire signal distinguishes a
      // session id from a trace id.
      let began: SasJson;
      for (let attempt = 0; ; attempt++) {
        began = await this.sasPost(beginUrl, {
          AuthMethodId: preferred,
          Method: 'BeginAuth',
          ctx,
          flowToken,
        });
        if (began.FlowToken) flowToken = began.FlowToken;
        if (began.Ctx) ctx = began.Ctx;
        if (began.Success !== false || began.Retry !== true || attempt >= 2) break;
        await this.sleep(MFA_POLL_MS);
      }
      if (began.Success === false && !began.CorrelationId) {
        if (began.Retry) {
          // A throttle clears in seconds — surface it retryable, not as a
          // terminal auth failure the user must restart sign-in over.
          // (login()'s catch preserves AuthenticationError instances; one
          // without nonRetryable stays retryable in SessionManager.)
          throw new AuthenticationError('MFA BeginAuth failed: throttled by Entra (retries exhausted); retry shortly');
        }
        throw new Error(`MFA BeginAuth failed: ${began.Message ?? began.ResultValue ?? 'unknown error'}`);
      }
      const entropy = began.Entropy !== undefined && began.Entropy !== '' ? String(began.Entropy) : '';
      this.onStatus({
        phase: 'mfa',
        entropy: entropy || undefined,
        message: entropy ? `Pick ${entropy} in Microsoft Authenticator` : 'Approve the sign-in in Microsoft Authenticator',
      });
      const deadline = this.now() + MFA_TIMEOUT_MS;
      let last = began;
      while (this.now() < deadline) {
        await this.sleep(MFA_POLL_MS);
        last = await this.sasPost(endUrl, {
          AuthMethodId: preferred,
          Method: 'EndAuth',
          SessionId: began.CorrelationId,
          ctx,
          flowToken,
        });
        if (last.FlowToken) flowToken = last.FlowToken;
        if (last.Ctx) ctx = last.Ctx;
        const result = last.ResultValue ?? '';
        if (last.Success === true || result === 'Success') break;
        if (result && result !== 'PendingAuthentication' && !last.Retry) {
          throw new Error(`MFA EndAuth: ${result} ${last.Message ?? ''}`);
        }
      }
      if (last.Success !== true && last.ResultValue !== 'Success') {
        throw new Error('MFA push timed out (90s)');
      }
    } else {
      if (!waitForOtp) {
        throw new Error('TOTP required but no waitForOtp was provided');
      }
      // A single ungated BeginAuth: OTP's EndAuth carries no SessionId, so a
      // failed or throttled BeginAuth must not dead-end the flow — only the
      // refreshed flowToken/ctx are consumed, and the code prompt plus
      // EndAuth judge the sign-in.
      const began = await this.sasPost(beginUrl, {
        AuthMethodId: preferred,
        Method: 'BeginAuth',
        ctx,
        flowToken,
      });
      if (began.FlowToken) flowToken = began.FlowToken;
      if (began.Ctx) ctx = began.Ctx;
      this.onStatus({ phase: 'mfa', message: 'Enter the code from Authenticator' });
      let code = await waitForOtp();
      if (!code) throw new Error('empty MFA code');
      const ended = await this.sasPost(endUrl, {
        AuthMethodId: preferred,
        Method: 'EndAuth',
        AdditionalAuthData: code,
        ctx,
        flowToken,
      });
      code = '';
      if (ended.FlowToken) flowToken = ended.FlowToken;
      if (ended.Ctx) ctx = ended.Ctx;
      if (ended.Success !== true && ended.ResultValue !== 'Success') {
        throw new Error(`MFA rejected: ${ended.ResultValue ?? ended.Message ?? 'unknown'}`);
      }
    }

    const processed = await this.postForm(processUrl, {
      type: '19',
      request: ctx,
      mfaAuthMethod: preferred,
      login: username,
      flowToken,
      canary: str(cfg, 'canary'),
      hpgrequestid: '',
      ctx,
    }, page.url);
    return this.followRedirects(processed);
  }

  private async finishOidc(page: Page): Promise<Page> {
    const form = extractForm(page.html);
    if (!form || !isRemoteSignIn(form)) return page;
    this.onStatus({ phase: 'finishing', message: 'Opening Business Central…' });
    const action = absUrl(form.action, 'https://businesscentral.dynamics.com');
    const rs = await this.postForm(action, form.fields, page.url);
    return this.followRedirects(rs);
  }

  private async postForm(action: string, fields: Record<string, string>, referer: string): Promise<Page> {
    return this.request(action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(action).origin,
        Referer: referer,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  private async sasPost(url: string, body: Record<string, unknown>): Promise<SasJson> {
    const page = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return JSON.parse(page.html) as SasJson;
    } catch {
      return {};
    }
  }

  private async followRedirects(page: Page): Promise<Page> {
    let cur = page;
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const next = cur.res.headers.get('location');
      if (!(cur.res.status >= 300 && cur.res.status < 400 && next)) return cur;
      cur = await this.request(absUrl(next, cur.url));
    }
    if (cur.res.status >= 300 && cur.res.status < 400 && cur.res.headers.get('location')) {
      throw new Error('too many redirects');
    }
    return cur;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Page> {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', SAAS_BROWSER_UA);
    const cookie = this.jar.headerFor(url);
    if (cookie) headers.set('Cookie', cookie);
    const res = await this.fetchFn(url, { ...init, headers, redirect: 'manual' });
    this.jar.absorb(res, url);
    const html = await res.text();
    return { res, html, url };
  }
}
