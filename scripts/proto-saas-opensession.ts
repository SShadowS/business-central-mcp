/**
 * Prototype (3) — ESTS /csh through the real MCP page/data stack (no Chromium).
 *
 * Reuses .state/proto-ests-cookies.json from proto-saas-ests-login.ts.
 * If the portal session is dead, re-run that script (MFA) first.
 *
 *   npx tsx scripts/proto-saas-opensession.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { BCWebSocket } from '../src/connection/bc-websocket.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { BCSession } from '../src/session/bc-session.js';
import { isErr } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCEvent } from '../src/protocol/types.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { fields as treeFields } from '../src/protocol/form-views.js';

const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_FILE = resolve(process.env.STATE_DIR || './.state', 'proto-ests-cookies.json');
const PORTAL_ORIGIN = 'https://businesscentral.dynamics.com';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

const logger: Logger = {
  info: (m) => log(`  [info] ${m}`),
  warn: (m) => log(`  [warn] ${m}`),
  error: (m) => log(`  [error] ${m}`),
  debug: (ch, m) => log(`  [debug:${ch}] ${m}`),
};

class CookieJar {
  private map = new Map<string, string>();

  absorb(res: Response): void {
    for (const header of res.headers.getSetCookie?.() ?? []) {
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

  load(obj: Record<string, string>): void {
    for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
  }
}

function loadJar(): CookieJar {
  const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf8')) as Record<string, string>;
  const jar = new CookieJar();
  jar.load(raw);
  return jar;
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

async function request(jar: CookieJar, url: string, init: RequestInit = {}): Promise<{ res: Response; html: string }> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', UA);
  const cookie = jar.header();
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  jar.absorb(res);
  return { res, html: await res.text() };
}

function csrfFrom(header: string): string {
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) return part.slice(eq + 1);
  }
  return '';
}

function fceToken(html: string): string {
  return html.match(/id=["']RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1]
    ?? html.match(/value=["']([^"']+)["'][^>]*id=["']RequestVerificationToken["']/i)?.[1]
    ?? '';
}

function summarizeEvents(events: BCEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ') || '(none)';
}

async function main(): Promise<void> {
  const saas = parseSaasUrl((process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, ''));
  if (!saas) throw new Error('not a SaaS URL');

  log('Prototype 3: ESTS /csh + PageService/DataService (no Chromium)');
  let jar: CookieJar;
  try {
    jar = loadJar();
  } catch {
    log('FAIL: no saved ESTS cookies. Run: npx tsx scripts/proto-saas-ests-login.ts');
    process.exit(2);
  }
  log(`loaded cookies: ${jar.names().filter((n) => n.endsWith('.auth') || n === '.AspNetCore.Cookies' || n === 'SessionId').join(', ') || jar.names().length}`);

  log('GET portal');
  const portal = await request(jar, saas.portalUrl);
  const loc = (portal.res.headers.get('location') ?? '').split('?')[0];
  log(`  HTTP ${portal.res.status} loc=${loc || '-'} html=${portal.html.length}B`);
  if (portal.res.status >= 300 && loc.includes('login.microsoftonline.com')) {
    log('FAIL: portal session expired. Re-run proto-saas-ests-login.ts (MFA).');
    process.exit(2);
  }

  const fp = parseBalancedObject(portal.html, portal.html.indexOf('FixedEndPoint.start('));
  if (!fp) {
    log('FAIL: no FixedEndPoint.start (not a signed-in portal shell)');
    process.exit(1);
  }
  const auth = (fp['authentication'] && typeof fp['authentication'] === 'object')
    ? fp['authentication'] as Record<string, unknown>
    : {};
  log(`  FixedEndPoint env=${String(fp['environment'] ?? '-')} authed=${String(fp['isUserAuthenticated'])} hasAccess=${typeof auth['accessToken'] === 'string'} hasCode=${typeof auth['authorizationCode'] === 'string'}`);
  const portalCsrf = fceToken(portal.html);
  log(`  FCE-CSRF-TOKEN ${portalCsrf ? 'present' : 'absent'}`);

  const depUrl = `${saas.portalUrl}/api/deployment?${new URLSearchParams({
    redirectedFromSignup: 'false',
    autoProvision: 'true',
  })}`;
  log('GET /api/deployment');
  const depPage = await request(jar, depUrl, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  log(`  HTTP ${depPage.res.status} bytes=${depPage.html.length}`);
  const dep = JSON.parse(depPage.html) as Record<string, unknown>;
  if (String(dep['status'] ?? '').toLowerCase() !== 'ready' || typeof dep['data'] !== 'string') {
    log(`FAIL: deployment not Ready status=${String(dep['status'])} keys=${Object.keys(dep).join(',')}`);
    process.exit(1);
  }
  const clusterUrl = new URL(dep['data'] as string);
  const runtimeId = (typeof dep['runtimeId'] === 'string' && dep['runtimeId'])
    || clusterUrl.searchParams.get('tenant')
    || '';
  const tid = clusterUrl.searchParams.get('tid') ?? '';
  log(`  host=${clusterUrl.host} runtimeId=${runtimeId} tid=${tid ? tid.slice(0, 8) + '…' : '-'}`);
  if (!runtimeId) {
    log('FAIL: no runtimeId/tenant on cluster URL');
    process.exit(1);
  }

  const setCookieHeaders: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: PORTAL_ORIGIN,
    Referer: saas.portalUrl,
  };
  if (portalCsrf) setCookieHeaders['FCE-CSRF-TOKEN'] = portalCsrf;
  log('POST /api/authcookie/setcookie');
  const setc = await request(jar, `${saas.portalUrl}/api/authcookie/setcookie`, {
    method: 'POST',
    headers: setCookieHeaders,
    body: JSON.stringify({ subPath: `/tenant/${runtimeId}` }),
  });
  log(`  HTTP ${setc.res.status} bytes=${setc.html.length}`);

  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : '';
  const authorizationCode = typeof auth['authorizationCode'] === 'string' ? auth['authorizationCode'] : '';
  const homeAccountId = typeof auth['homeAccountId'] === 'string' ? auth['homeAccountId'] : '';
  const shared = typeof auth['sharedAuthCookieName'] === 'string' ? auth['sharedAuthCookieName'] : '';
  const authQs = new URLSearchParams({ tenant: runtimeId, deviceCategory: '0' });
  if (tid) authQs.set('tid', tid);
  const authUrl = `https://${clusterUrl.host}/auth?${authQs}`;
  log(`POST AUTHENTICATETOKEN ${authUrl.split('?')[0]}`);
  let authCsrf = '';
  if (accessToken) {
    const id = `|${randomUUID().replace(/-/g, '')}.${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const authRes = await request(jar, authUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: PORTAL_ORIGIN,
        Referer: saas.portalUrl,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'AUTHENTICATETOKEN',
        params: ['OAUTH', accessToken, false, authorizationCode, homeAccountId, shared],
        id,
      }),
    });
    log(`  HTTP ${authRes.res.status} bytes=${authRes.html.length}`);
    try {
      const rpc = JSON.parse(authRes.html) as {
        result?: { csrfToken?: string };
        error?: { code?: number; message?: string };
      };
      if (rpc.error) log(`  rpc error code=${rpc.error.code ?? '-'} msg=${rpc.error.message ?? '?'}`);
      else {
        log('  AUTHENTICATETOKEN ok');
        authCsrf = rpc.result?.csrfToken ?? '';
      }
    } catch {
      log('  AUTHENTICATETOKEN not JSON');
    }
  } else {
    log('  skipped (no accessToken in FixedEndPoint.start)');
  }

  const session = await openSession(jar, saas.portalUrl, clusterUrl.host, runtimeId, authCsrf);
  const repo = new PageContextRepository();
  const pages = new PageService(session, repo, logger);
  const data = new DataService(session, repo, logger);

  log('PageService.openPage(22) Customer List');
  const list = await pages.openPage('22');
  if (isErr(list)) {
    log(`FAIL: openPage 22 ${list.error.message}`);
    session.close();
    process.exit(1);
  }
  log(`  pcId=${list.value.pageContextId} type=${list.value.pageType} caption=${list.value.caption} formId=${list.value.rootFormId}`);
  const rows = data.readRows(list.value.pageContextId);
  if (isErr(rows)) {
    log(`FAIL: readRows ${rows.error.message}`);
    session.close();
    process.exit(1);
  }
  log(`  rows=${rows.value.length} total=${data.getRepeaterTotalRowCount(list.value.pageContextId) ?? '?'}`);
  const first = rows.value[0];
  if (!first) {
    log('FAIL: Customer List opened but had zero rows');
    session.close();
    process.exit(1);
  }
  const cellKeys = Object.keys(first.cells).slice(0, 6);
  log(`  first bookmark=${first.bookmark.slice(0, 24)}… cells=${cellKeys.join(',')}`);

  log('PageService.openPage(21) Customer Card');
  const card = await pages.openPage('21');
  if (isErr(card)) {
    log(`FAIL: openPage 21 ${card.error.message}`);
    session.close();
    process.exit(1);
  }
  log(`  pcId=${card.value.pageContextId} type=${card.value.pageType} caption=${card.value.caption}`);
  const root = card.value.forms.get(card.value.rootFormId);
  if (!root) {
    log('FAIL: card has no root form');
    session.close();
    process.exit(1);
  }
  let fieldNodes = treeFields(root.root);
  let valued = fieldNodes.filter((f) => (f.properties.stringValue ?? '') !== '');
  log(`  fields=${fieldNodes.length} withStringValue=${valued.length}`);
  if (valued.length === 0) {
    log('  LoadForm(loadData:true) on card root (values empty after OpenForm)');
    const loaded = await session.invoke(
      { type: 'LoadForm', formId: card.value.rootFormId, loadData: true },
      (e) => e.type === 'InvokeCompleted',
    );
    if (isErr(loaded)) {
      log(`FAIL: LoadForm ${loaded.error.message}`);
      session.close();
      process.exit(1);
    }
    repo.applyToPage(card.value.pageContextId, loaded.value);
    const after = repo.get(card.value.pageContextId)?.forms.get(card.value.rootFormId);
    fieldNodes = after ? treeFields(after.root) : fieldNodes;
    valued = fieldNodes.filter((f) => (f.properties.stringValue ?? '') !== '');
    log(`  after LoadForm fields=${fieldNodes.length} withStringValue=${valued.length}`);
  }
  if (valued.length === 0) {
    log('FAIL: Customer Card has no populated field values');
    session.close();
    process.exit(1);
  }
  const sample = valued.slice(0, 4).map((f) => `${f.properties.caption ?? '?'}=${(f.properties.stringValue ?? '').slice(0, 40)}`);
  log(`  sample ${sample.join(' | ')}`);

  session.close();

  log('\nReconnect: new tab, same portal cookies');
  const session2 = await openSession(jar, saas.portalUrl, clusterUrl.host, runtimeId, '');
  log(`  company=${session2.companyName}`);
  if (!session2.companyName) {
    log('FAIL: reconnect OpenSession had no company');
    session2.close();
    process.exit(1);
  }
  session2.close();

  log('\nPASS: ESTS MCP stack (list read + card fields + reconnect, no Chromium)');
  process.exit(0);
}

async function openSession(
  jar: CookieJar,
  portalUrl: string,
  clusterHost: string,
  runtimeId: string,
  csrfHint: string,
): Promise<BCSession> {
  const tabId = randomUUID();
  const tabBase = `https://${clusterHost}/tenant/${runtimeId}/tab/${tabId}`;
  log(`tab ${tabBase}`);
  for (const path of ['/v', '/boot/browser/desktop']) {
    const r = await request(jar, `${tabBase}${path}`, {
      headers: { Origin: PORTAL_ORIGIN, Referer: portalUrl },
    });
    log(`  GET ${path} HTTP ${r.res.status}`);
  }
  const csrfRes = await request(jar, `${tabBase}/csrf`, {
    method: 'POST',
    headers: { Accept: 'application/json', Origin: PORTAL_ORIGIN },
  });
  log(`  POST /csrf HTTP ${csrfRes.res.status}`);
  let csrf = csrfHint || csrfFrom(jar.header());
  try {
    const j = JSON.parse(csrfRes.html) as { csrfToken?: string };
    if (j.csrfToken) csrf = j.csrfToken;
  } catch { /* cookie */ }

  const qs = new URLSearchParams({ ackseqnb: '-1' });
  if (csrf) qs.set('csrftoken', csrf);
  const wsUrl = `wss://${clusterHost}/tenant/${runtimeId}/tab/${tabId}/csh?${qs}`;
  log(`[csh] ${wsUrl.split('?')[0]}`);

  const ws = new BCWebSocket(logger);
  const conn = await ws.connect({
    url: wsUrl,
    headers: {
      Cookie: jar.header(),
      Origin: PORTAL_ORIGIN,
      'User-Agent': UA,
    },
    timeoutMs: 20_000,
  });
  if (isErr(conn)) {
    throw new Error(`/csh connect ${conn.error.message}`);
  }
  log('  WS OPEN');

  const encoder = new InteractionEncoder(process.env.BC_CLIENT_VERSION || '28.0.0.0', 'FIN');
  const decoder = new EventDecoder();
  const session = new BCSession(ws, decoder, encoder, logger, runtimeId, 30_000, process.env.BC_PROFILE || '');
  log(`OpenSession tenantId=${runtimeId}`);
  const init = await session.initialize(runtimeId);
  if (isErr(init)) {
    session.close();
    throw new Error(`OpenSession ${init.error.message}`);
  }
  log(`  sessionId=${session.isInitialized ? 'set' : 'MISSING'} company=${session.companyName || '-'}`);
  log(`  events: ${summarizeEvents(init.value)}`);
  if (!session.companyName) {
    session.close();
    throw new Error('OpenSession returned no CompanyName');
  }
  return session;
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
