import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { LoginWindow } from '../../src/connection/auth/saas/login-window.js';
import { CookieJar } from '../../src/connection/auth/saas/cookie-jar.js';
import { FileCookieStore, saasCookieStorePath } from '../../src/connection/auth/saas/cookie-store.js';
import { ClientElicitationPort } from '../../src/mcp/elicitation-port.js';
import { err, isErr, isOk, ok } from '../../src/core/result.js';
import { AuthenticationError, SignInRequiredError, UrlElicitationRequiredError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const PORTAL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;

describe('LoginWindow', () => {
  const windows: LoginWindow[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(windows.splice(0).map((w) => w.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeWindow(opts: {
    open: boolean | ((url: string) => boolean);
    urlElicitation?: boolean;
    passwordEcho?: string;
  }): LoginWindow {
    const dir = mkdtempSync(join(tmpdir(), 'bc-login-win-'));
    dirs.push(dir);
    const elicitation = new ClientElicitationPort();
    elicitation.url = opts.urlElicitation === true;
    const window = new LoginWindow({
      opener: {
        open: typeof opts.open === 'function' ? opts.open : () => opts.open === true,
      },
      portalUrl: PORTAL,
      stateDir: dir,
      aadTenantId: TENANT,
      environmentName: 'DEV',
      usernamePrefill: '<img src=x onerror=alert(1)>',
      timeoutMs: 8_000,
      closeDelayMs: 100,
      elicitation,
      logger: createNullLogger(),
      loginFn: async () => ok(undefined),
    });
    windows.push(window);
    return window;
  }

  it('run() opens http://127.0.0.1:{port}/?k= and binds 127.0.0.1', async () => {
    let opened = '';
    const window = makeWindow({
      open: (url) => {
        opened = url;
        return true;
      },
    });
    const runP = window.run();
    await vi.waitFor(() => expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=/));
    expect(window.boundAddress()).toBe('127.0.0.1');
    const href = new URL(opened);
    const k = href.search;
    const page = await fetch(href);
    const html = await page.text();
    expect(html).toContain('Sign in to Business Central');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');

    const noK = await fetch(`http://127.0.0.1:${window.boundPort()}/status`);
    expect(noK.status).toBe(404);

    const status = await fetch(`http://127.0.0.1:${window.boundPort()}/status${k}`);
    const body = await status.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('password');
    expect(JSON.stringify(body)).not.toContain('s3cret');

    const login = await fetch(`http://127.0.0.1:${window.boundPort()}/login${k}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 's3cretPASS' }),
    });
    expect(login.status).toBe(202);
    const loginText = await login.text();
    expect(loginText).toBe(JSON.stringify({ ok: true }));
    expect(loginText).not.toContain('s3cretPASS');

    const statusAfter = await fetch(`http://127.0.0.1:${window.boundPort()}/status${k}`);
    const afterText = await statusAfter.text();
    expect(afterText).not.toContain('s3cretPASS');

    const result = await runP;
    expect(isOk(result)).toBe(true);
  });

  it('opener false without elicitation is SignInRequiredError and does not include http://', async () => {
    const window = makeWindow({ open: false });
    const result = await window.run();
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(SignInRequiredError);
      expect(result.error.code).toBe('SIGN_IN_REQUIRED');
      expect((result.error as SignInRequiredError).reason).toBe('no_display');
      expect(result.error.message).not.toContain('http://');
    }
  });

  it('opener false with elicitation.url returns UrlElicitationRequiredError; second run does not rebind', async () => {
    const window = makeWindow({ open: false, urlElicitation: true });
    const first = await window.run();
    expect(isErr(first)).toBe(true);
    if (isErr(first)) {
      expect(first.error).toBeInstanceOf(UrlElicitationRequiredError);
      expect(first.error.code).toBe('URL_ELICITATION_REQUIRED');
      const elic = first.error as UrlElicitationRequiredError;
      expect(elic.elicitations[0]?.mode).toBe('url');
      expect(elic.elicitations[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    }
    const port = window.boundPort();
    const secondP = window.run();
    expect(window.boundPort()).toBe(port);
    const href = new URL(window.currentHref());
    await fetch(`${href.origin}/login${href.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 'x' }),
    });
    const second = await secondP;
    expect(isOk(second)).toBe(true);
  });

  it('loginFn mutates the injected jar (shared with the provider)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-login-jar-'));
    dirs.push(dir);
    const jar = new CookieJar();
    let opened = '';
    const window = new LoginWindow({
      opener: {
        open: (url) => {
          opened = url;
          return true;
        },
      },
      portalUrl: PORTAL,
      stateDir: dir,
      aadTenantId: TENANT,
      environmentName: 'DEV',
      timeoutMs: 8_000,
      closeDelayMs: 100,
      logger: createNullLogger(),
      jar,
      loginFn: async () => {
        jar.load([{
          name: `${TENANT}.auth`,
          value: 'from-login',
          domain: 'businesscentral.dynamics.com',
          path: '/',
          secure: true,
        }]);
        return ok(undefined);
      },
    });
    windows.push(window);
    const runP = window.run();
    await vi.waitFor(() => expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:/));
    const href = new URL(opened);
    await fetch(`${href.origin}/login${href.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 'x' }),
    });
    expect(isOk(await runP)).toBe(true);
    expect(jar.hasPortalAuth(TENANT)).toBe(true);
  });

  it('close() during loginFn does not let a late success finish a later run()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-login-stale-'));
    dirs.push(dir);
    const store = new FileCookieStore(saasCookieStorePath(dir));
    const jar = new CookieJar();
    let releaseLogin!: (value: ReturnType<typeof ok<undefined>>) => void;
    let loginStarted!: () => void;
    const started = new Promise<void>((resolve) => { loginStarted = resolve; });
    let loginCalls = 0;
    let opened = '';
    const window = new LoginWindow({
      opener: {
        open: (url) => {
          opened = url;
          return true;
        },
      },
      portalUrl: PORTAL,
      stateDir: dir,
      aadTenantId: TENANT,
      environmentName: 'DEV',
      timeoutMs: 8_000,
      closeDelayMs: 8_000,
      logger: createNullLogger(),
      jar,
      store,
      loginFn: () => {
        loginCalls += 1;
        if (loginCalls === 1) {
          loginStarted();
          return new Promise((resolve) => { releaseLogin = resolve; });
        }
        return Promise.resolve(ok(undefined));
      },
    });
    windows.push(window);

    const first = window.run();
    await vi.waitFor(() => expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:/));
    const href = new URL(opened);
    const login = await fetch(`${href.origin}/login${href.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 'x' }),
    });
    expect(login.status).toBe(202);
    await started;
    await window.close();

    opened = '';
    const second = window.run();
    await vi.waitFor(() => expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:/));
    releaseLogin(ok(undefined));

    const raced = await Promise.race([
      second.then((result) => ({ kind: 'done' as const, result })),
      new Promise<{ kind: 'pending' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'pending' }), 80);
      }),
    ]);
    expect(raced.kind).toBe('pending');
    expect(existsSync(saasCookieStorePath(dir))).toBe(false);

    const href2 = new URL(opened);
    await fetch(`${href2.origin}/login${href2.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 'x' }),
    });
    expect(isOk(await second)).toBe(true);
    void first;
  });

  it('close() rejects an in-flight OTP wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-login-otp-'));
    dirs.push(dir);
    let otpWait: Promise<string> | undefined;
    let opened = '';
    const window = new LoginWindow({
      opener: {
        open: (url) => {
          opened = url;
          return true;
        },
      },
      portalUrl: PORTAL,
      stateDir: dir,
      aadTenantId: TENANT,
      environmentName: 'DEV',
      timeoutMs: 8_000,
      closeDelayMs: 8_000,
      logger: createNullLogger(),
      loginFn: async ({ waitForOtp }) => {
        otpWait = waitForOtp!();
        try {
          await otpWait;
          return ok(undefined);
        } catch {
          return err(new AuthenticationError('otp cancelled'));
        }
      },
    });
    windows.push(window);

    void window.run();
    await vi.waitFor(() => expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:/));
    const href = new URL(opened);
    const login = await fetch(`${href.origin}/login${href.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u@t.com', password: 'x' }),
    });
    expect(login.status).toBe(202);
    await vi.waitFor(() => expect(otpWait).toBeDefined());
    await window.close();
    await expect(otpWait).rejects.toThrow();
  });
});
