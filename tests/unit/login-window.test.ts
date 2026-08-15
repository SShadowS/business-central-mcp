import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginWindow } from '../../src/connection/auth/saas/login-window.js';
import { ClientElicitationPort } from '../../src/mcp/elicitation-port.js';
import { isErr, isOk, ok } from '../../src/core/result.js';
import { SignInRequiredError, UrlElicitationRequiredError } from '../../src/core/errors.js';
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
});
