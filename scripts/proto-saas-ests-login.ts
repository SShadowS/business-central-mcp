/**
 * Prototype (2) — act like the browser's network stack, no Chromium.
 *
 * Cookie jar: portal → Entra authorize → GetCredentialType → POST /login
 * → KMSI / MFA (Authenticator push or TOTP) → form_post /remote-sign-in
 * → portal HTML → appservices tab → /csh.
 *
 *   BC_USERNAME=you@tenant.com BC_PASSWORD='…' npx tsx scripts/proto-saas-ests-login.ts
 *
 * Password is never printed. Authenticator push: approve the number printed
 * on stderr. TOTP: set BC_MFA_CODE or type it when prompted.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { requireBaseUrl } from './proto-env.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ESTS = 'https://login.microsoftonline.com';
const COOKIE_FILE = resolve(process.env.STATE_DIR || './.state', 'proto-ests-cookies.json');

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

class CookieJar {
  private map = new Map<string, string>();

  absorb(res: Response): void {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const header of set) {
      const nv = header.split(';')[0];
      if (!nv) continue;
      const eq = nv.indexOf('=');
      if (eq < 0) continue;
      this.map.set(nv.slice(0, eq), nv.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  names(): string[] {
    return [...this.map.keys()];
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  load(obj: Record<string, string>): void {
    for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
  }
}

function saveJar(jar: CookieJar): void {
  mkdirSync(resolve(COOKIE_FILE, '..'), { recursive: true });
  writeFileSync(COOKIE_FILE, JSON.stringify(jar.toJSON()), { encoding: 'utf8', mode: 0o600 });
}

function loadJar(): CookieJar | undefined {
  try {
    const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf8')) as Record<string, string>;
    if (!raw || typeof raw !== 'object') return undefined;
    const jar = new CookieJar();
    jar.load(raw);
    return jar;
  } catch {
    return undefined;
  }
}

function parseBalancedObject(src: string, from: number): Record<string, unknown> | undefined {
  const start = src.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, j + 1)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function parseConfig(html: string): Record<string, unknown> | undefined {
  const i = html.indexOf('$Config=');
  if (i < 0) return undefined;
  return parseBalancedObject(html, i);
}

function parseFixedEndPoint(html: string): Record<string, unknown> | undefined {
  const i = html.indexOf('FixedEndPoint.start(');
  if (i < 0) return undefined;
  return parseBalancedObject(html, i);
}

function str(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  return typeof v === 'string' ? v : '';
}

function absUrl(url: string, base: string): string {
  return new URL(url, base).toString();
}

function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tag.match(/\bname\s*=\s*["']([^"']*)["']/i)?.[1];
    const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    if (name) fields[decodeHtml(name)] = decodeHtml(value);
  }
  return fields;
}

function extractForm(html: string): { action: string; fields: Record<string, string> } | undefined {
  const actionRaw = html.match(/<form\b[^>]*\baction\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!actionRaw) return undefined;
  return { action: decodeHtml(actionRaw), fields: extractInputs(html) };
}

function isRemoteSignIn(form: { action: string; fields: Record<string, string> }): boolean {
  return form.action.includes('remote-sign-in') || 'code' in form.fields;
}

interface Page {
  res: Response;
  html: string;
  url: string;
}

async function request(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Page> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', UA);
  const cookie = jar.header();
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  jar.absorb(res);
  const html = await res.text();
  return { res, html, url };
}

async function followRedirects(jar: CookieJar, page: Page, hops = 8): Promise<Page> {
  let cur = page;
  for (let i = 0; i < hops; i++) {
    const next = cur.res.headers.get('location');
    if (!(cur.res.status >= 300 && cur.res.status < 400 && next)) break;
    const abs = absUrl(next, cur.url);
    log(`  follow ${cur.res.status} → ${abs.split('?')[0]}`);
    cur = await request(jar, abs);
  }
  return cur;
}

function csrfFrom(header: string): string {
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) return part.slice(eq + 1);
  }
  return '';
}

function probeWs(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(url, { headers });
    const done = (d: string) => { try { ws.close(); } catch { /* */ } resolveWs(d); };
    ws.on('open', () => done('OPEN 101'));
    ws.on('unexpected-response', (_req, res) => done(`REJECTED HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`ERROR ${e.message}`));
    setTimeout(() => done('TIMEOUT'), 10_000);
  });
}

function pageInfo(html: string): { pgid: string; hpgid: string; err: string; proofs: string[] } {
  const cfg = parseConfig(html);
  if (!cfg) return { pgid: '', hpgid: '', err: '', proofs: [] };
  const proofs: string[] = [];
  const arr = cfg['arrUserProofs'];
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (p && typeof p === 'object' && 'authMethodId' in p) {
        proofs.push(String((p as { authMethodId: unknown }).authMethodId));
      }
    }
  }
  return {
    pgid: str(cfg, 'pgid'),
    hpgid: String(cfg['hpgid'] ?? ''),
    err: str(cfg, 'sErrTxt'),
    proofs,
  };
}

async function postForm(
  jar: CookieJar,
  action: string,
  fields: Record<string, string>,
  referer: string,
): Promise<Page> {
  return request(jar, action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: new URL(action).origin,
      Referer: referer,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function postKmsi(jar: CookieJar, page: Page): Promise<Page> {
  const cfg = parseConfig(page.html);
  if (!cfg) throw new Error('KMSI page has no $Config');
  const action = absUrl(str(cfg, 'urlPost') || '/kmsi', page.url);
  log(`POST KMSI ${action.split('?')[0]}`);
  const next = await postForm(jar, action, {
    LoginOptions: '1',
    type: '28',
    ctx: str(cfg, 'sCtx'),
    hpgrequestid: '',
    flowToken: str(cfg, 'sFT'),
    canary: str(cfg, 'canary'),
    i19: '',
  }, page.url);
  return followRedirects(jar, next);
}

interface SasJson {
  Success?: boolean;
  ResultValue?: string;
  Entropy?: number | string;
  FlowToken?: string;
  Ctx?: string;
  CorrelationId?: string;
  Message?: string;
  Retry?: boolean;
}

async function sasPost(
  jar: CookieJar,
  url: string,
  body: Record<string, unknown>,
): Promise<SasJson> {
  const page = await request(jar, url, {
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

async function promptLine(question: string): Promise<string> {
  const fromEnv = (process.env.BC_MFA_CODE || '').trim();
  if (fromEnv) return fromEnv;
  if (!input.isTTY) {
    throw new Error('MFA TOTP needed: set BC_MFA_CODE or run in a TTY');
  }
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export type EstsUiStatus = {
  phase: 'signing-in' | 'mfa' | 'finishing' | 'done' | 'error';
  entropy?: string;
  message?: string;
};

let estsUi: { username: string; onStatus?: (s: EstsUiStatus) => void } = { username: '' };

function uiStatus(s: EstsUiStatus): void {
  estsUi.onStatus?.(s);
}

async function completeMfa(jar: CookieJar, page: Page): Promise<Page> {
  const cfg = parseConfig(page.html);
  if (!cfg) throw new Error('MFA page has no $Config');
  const info = pageInfo(page.html);
  log(`  MFA pgid=${info.pgid} proofs=${info.proofs.join(',') || '-'}`);

  const beginUrl = str(cfg, 'urlBeginAuth') || `${ESTS}/common/SAS/BeginAuth`;
  const endUrl = str(cfg, 'urlEndAuth') || `${ESTS}/common/SAS/EndAuth`;
  const processUrl = str(cfg, 'urlPost') ? absUrl(str(cfg, 'urlPost'), page.url) : `${ESTS}/common/SAS/ProcessAuth`;

  const preferred = info.proofs.includes('PhoneAppNotification')
    ? 'PhoneAppNotification'
    : info.proofs.includes('PhoneAppOTP')
      ? 'PhoneAppOTP'
      : info.proofs[0] || 'PhoneAppNotification';

  let flowToken = str(cfg, 'sFT');
  let ctx = str(cfg, 'sCtx');

  log(`  SAS BeginAuth method=${preferred}`);
  const began = await sasPost(jar, beginUrl, {
    AuthMethodId: preferred,
    Method: 'BeginAuth',
    ctx,
    flowToken,
  });
  if (began.FlowToken) flowToken = began.FlowToken;
  if (began.Ctx) ctx = began.Ctx;
  log(`  BeginAuth Success=${began.Success} Result=${began.ResultValue ?? '-'} Entropy=${began.Entropy ?? '-'}`);

  if (preferred === 'PhoneAppNotification') {
    const entropy = began.Entropy !== undefined && began.Entropy !== '' ? String(began.Entropy) : '';
    if (entropy) {
      log(`\n  >>> Approve MFA in Authenticator. Number to pick: ${entropy}\n`);
    } else {
      log('\n  >>> Approve the sign-in in Microsoft Authenticator\n');
    }
    uiStatus({
      phase: 'mfa',
      entropy: entropy || undefined,
      message: entropy ? `Pick ${entropy} in Microsoft Authenticator` : 'Approve the sign-in in Microsoft Authenticator',
    });
    const deadline = Date.now() + 90_000;
    let last = began;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      last = await sasPost(jar, endUrl, {
        AuthMethodId: preferred,
        Method: 'EndAuth',
        SessionId: began.CorrelationId,
        ctx,
        flowToken,
      });
      if (last.FlowToken) flowToken = last.FlowToken;
      if (last.Ctx) ctx = last.Ctx;
      const result = last.ResultValue ?? '';
      log(`  EndAuth Success=${last.Success} Result=${result || '-'}`);
      if (last.Success === true || result === 'Success') break;
      if (result && result !== 'PendingAuthentication' && !last.Retry) {
        throw new Error(`MFA EndAuth: ${result} ${last.Message ?? ''}`);
      }
    }
    if (last.Success !== true && last.ResultValue !== 'Success') {
      throw new Error('MFA push timed out (90s). Approve faster or use BC_MFA_CODE for TOTP.');
    }
  } else {
    const code = await promptLine('Authenticator TOTP / SMS code: ');
    if (!code) throw new Error('empty MFA code');
    const ended = await sasPost(jar, endUrl, {
      AuthMethodId: preferred,
      Method: 'EndAuth',
      AdditionalAuthData: code,
      ctx,
      flowToken,
    });
    if (ended.FlowToken) flowToken = ended.FlowToken;
    if (ended.Ctx) ctx = ended.Ctx;
    log(`  EndAuth Success=${ended.Success} Result=${ended.ResultValue ?? '-'}`);
    if (ended.Success !== true && ended.ResultValue !== 'Success') {
      throw new Error(`MFA rejected: ${ended.ResultValue ?? ended.Message ?? 'unknown'}`);
    }
  }

  log(`POST ProcessAuth ${processUrl.split('?')[0]}`);
  const processed = await postForm(jar, processUrl, {
    type: '19',
    request: ctx,
    mfaAuthMethod: preferred,
    login: estsUi.username || process.env.BC_USERNAME || '',
    flowToken,
    canary: str(cfg, 'canary'),
    hpgrequestid: '',
    ctx,
  }, page.url);
  return followRedirects(jar, processed);
}

function looksLikeMfa(html: string): boolean {
  const info = pageInfo(html);
  if (info.proofs.length > 0) return true;
  const id = `${info.pgid} ${info.hpgid}`.toLowerCase();
  return /tfa|sas|mfa|authmethod|convergedtfa|phoneapp/i.test(id) || /arrUserProofs/.test(html);
}

function looksLikeKmsi(html: string): boolean {
  const info = pageInfo(html);
  return /kmsi/i.test(info.pgid) || /kmsi/i.test(html.slice(0, 4000));
}

async function finishOidc(jar: CookieJar, page: Page): Promise<Page> {
  const form = extractForm(page.html);
  if (!form || !isRemoteSignIn(form)) {
    return page;
  }
  const action = absUrl(form.action, 'https://businesscentral.dynamics.com');
  log(`POST form_post → ${action.split('?')[0]} fields=${Object.keys(form.fields).join(',')}`);
  const rs = await postForm(jar, action, form.fields, page.url);
  log(`  HTTP ${rs.res.status} loc=${(rs.res.headers.get('location') ?? '').split('?')[0] || '-'}`);
  log(`  cookie names: ${jar.names().join(', ')}`);
  return followRedirects(jar, rs);
}

async function drainInterrupts(jar: CookieJar, start: Page): Promise<Page> {
  let page = start;
  for (let i = 0; i < 10; i++) {
    const form = extractForm(page.html);
    if (form && isRemoteSignIn(form)) {
      page = await finishOidc(jar, page);
      continue;
    }
    const info = pageInfo(page.html);
    if (info.err) {
      throw new Error(`Entra error: ${info.err}`);
    }
    if (looksLikeKmsi(page.html)) {
      page = await postKmsi(jar, page);
      continue;
    }
    if (looksLikeMfa(page.html)) {
      page = await completeMfa(jar, page);
      continue;
    }
    return page;
  }
  throw new Error('too many Entra interrupts');
}

interface DeploymentReady {
  clusterAddress: string;
  runtimeId: string;
}

function clusterFromHtml(html: string): { host: string; tenant: string; tab: string } | undefined {
  const tabMatch = html.match(
    /https:\/\/([a-z0-9-]+\.appservices\.[a-z.]+\.businesscentral\.dynamics\.com)\/tenant\/([^/]+)\/tab\/([0-9a-f-]+)/i,
  );
  if (!tabMatch) return undefined;
  return { host: tabMatch[1]!, tenant: tabMatch[2]!, tab: tabMatch[3]! };
}

async function resolveDeployment(jar: CookieJar, saas: NonNullable<ReturnType<typeof parseSaasUrl>>): Promise<DeploymentReady | undefined> {
  const url = `${saas.portalUrl}/api/deployment?${new URLSearchParams({
    redirectedFromSignup: 'false',
    autoProvision: 'true',
  })}`;
  log(`GET /api/deployment`);
  const page = await request(jar, url, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  log(`  HTTP ${page.res.status} type=${page.res.headers.get('content-type') ?? '-'} bytes=${page.html.length}`);
  if (page.res.status >= 300) {
    log(`  loc=${(page.res.headers.get('location') ?? '').split('?')[0] || '-'}`);
    return undefined;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(page.html) as Record<string, unknown>;
  } catch {
    log('  not JSON');
    return undefined;
  }
  const status = String(json['status'] ?? '');
  const data = json['data'];
  const runtimeId = typeof json['runtimeId'] === 'string' ? json['runtimeId'] : '';
  log(`  status=${status} runtimeId=${runtimeId || '-'} dataType=${typeof data}`);
  if (status.toLowerCase() !== 'ready') {
    log(`  keys=${Object.keys(json).join(',')}`);
    return undefined;
  }
  let clusterAddress = '';
  if (typeof data === 'string') clusterAddress = data;
  else if (data && typeof data === 'object' && 'clusterAddress' in data) {
    clusterAddress = String((data as { clusterAddress: unknown }).clusterAddress ?? '');
  }
  if (!clusterAddress && typeof json['clusterAddress'] === 'string') {
    clusterAddress = json['clusterAddress'];
  }
  if (!clusterAddress) {
    log(`  Ready but no clusterAddress keys=${Object.keys(json).join(',')}`);
    return undefined;
  }
  log(`  cluster=${clusterAddress.replace(/\/+$/, '')}`);
  return { clusterAddress: clusterAddress.replace(/\/+$/, ''), runtimeId };
}

async function authenticateToken(
  jar: CookieJar,
  tabBase: string,
  fp: Record<string, unknown>,
): Promise<string> {
  const auth = (fp['authentication'] && typeof fp['authentication'] === 'object')
    ? fp['authentication'] as Record<string, unknown>
    : {};
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : '';
  const authorizationCode = typeof auth['authorizationCode'] === 'string' ? auth['authorizationCode'] : '';
  const homeAccountId = typeof auth['homeAccountId'] === 'string' ? auth['homeAccountId'] : '';
  const shared = typeof auth['sharedAuthCookieName'] === 'string' ? auth['sharedAuthCookieName'] : '';
  log(`POST AUTHENTICATETOKEN hasAccess=${Boolean(accessToken)} hasCode=${Boolean(authorizationCode)}`);
  if (!accessToken) return '';
  const id = `|${randomUUID().replace(/-/g, '')}.${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const authUrl = `${tabBase}/auth?${new URLSearchParams({ deviceCategory: '0' })}`;
  const page = await request(jar, authUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://businesscentral.dynamics.com',
      Referer: 'https://businesscentral.dynamics.com/',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'AUTHENTICATETOKEN',
      params: ['OAUTH', accessToken, false, authorizationCode, homeAccountId, shared],
      id,
    }),
  });
  log(`  HTTP ${page.res.status} bytes=${page.html.length}`);
  try {
    const rpc = JSON.parse(page.html) as { result?: { csrfToken?: string }; error?: { message?: string } };
    if (rpc.error) log(`  rpc error ${rpc.error.message ?? '?'}`);
    return rpc.result?.csrfToken ?? '';
  } catch {
    log('  AUTHENTICATETOKEN not JSON');
    return '';
  }
}

