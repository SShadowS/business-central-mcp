import { describe, it, expect, vi, afterEach } from 'vitest';
import { EstsLoginClient } from '../../src/connection/auth/saas/ests-login.js';
import { CookieJar } from '../../src/connection/auth/saas/cookie-jar.js';
import { isErr, isOk } from '../../src/core/result.js';
import type { Logger } from '../../src/core/logger.js';
import type { EstsStatus } from '../../src/connection/auth/saas/ests-types.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const PORTAL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
const AUTHORIZE = `https://login.microsoftonline.com/${TENANT}/oauth2/authorize`;
const LOGIN = `https://login.microsoftonline.com/${TENANT}/login`;
const GCT = 'https://login.microsoftonline.com/common/GetCredentialType?mkt=en-US';
const KMSI = `https://login.microsoftonline.com/kmsi`;
const BEGIN = 'https://login.microsoftonline.com/common/SAS/BeginAuth';
const END = 'https://login.microsoftonline.com/common/SAS/EndAuth';
const PROCESS = 'https://login.microsoftonline.com/common/SAS/ProcessAuth';
const REMOTE = 'https://businesscentral.dynamics.com/remote-sign-in';
const PASSWORD = 's3cretPASS';

function $config(over: Record<string, unknown> = {}): string {
  return `$Config=${JSON.stringify({
    sFT: 'ft',
    sCtx: 'ctx',
    canary: 'can',
    urlPost: `/${TENANT}/login`,
    urlGetCredentialType: GCT,
    sTenantId: TENANT,
    pgid: 'ConvergedSignIn',
    ...over,
  })}`;
}

function kmsiHtml(): string {
  return $config({ pgid: 'KmsiInterrupt', urlPost: '/kmsi' });
}

function formPostHtml(): string {
  return `<form action="${REMOTE}"><input name="code" value="abc"><input name="state" value="st"></form>`;
}

interface Step {
  urlMatch: string;
  method?: string;
  status: number;
  location?: string;
  setCookie?: string[];
  body?: string;
  onCall?: (url: string, init?: RequestInit) => void;
}

function scriptedFetch(steps: Step[]): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const step = steps[i++];
    if (!step) throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    if (!url.includes(step.urlMatch)) {
      throw new Error(`fetch #${i} expected url to include ${step.urlMatch}, got ${url}`);
    }
    if (step.method && (init?.method ?? 'GET').toUpperCase() !== step.method) {
      throw new Error(`fetch #${i} expected ${step.method}, got ${init?.method}`);
    }
    step.onCall?.(url, init);
    const headers = new Headers();
    if (step.location) headers.set('location', step.location);
    for (const c of step.setCookie ?? []) headers.append('set-cookie', c);
    return new Response(step.body ?? '', { status: step.status, headers });
  }) as typeof fetch;
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (msg: string, ctx?: Record<string, unknown>) => {
    lines.push(msg);
    if (ctx) lines.push(JSON.stringify(ctx));
  };
  return {
    lines,
    logger: {
      info: push,
      warn: push,
      error: push,
      debug: (_ch, msg, ctx) => push(msg, ctx),
    },
  };
}

function client(
  fetchFn: typeof fetch,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number; onStatus?: (s: EstsStatus) => void },
) {
  const jar = new CookieJar();
  const cap = capturingLogger();
  const statuses: EstsStatus[] = [];
  const ests = new EstsLoginClient(
    fetchFn,
    jar,
    cap.logger,
    (s) => {
      statuses.push(s);
      opts?.onStatus?.(s);
    },
    opts?.sleep ?? (async () => undefined),
    opts?.now,
  );
  return { ests, jar, cap, statuses };
}

