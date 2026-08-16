import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { err, isErr, ok, type Result } from '../../../core/result.js';
import {
  AuthenticationError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import type { ClientElicitationPort } from '../../../mcp/elicitation-port.js';
import { CookieJar } from './cookie-jar.js';
import { FileCookieStore, saasCookieStorePath } from './cookie-store.js';
import { EstsLoginClient } from './ests-login.js';
import { renderLoginPage } from './login-page.js';
import { OtpGate } from './otp-gate.js';
import type { BrowserOpener } from './browser-opener.js';
import type { EstsStatus } from './ests-types.js';

const BODY_LIMIT = 8192;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CLOSE_DELAY_MS = 1500;

export type LoginWindowResult = Result<
  void,
  SignInRequiredError | UrlElicitationRequiredError | AuthenticationError
>;

export type LoginFn = (opts: {
  username: string;
  password: string;
  waitForOtp?: () => Promise<string>;
}) => Promise<Result<void, AuthenticationError>>;

export interface LoginWindowOptions {
  opener: BrowserOpener;
  portalUrl: string;
  stateDir: string;
  aadTenantId: string;
  environmentName: string;
  usernamePrefill?: string;
  timeoutMs?: number;
  closeDelayMs?: number;
  elicitation?: ClientElicitationPort;
  fetchFn?: typeof fetch;
  logger: Logger;
  loginFn?: LoginFn;
  jar?: CookieJar;
  store?: FileCookieStore;
}

/**
 * Process-singleton loopback sign-in window. Binds 127.0.0.1 only.
 * Password exists only in the POST body and the in-memory ESTS /login call.
 */
export class LoginWindow {
  private server: Server | undefined;
  private k = '';
  private elicitationId = '';
  private href = '';
  private status: EstsStatus & { busy?: boolean } = {
    phase: 'signing-in',
    message: 'Waiting for sign-in…',
    busy: false,
  };
  private readonly otp = new OtpGate();
  private readonly jar: CookieJar;
  private readonly store: FileCookieStore;
  private readonly loginFn: LoginFn;
  private waiters: Array<(result: LoginWindowResult) => void> = [];
  private completed: LoginWindowResult | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private listening: Promise<void> | undefined;
  private openAttempted = false;
  private generation = 0;

  constructor(private readonly opts: LoginWindowOptions) {
    this.jar = opts.jar ?? new CookieJar();
    this.store = opts.store ?? new FileCookieStore(saasCookieStorePath(opts.stateDir));
    this.loginFn = opts.loginFn ?? ((loginOpts) => {
      const client = new EstsLoginClient(
        opts.fetchFn ?? fetch,
        this.jar,
        opts.logger,
        (s) => { this.status = { ...this.status, ...s }; },
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
      return client.login({
        username: loginOpts.username,
        password: loginOpts.password,
        portalUrl: opts.portalUrl,
        waitForOtp: loginOpts.waitForOtp,
      });
    });
  }

  async run(): Promise<LoginWindowResult> {
    if (this.completed) return this.completed;
    await this.ensureListening();
    if (this.completed) return this.completed;

    if (!this.openAttempted) {
      this.openAttempted = true;
      const opened = this.opts.opener.open(this.href);
      if (!opened) {
        if (this.opts.elicitation?.url) {
          return err(new UrlElicitationRequiredError([{
            mode: 'url',
            elicitationId: this.elicitationId,
            url: this.href,
            message: 'Sign in to Business Central in the window that opened.',
          }]));
        }
        const failure = err(new SignInRequiredError(
          'A display is required to sign in to Business Central Online.',
          { openedWindow: false, reason: 'no_display' },
        ));
        this.finish(failure);
        return failure;
      }
    }

    return this.waitForDone();
  }

  boundAddress(): string | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.address : undefined;
  }

  boundPort(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  currentHref(): string {
    return this.href;
  }

  async close(): Promise<void> {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.timeout = undefined;
    this.closeTimer = undefined;
    this.generation += 1;
    this.otp.reset();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    this.openAttempted = false;
    this.completed = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async ensureListening(): Promise<void> {
    if (this.server) return;
    if (this.listening) return this.listening;
    this.listening = this.listen();
    await this.listening;
  }

  private async listen(): Promise<void> {
    this.k = randomBytes(32).toString('base64url');
    this.elicitationId = randomUUID();
    this.openAttempted = false;
    this.completed = undefined;
    this.status = { phase: 'signing-in', message: 'Waiting for sign-in…', busy: false };
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('login window failed to bind 127.0.0.1');
    }
    this.href = `http://127.0.0.1:${addr.port}/?k=${this.k}`;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeout = setTimeout(() => {
      this.finish(err(new SignInRequiredError(
        'Sign-in timed out.',
        { openedWindow: true, reason: 'timeout' },
      )));
    }, timeoutMs);
  }

  private waitForDone(): Promise<LoginWindowResult> {
    if (this.completed) return Promise.resolve(this.completed);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private finish(result: LoginWindowResult): void {
    if (this.completed) return;
    this.completed = result;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(result);
    const delay = this.opts.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS;
    if (delay <= 0) {
      void this.close();
      return;
    }
    this.closeTimer = setTimeout(() => { void this.close(); }, delay);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (url.searchParams.get('k') === this.k) return true;
    const cookie = req.headers.cookie ?? '';
    return cookie.split(';').some((part) => part.trim() === `login_k=${this.k}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!this.authorized(req, url)) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const page = renderLoginPage(this.opts.usernamePrefill ?? '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `login_k=${this.k}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(page);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      this.json(res, 200, {
        phase: this.status.phase,
        entropy: this.status.entropy,
        message: this.status.message,
        busy: this.status.busy === true,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      await this.handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mfa-code') {
      await this.handleMfaCode(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.status.busy) {
      this.json(res, 409, { message: 'Sign-in already in progress' });
      return;
    }
    let body: { username?: string; password?: string };
    try {
      body = JSON.parse(await readBody(req)) as { username?: string; password?: string };
    } catch {
      this.json(res, 400, { message: 'Bad JSON' });
      return;
    }
    const username = (body.username ?? '').trim();
    let password = body.password ?? '';
    if (!username || !password) {
      this.json(res, 400, { message: 'Email and password required' });
      return;
    }
    this.status.busy = true;
    this.json(res, 202, { ok: true });
    const generation = this.generation;
    const result = await this.loginFn({
      username,
      password,
      waitForOtp: () => this.otp.wait(),
    });
    password = '';
    body.password = '';
    if (generation !== this.generation) return;
    this.status.busy = false;
    if (isErr(result)) {
      // Do NOT finish(): the page re-shows the form on phase 'error' so the
      // user can correct a typoed password against the still-open loopback
      // server. run() stays parked in waitForDone(); the overall sign-in
      // timeout still bounds the wait with SIGN_IN_REQUIRED.
      this.status = { phase: 'error', message: result.error.message, busy: false };
      return;
    }
    this.store.save(this.opts.aadTenantId, this.opts.environmentName, this.jar.persistable());
    this.status = { phase: 'done', message: 'Signed in.', busy: false };
    this.finish(ok(undefined));
  }

  private async handleMfaCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { code?: string };
    try {
      body = JSON.parse(await readBody(req)) as { code?: string };
    } catch {
      this.json(res, 400, { message: 'Bad JSON' });
      return;
    }
    const code = (body.code ?? '').trim();
    body.code = '';
    if (!code) {
      this.json(res, 400, { message: 'code required' });
      return;
    }
    this.otp.provide(code);
    this.json(res, 202, { ok: true });
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