async function openCsh(jar: CookieJar, saas: NonNullable<ReturnType<typeof parseSaasUrl>>): Promise<void> {
  saveJar(jar);
  log('\n[portal] GET DEV');
  let after = await request(jar, saas.portalUrl);
  log(`  HTTP ${after.res.status} loc=${(after.res.headers.get('location') ?? '').split('?')[0] || '-'} html=${after.html.length}B`);
  after = await followRedirects(jar, after, 5);
  saveJar(jar);

  const fp = parseFixedEndPoint(after.html);
  if (fp) {
    const auth = fp['authentication'];
    const authType = auth && typeof auth === 'object' ? String((auth as { type?: unknown }).type ?? '') : '';
    log(`  FixedEndPoint.start env=${String(fp['environment'] ?? '-')} authed=${String(fp['isUserAuthenticated'])} authType=${authType || '-'}`);
  } else {
    log('  no FixedEndPoint.start in HTML');
  }

  let host = '';
  let internalTenant = '';
  let tabId = '';
  const fromHtml = clusterFromHtml(after.html);
  if (fromHtml) {
    host = fromHtml.host;
    internalTenant = fromHtml.tenant;
    tabId = fromHtml.tab;
    log(`  tab from HTML`);
  } else {
    const dep = await resolveDeployment(jar, saas);
    if (!dep) {
      log('FAIL: no appservices tab in HTML and /api/deployment did not return Ready');
      log(`  cookie names: ${jar.names().join(', ')}`);
      process.exit(1);
    }
    try {
      host = new URL(dep.clusterAddress).host;
    } catch {
      log(`FAIL: bad clusterAddress`);
      process.exit(1);
    }
    internalTenant = dep.runtimeId;
    if (!internalTenant) {
      log('FAIL: deployment Ready but runtimeId empty');
      process.exit(1);
    }
    tabId = randomUUID();
  }
  const tabBase = `https://${host}/tenant/${internalTenant}/tab/${tabId}`;
  log(`tab ${tabBase}`);

  if (fp) {
    const csrfFromAuth = await authenticateToken(jar, tabBase, fp);
    if (csrfFromAuth) log(`  AUTHENTICATETOKEN csrf=${csrfFromAuth.slice(0, 8)}…`);
    saveJar(jar);
  }

  for (const path of ['/v', '/boot/browser/desktop']) {
    const r = await request(jar, `${tabBase}${path}`, {
      headers: { Origin: saas.origin, Referer: saas.portalUrl },
    });
    log(`  GET ${path} HTTP ${r.res.status}`);
  }
  const csrfRes = await request(jar, `${tabBase}/csrf`, {
    method: 'POST',
    headers: { Accept: 'application/json', Origin: saas.origin },
  });
  log(`  POST /csrf HTTP ${csrfRes.res.status}`);
  let csrf = csrfFrom(jar.header());
  try {
    const j = JSON.parse(csrfRes.html) as { csrfToken?: string };
    if (j.csrfToken) csrf = j.csrfToken;
  } catch { /* use cookie */ }

  const qs = new URLSearchParams({ ackseqnb: '-1' });
  if (csrf) qs.set('csrftoken', csrf);
  const wsUrl = `wss://${host}/tenant/${internalTenant}/tab/${tabId}/csh?${qs}`;
  log(`[csh] ${wsUrl.split('?')[0]}`);
  const r = await probeWs(wsUrl, { Cookie: jar.header(), Origin: saas.origin, 'User-Agent': UA });
  log(`  → ${r}`);
  if (r.startsWith('OPEN')) {
    log('\nPASS: ESTS cookie-jar opened /csh (no Chromium)');
    process.exit(0);
  }
  log('\nFAIL: ESTS login may have worked but /csh did not upgrade');
  process.exit(1);
}