const happyAfterPassword: Step[] = [
  { urlMatch: 'login.microsoftonline.com', method: 'POST', status: 200, body: kmsiHtml() },
  { urlMatch: '/kmsi', method: 'POST', status: 200, body: formPostHtml() },
  {
    urlMatch: 'remote-sign-in',
    method: 'POST',
    status: 302,
    location: PORTAL,
    setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
  },
  { urlMatch: PORTAL, status: 200, body: '<html>ok</html>' },
];

describe('EstsLoginClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: portal → authorize → password → KMSI → form_post → .auth', async () => {
    const fetchFn = scriptedFetch([
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      ...happyAfterPassword,
    ]);
    const { ests, jar } = client(fetchFn);
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('MFA number matching: BeginAuth entropy then EndAuth success', async () => {
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success', Entropy: 42, CorrelationId: 'corr' }) },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: false, ResultValue: 'PendingAuthentication' }) },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar, statuses } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
    expect(statuses.some((s) => s.entropy === '42')).toBe(true);
  });

  it('MFA push surfaces a failed BeginAuth instead of polling EndAuth', async () => {
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
        }),
      },
      {
        urlMatch: 'BeginAuth',
        method: 'POST',
        status: 200,
        body: JSON.stringify({
          Success: false,
          ResultValue: 'AuthMethodFailed',
          Message: 'Authentication method is temporarily unavailable',
        }),
      },
      // No EndAuth steps: a failed BeginAuth must not be polled.
    ];
    let now = 0;
    const { ests } = client(scriptedFetch(steps), {
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain('BeginAuth');
      expect(result.error.message).toContain('temporarily unavailable');
    }
  });

  it('MFA push retries BeginAuth once on Retry:true instead of polling a session that never began', async () => {
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      // A throttled BeginAuth (Retry:true) carries no CorrelationId — polling
      // EndAuth against it would use an undefined SessionId for 90s. The
      // client must re-run BeginAuth itself.
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: false, Retry: true }) },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success', CorrelationId: 'corr' }) },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('MFA push treats BeginAuth PendingAuthentication as in-progress and keeps polling', async () => {
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: false, ResultValue: 'PendingAuthentication', CorrelationId: 'corr' }) },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('MFA push reports a sustained BeginAuth throttle as throttled, not "unknown error"', async () => {
    const throttled = JSON.stringify({ Success: false, Retry: true });
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
    ];
    const { ests } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/throttl/i);
  });

  it('MFA push proceeds to EndAuth polling when BeginAuth carries a CorrelationId, whatever the ResultValue', async () => {
    // ESTS's ResultValue vocabulary is large and undocumented; a present
    // CorrelationId means the auth session began, so polling must judge it.
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: false, ResultValue: 'AwaitingAuthentication', CorrelationId: 'corr' }) },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('TOTP sign-in proceeds to the code prompt even when BeginAuth stays throttled', async () => {
    // The OTP EndAuth body carries no SessionId, so a failed/throttled
    // BeginAuth must not dead-end the flow — the code prompt plus EndAuth can
    // still complete it, exactly as the pre-gate flow did.
    const throttled = JSON.stringify({ Success: false, Retry: true });
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppOTP' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: throttled },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar } = client(scriptedFetch(steps));
    const result = await ests.login({
      username: 'u@t.com',
      password: PASSWORD,
      portalUrl: PORTAL,
      waitForOtp: async () => '123456',
    });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('MFA push tolerates a non-JSON BeginAuth body and still completes via EndAuth', async () => {
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: '<html>proxy error</html>' },
      { urlMatch: 'EndAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, ResultValue: 'Success' }) },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests, jar } = client(scriptedFetch(steps));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('MFA timeout after 90s of fake time', async () => {
    let now = 0;
    const pending = JSON.stringify({ Success: false, ResultValue: 'PendingAuthentication' });
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppNotification' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true, Entropy: 1 }) },
    ];
    for (let i = 0; i < 50; i++) {
      steps.push({ urlMatch: 'EndAuth', method: 'POST', status: 200, body: pending });
    }
    const { ests } = client(scriptedFetch(steps), {
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/timed out/i);
  });

  it('returns Entra sErrTxt and never includes the password', async () => {
    const { ests, cap } = client(scriptedFetch([
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({ sErrTxt: 'Your account or password is incorrect.' }),
      },
    ]));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain('incorrect');
      expect(result.error.message).not.toContain(PASSWORD);
    }
    expect(cap.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('sends passwd in the ESTS body and redacts it from the logger', async () => {
    let loginBody = '';
    const { ests, cap } = client(scriptedFetch([
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: kmsiHtml(),
        onCall: (_url, init) => { loginBody = String(init?.body ?? ''); },
      },
      { urlMatch: '/kmsi', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ]));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isOk(result)).toBe(true);
    expect(loginBody).toContain(`passwd=${encodeURIComponent(PASSWORD)}`);
    expect(cap.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('errors when still on ESTS after drain', async () => {
    const { ests } = client(scriptedFetch([
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      { urlMatch: LOGIN, method: 'POST', status: 200, body: $config({ pgid: 'ConvergedSignIn' }) },
    ]));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/still on Entra|ConvergedSignIn/i);
  });

  it('errors when redirect hops exceed the cap', async () => {
    const hops: Step[] = [{ urlMatch: PORTAL, status: 302, location: `${AUTHORIZE}?n=0` }];
    for (let i = 0; i < 10; i++) {
      hops.push({ urlMatch: 'login.microsoftonline.com', status: 302, location: `${AUTHORIZE}?n=${i + 1}` });
    }
    const { ests } = client(scriptedFetch(hops));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/redirect/i);
  });

  it('TOTP uses waitForOtp and never reads BC_MFA_CODE', async () => {
    const envSpy = vi.spyOn(process, 'env', 'get');
    let endBody = '';
    const steps: Step[] = [
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppOTP' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
          urlPost: PROCESS,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true }) },
      {
        urlMatch: 'EndAuth',
        method: 'POST',
        status: 200,
        body: JSON.stringify({ Success: true, ResultValue: 'Success' }),
        onCall: (_url, init) => { endBody = String(init?.body ?? ''); },
      },
      { urlMatch: 'ProcessAuth', method: 'POST', status: 200, body: formPostHtml() },
      {
        urlMatch: 'remote-sign-in',
        method: 'POST',
        status: 302,
        location: PORTAL,
        setCookie: [`${TENANT}.auth=ok; Path=/; Secure`],
      },
      { urlMatch: PORTAL, status: 200, body: 'ok' },
    ];
    const { ests } = client(scriptedFetch(steps));
    const result = await ests.login({
      username: 'u@t.com',
      password: PASSWORD,
      portalUrl: PORTAL,
      waitForOtp: async () => '123456',
    });
    expect(isOk(result)).toBe(true);
    expect(endBody).toContain('123456');
    expect(envSpy).not.toHaveBeenCalled();
    envSpy.mockRestore();
  });

  it('TOTP without waitForOtp returns AuthenticationError', async () => {
    const { ests } = client(scriptedFetch([
      { urlMatch: PORTAL, status: 302, location: AUTHORIZE },
      { urlMatch: AUTHORIZE, status: 200, body: $config() },
      { urlMatch: 'GetCredentialType', method: 'POST', status: 200, body: '{}' },
      {
        urlMatch: LOGIN,
        method: 'POST',
        status: 200,
        body: $config({
          pgid: 'ConvergedTFA',
          arrUserProofs: [{ authMethodId: 'PhoneAppOTP' }],
          urlBeginAuth: BEGIN,
          urlEndAuth: END,
        }),
      },
      { urlMatch: 'BeginAuth', method: 'POST', status: 200, body: JSON.stringify({ Success: true }) },
    ]));
    const result = await ests.login({ username: 'u@t.com', password: PASSWORD, portalUrl: PORTAL });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/waitForOtp/i);
  });
});
