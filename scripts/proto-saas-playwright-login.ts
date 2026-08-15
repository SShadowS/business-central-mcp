/**
 * Prototype (1) — we *are* the browser.
 *
 * Downloads Chromium once into STATE_DIR/ms-playwright (no `playwright install`
 * for the user). Opens a headed window on the SaaS portal. You sign in there
 * (MFA included). We then take cookies from THAT window and probe /csh.
 *
 *   npx tsx scripts/proto-saas-playwright-login.ts
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { ensureChromium } from '../src/connection/auth/ensure-chromium.js';

const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function headerFor(
  cookies: Array<{ name: string; value: string; domain: string }>,
  host: string,
): string {
  const map = new Map<string, string>();
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '');
    if (host === d || host.endsWith(`.${d}`)) map.set(c.name, c.value);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrfFrom(header: string): string {
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) {
      return part.slice(eq + 1);
    }
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

async function http(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { redirect: 'manual', headers });
  const loc = (res.headers.get('location') ?? '').split('?')[0];
  await res.arrayBuffer();
  return `HTTP ${res.status} loc=${loc || '-'} sf=${res.headers.get('x-servicefabric') ?? '-'}`;
}

async function main(): Promise<void> {
  const saas = parseSaasUrl((process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, ''));
  if (!saas) throw new Error('not a SaaS URL');
  const stateDir = resolve(process.env.STATE_DIR || './.state');

  log('Prototype 1: bundled Chromium (we are the browser)');
  log('Ensuring Chromium is downloaded into STATE_DIR (one-time)…');
  const browsersPath = ensureChromium(stateDir);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

  const { chromium } = await import('playwright');
  log(`Opening ${saas.portalUrl}`);
  log('Sign in in the window that appears. MFA is fine. Waiting until BC has loaded…');

  const profileDir = resolve(stateDir, 'pw-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] ?? await context.newPage();
  const wsSeen: string[] = [];
  const attach = (p: typeof page) => {
    p.on('websocket', (wsock) => {
      const u = wsock.url();
      wsSeen.push(u);
      log(`[page ws] ${u.split('?')[0]}`);
    });
    p.on('response', (res) => {
      const u = res.url();
      if (/appservices|\/tenant\/msft|clientservices/i.test(u)) {
        log(`[page http] ${res.status()} ${u.split('?')[0]}`);
      }
    });
  };
  attach(page);
  context.on('page', attach);
  await page.goto(saas.portalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    const url = page.url();
    const cookies = await context.cookies();
    const names = cookies.map((c) => c.name);
    const onPortal = url.includes('businesscentral.dynamics.com') && !url.includes('login.microsoftonline');
    const hasSession = names.some((n) =>
      n === '.AspNetCore.Cookies' || n === '.auth' || n.endsWith('.auth') || n === 'SessionId',
    );
    if (onPortal && hasSession) {
      ready = true;
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!ready) {
    log('FAIL: timed out waiting for a BC web-client session in our Chromium');
    await context.close();
    process.exit(1);
  }

  log('session present; waiting up to 45s for the page WebSocket…');
  const wsDeadline = Date.now() + 45_000;
  while (Date.now() < wsDeadline && !wsSeen.some((u) => u.includes('/csh'))) {
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`page opened ${wsSeen.length} websocket(s)`);
  for (const u of wsSeen) log(`  ${u.split('?')[0]}`);

  const cookies = await context.cookies();
  const hosts = [...new Set(cookies.filter((c) => c.domain.includes('businesscentral')).map((c) => c.domain.replace(/^\./, '')))];
  log(`session hosts: ${hosts.join(', ') || '(none)'}`);
  for (const h of hosts) {
    const names = cookies.filter((c) => c.domain.replace(/^\./, '') === h || c.domain === `.${h}`).map((c) => c.name);
    log(`  ${h}: ${names.join(', ')}`);
  }

  const ua = { 'User-Agent': 'BCMCPServer/2.0' };
  let opened = false;

  const portalCookie = headerFor(cookies, 'businesscentral.dynamics.com');
  if (portalCookie) {
    const headers = { Cookie: portalCookie, Origin: saas.origin, ...ua };
    const csrf = csrfFrom(portalCookie);
    const qs = new URLSearchParams({ ackseqnb: '-1' });
    if (csrf) qs.set('csrftoken', csrf);
    log('\n[portal] GET DEV');
    log(`  ${await http(saas.portalUrl, headers)}`);

    const cshHttp = `https://businesscentral.dynamics.com/${saas.aadTenantId}/csh`;
    const cshRes = await fetch(cshHttp, { redirect: 'manual', headers });
    const cshType = cshRes.headers.get('content-type') ?? '';
    const cshBody = await cshRes.text();
    log(`[portal] GET /{tenant}/csh HTTP ${cshRes.status} type=${cshType} bytes=${cshBody.length}`);
    const urlHits = [...cshBody.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]!);
    const interesting = [...new Set(urlHits.filter((u) =>
      /appservices|csh|wss:|websocket|clientservices/i.test(u),
    ))];
    log(`  interesting URLs in body (${interesting.length}):`);
    for (const u of interesting.slice(0, 30)) log(`    ${u.split('?')[0]}`);

    for (const path of [`/${saas.aadTenantId}/csh?${qs}`, `/${saas.aadTenantId}/${saas.environmentName}/csh?${qs}`]) {
      const r = await probeWs(`wss://businesscentral.dynamics.com${path}`, headers);
      log(`[portal] WS ${path.split('?')[0]} → ${r}`);
      if (r.startsWith('OPEN')) opened = true;
    }

    const extraHosts = interesting
      .map((u) => { try { return new URL(u); } catch { return undefined; } })
      .filter((u): u is URL => Boolean(u) && u.hostname.includes('appservices'));
    for (const u of extraHosts) {
      const host = u.hostname;
      log(`[html] try host ${host}`);
      const r = await probeWs(`wss://${host}/csh?${qs}`, { ...headers, Origin: `https://${host}` });
      log(`  WS wss://${host}/csh → ${r}`);
      if (r.startsWith('OPEN')) opened = true;
    }
  }

  // Release the tab so the cluster will accept a second /csh (500 if the
  // page still holds the socket). Then replay boot/auth/csrf + WS.
  log('closing the page to release the tab socket…');
  try { await context.close(); } catch { /* already closed */ }
  await new Promise((r) => setTimeout(r, 1500));

  for (const u of wsSeen.filter((x) => x.includes('/csh'))) {
    const parsed = new URL(u);
    const cookie = headerFor(cookies, parsed.hostname)
      || headerFor(cookies, 'businesscentral.dynamics.com');
    if (!cookie) continue;
    const clusterOrigin = `https://${parsed.hostname}`;
    const headers = { Cookie: cookie, Origin: clusterOrigin, ...ua };
    const tabBase = u.replace(/\/csh(?:\?.*)?$/, '').replace(/^ws/, 'http');
    log(`[tab] ${tabBase}`);
    for (const path of ['/v', '/boot/browser/desktop', '/auth', '/csrf']) {
      log(`  GET ${path} ${await http(`${tabBase}${path}`, headers)}`);
    }
    const csrfPost = await fetch(`${tabBase}/csrf`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...headers, Accept: 'application/json' },
    });
    const csrfBody = await csrfPost.text();
    log(`  POST /csrf HTTP ${csrfPost.status} body=${csrfBody.slice(0, 80)}`);
    const csrf = csrfFrom(cookie);
    const replay = new URL(u);
    if (csrf && !replay.searchParams.has('csrftoken')) replay.searchParams.set('csrftoken', csrf);
    if (!replay.searchParams.has('ackseqnb')) replay.searchParams.set('ackseqnb', '-1');
    for (const orig of [clusterOrigin, saas.origin]) {
      const h = { Cookie: cookie, Origin: orig, ...ua };
      log(`[replay] Origin=${orig}`);
      const r = await probeWs(replay.toString(), h);
      log(`  → ${r}`);
      if (r.startsWith('OPEN')) opened = true;
    }
  }

  if (opened) {
    log('\nPASS: /csh opened with cookies from our bundled Chromium');
    process.exit(0);
  }
  log('\nFAIL: signed in but /csh did not upgrade (see hosts/paths above)');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