/** Password ESTS login only (no /csh). Used by the local sign-in window prototype. */
export async function estsPasswordLogin(
  username: string,
  password: string,
  portalUrl: string,
  onStatus?: (s: EstsUiStatus) => void,
): Promise<CookieJar> {
  const saas = parseSaasUrl(portalUrl.replace(/\/+$/, ''));
  if (!saas) throw new Error('not a SaaS URL');
  estsUi = { username, onStatus };
  uiStatus({ phase: 'signing-in', message: 'Contacting Microsoft sign-in…' });

  const jar = new CookieJar();
  const portal = await request(jar, saas.portalUrl);
  const loc = portal.res.headers.get('location');
  if (!loc || !loc.includes('login.microsoftonline.com')) {
    throw new Error('portal did not redirect to Entra authorize');
  }
  let authz = await request(jar, loc);
  authz = await followRedirects(jar, authz, 3);
  const cfg = parseConfig(authz.html);
  if (!cfg) throw new Error('no $Config on Entra login page');

  const gctUrl = str(cfg, 'urlGetCredentialType') || `${ESTS}/common/GetCredentialType?mkt=en-US`;
  await request(jar, gctUrl, {
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

  uiStatus({ phase: 'signing-in', message: 'Checking password…' });
  const postUrl = absUrl(str(cfg, 'urlPost'), ESTS);
  const body = new URLSearchParams({
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
  });
  let page = await request(jar, postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ESTS,
      Referer: authz.url,
    },
    body: body.toString(),
  });
  page = await followRedirects(jar, page);
  page = await drainInterrupts(jar, page);
  const signed = extractForm(page.html);
  if (signed && isRemoteSignIn(signed)) {
    uiStatus({ phase: 'finishing', message: 'Opening Business Central…' });
    page = await finishOidc(jar, page);
  }
  const stillLogin = page.url.includes('login.microsoftonline.com') && parseConfig(page.html);
  if (stillLogin && !extractForm(page.html)?.fields['code']) {
    const leftover = pageInfo(page.html);
    throw new Error(`still on Entra (${leftover.pgid || leftover.err || 'unknown page'})`);
  }
  saveJar(jar);
  uiStatus({ phase: 'done', message: 'Signed in. You can close this window.' });
  return jar;
}

