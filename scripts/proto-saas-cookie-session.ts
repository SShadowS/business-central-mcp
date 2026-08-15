/**
 * Prototype B1 — /csh with a real web-client cookie session you paste.
 *
 * 1. Sign in at the SaaS URL in your own browser.
 * 2. DevTools → Network → any request to businesscentral.dynamics.com
 *    after the client has loaded → Request Headers → copy the full
 *    `Cookie` header value (the header value only, not the name).
 * 3. Write that single line to:
 *      .state/proto-saas-web-cookies.txt
 *    or:  export BC_WEB_COOKIE='...'
 * 4.   npx tsx scripts/proto-saas-cookie-session.ts
 *
 * Cookie values are never printed. The file sits under .state/ (gitignored).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { extractCsrf } from '../src/connection/auth/oauth-provider.js';

const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function loadCookieHeader(): string | undefined {
  const fromEnv = process.env.BC_WEB_COOKIE?.trim();
  if (fromEnv) return fromEnv;
  const path = resolve(process.env.STATE_DIR || './.state', 'proto-saas-web-cookies.txt');
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  return text || undefined;
}

function cookieNames(header: string): string[] {
  return header.split(';').map((p) => p.trim().split('=')[0]).filter((n): n is string => Boolean(n));
}

async function probeHttp(label: string, url: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', headers });
  log(label);
  log(`  HTTP ${res.status} ${res.statusText}`);
  const loc = res.headers.get('location');
  if (loc) log(`  Location: ${loc.split('?')[0]}`);
  const sf = res.headers.get('x-servicefabric');
  if (sf) log(`  x-servicefabric: ${sf}`);
  await res.arrayBuffer();
  return res.status;
}

function probeWs(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(url, { headers });
    const done = (detail: string) => {
      try { ws.close(); } catch { /* ignore */ }
      resolveWs(detail);
    };
    ws.on('open', () => done('OPEN 101'));
    ws.on('unexpected-response', (_req, res) => done(`REJECTED HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`ERROR ${e.message}`));
    setTimeout(() => done('TIMEOUT'), 10_000);
  });
}

async function main(): Promise<void> {
  const raw = (process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }

  const cookies = loadCookieHeader();
  if (!cookies) {
    log('WAIT: no cookie session yet.');
    log('');
    log(`1. In your browser, sign in to:`);
    log(`   ${saas.portalUrl}`);
    log(`2. Wait until the BC client is actually loaded (not the Entra login page).`);
    log(`3. DevTools (F12) → Network → pick a request to businesscentral.dynamics.com`);
    log(`   → Request Headers → Cookie. Copy the header VALUE only.`);
    log(`4. Save it as one line:`);
    log(`   ${resolve(process.env.STATE_DIR || './.state', 'proto-saas-web-cookies.txt')}`);
    log(`5. Re-run: npx tsx scripts/proto-saas-cookie-session.ts`);
    process.exit(2);
  }

  const names = cookieNames(cookies);
  const csrf = extractCsrf(cookies);
  log('Prototype B1: /csh with pasted web-client cookies');
  log(`cookie names (${names.length}): ${names.join(', ')}`);
  log(`csrf from Antiforgery: ${csrf ? 'yes' : 'NO'}`);

  const headers: Record<string, string> = {
    Cookie: cookies,
    Origin: saas.origin,
    'User-Agent': 'BCMCPServer/2.0',
  };

  log('');
  const portalStatus = await probeHttp('[1] GET portal', saas.portalUrl, headers);
  log('');
  const cshStatus = await probeHttp('[2] GET /csh', `${saas.portalUrl}/csh`, headers);

  const qs = new URLSearchParams({ ackseqnb: '-1' });
  if (csrf) qs.set('csrftoken', csrf);
  const wsUrl = `${saas.portalUrl.replace(/^http/, 'ws')}/csh?${qs.toString()}`;
  log('');
  log(`[3] WS upgrade (csrftoken ${csrf ? 'present' : 'omitted'})`);
  const ws = await probeWs(wsUrl, headers);
  log(`  ${ws}`);

  if (ws.startsWith('OPEN')) {
    log('PASS: /csh opened with the pasted web-client session');
    process.exit(0);
  }

  log('FAIL: pasted cookies did not open /csh');
  if (portalStatus >= 300 && portalStatus < 400) {
    log('  portal still redirected — session is missing or expired; copy Cookie again after a full load');
  }
  if (cshStatus === 404) log('  GET /csh still 404 even with cookies');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