async function main(): Promise<void> {
  const saas = parseSaasUrl(requireBaseUrl());
  if (!saas) throw new Error('not a SaaS URL');
  const username = process.env.BC_USERNAME || '';
  const password = process.env.BC_PASSWORD || '';

  const saved = loadJar();
  if (saved && saved.names().some((n) => n.endsWith('.auth'))) {
    log('Prototype 2: trying saved portal cookies (skip login if still valid)');
    const probe = await request(saved, saas.portalUrl);
    log(`  GET portal HTTP ${probe.res.status} loc=${(probe.res.headers.get('location') ?? '').split('?')[0] || '-'}`);
    const loc0 = probe.res.headers.get('location') ?? '';
    if (probe.res.status === 200 && !loc0.includes('login.microsoftonline.com')) {
      await openCsh(saved, saas);
      return;
    }
    log('  saved session expired; full ESTS login');
  }

  if (!username || !password) {
    log('FAIL: set BC_USERNAME and BC_PASSWORD (Microsoft account for this tenant). Not printed.');
    process.exit(2);
  }

  const jar = new CookieJar();
  log('Prototype 2: ESTS cookie-jar (we are the browser network stack)');

  log('GET portal');
  const portal = await request(jar, saas.portalUrl);
  const loc = portal.res.headers.get('location');
  log(`  HTTP ${portal.res.status} loc=${(loc ?? '').split('?')[0] || '-'} cookies=${jar.names().length}`);
  if (!loc || !loc.includes('login.microsoftonline.com')) {
    log('FAIL: portal did not redirect to Entra authorize');
    process.exit(1);
  }

  log('GET authorize');
  let authz = await request(jar, loc);
  authz = await followRedirects(jar, authz, 3);
  log(`  HTTP ${authz.res.status} html=${authz.html.length}B`);

  const cfg = parseConfig(authz.html);
  if (!cfg) {
    log('FAIL: no $Config on Entra login page');
    process.exit(1);
  }
  log(`  $Config keys ok tenant=${str(cfg, 'sTenantId')} urlPost=${str(cfg, 'urlPost')}`);

  const gctUrl = str(cfg, 'urlGetCredentialType') || `${ESTS}/common/GetCredentialType?mkt=en-US`;
  log('POST GetCredentialType');
  const gct = await request(jar, gctUrl, {
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
  let gctJson: { IfExistsResult?: number; Credentials?: { HasPassword?: boolean }; EstsProperties?: { DomainType?: number } } = {};
  try { gctJson = JSON.parse(gct.html) as typeof gctJson; } catch { /* */ }
  log(`  HTTP ${gct.res.status} IfExists=${gctJson.IfExistsResult} HasPassword=${gctJson.Credentials?.HasPassword} DomainType=${gctJson.EstsProperties?.DomainType}`);

  const postUrl = absUrl(str(cfg, 'urlPost'), ESTS);
  const body = new URLSearchParams({
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
  });
  log('POST /login (password)');
  let page = await request(jar, postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ESTS,
      Referer: authz.url,
    },
    body: body.toString(),
  });
  log(`  HTTP ${page.res.status} loc=${(page.res.headers.get('location') ?? '').split('?')[0] || '-'} html=${page.html.length}B`);
  page = await followRedirects(jar, page);

  const info = pageInfo(page.html);
  log(`  after password: pgid=${info.pgid || '-'} hpgid=${info.hpgid || '-'} proofs=${info.proofs.join(',') || '-'}`);
  page = await drainInterrupts(jar, page);

  const signed = extractForm(page.html);
  if (signed && isRemoteSignIn(signed)) {
    page = await finishOidc(jar, page);
  }

  const stillLogin = page.url.includes('login.microsoftonline.com') && parseConfig(page.html);
  if (stillLogin && !extractForm(page.html)?.fields['code']) {
    const leftover = pageInfo(page.html);
    log(`FAIL: still on Entra pgid=${leftover.pgid} hpgid=${leftover.hpgid} err=${leftover.err.slice(0, 160)}`);
    log(`  cookie names: ${jar.names().join(', ')}`);
    process.exit(1);
  }

  await openCsh(jar, saas);
}

const runningThisFile = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (runningThisFile) {
  main().catch((e) => {
    process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
