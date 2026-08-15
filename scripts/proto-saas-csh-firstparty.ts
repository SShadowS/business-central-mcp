/**
 * Prototype 3 — device-code as first-party BC web client, then portal + /csh.
 *
 * Client 996def3d-b36c-4153-8607-a6fd3c01b89f (Project Madeira / BC web client).
 * Scope: openid profile offline_access
 *
 *   npx tsx scripts/proto-saas-csh-firstparty.ts
 *
 * You must complete the device-code prompt in your own browser (once).
 * Tokens go to .state/proto-saas-tokens-996def3d.json and are not printed.
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient, type TokenSet } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';

const FIRST_PARTY_CLIENT = '996def3d-b36c-4153-8607-a6fd3c01b89f';
const WEB_CLIENT_SCOPE = 'openid profile offline_access';
const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';
const CACHE_FILE = 'proto-saas-tokens-996def3d.json';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function cookieNames(setCookie: string[]): string[] {
  return setCookie
    .map((c) => c.split('=')[0]?.trim())
    .filter((n): n is string => Boolean(n));
}

function isEntraLogin(location: string | null, base: string): boolean {
  if (!location) return false;
  try {
    const host = new URL(location, base).hostname.toLowerCase();
    return host === 'login.microsoftonline.com'
      || host === 'login.microsoft.com'
      || host === 'login.windows.net'
      || host.endsWith('.microsoftonline.com');
  } catch {
    return false;
  }
}

async function acquireToken(aadTenantId: string): Promise<TokenSet> {
  const stateDir = resolve(process.env.STATE_DIR || './.state');
  const cache = new FileTokenCache(resolve(stateDir, CACHE_FILE));
  const existing = cache.load(FIRST_PARTY_CLIENT, aadTenantId);
  const client = new OAuthTokenClient({
    aadTenantId,
    clientId: FIRST_PARTY_CLIENT,
    scope: WEB_CLIENT_SCOPE,
  });

  if (existing && existing.expiresAt - 60_000 > Date.now()) {
    log(`using cached first-party token (expires in ${Math.round((existing.expiresAt - Date.now()) / 1000)}s)`);
    return {
      accessToken: existing.accessToken,
      refreshToken: existing.refreshToken,
      expiresAt: existing.expiresAt,
      tokenType: 'Bearer',
    };
  }

  if (existing?.refreshToken) {
    log('refreshing cached first-party token…');
    const refreshed = await client.refresh(existing.refreshToken);
    if (!isErr(refreshed)) {
      cache.save({
        accessToken: refreshed.value.accessToken,
        refreshToken: refreshed.value.refreshToken ?? existing.refreshToken,
        expiresAt: refreshed.value.expiresAt,
        clientId: FIRST_PARTY_CLIENT,
        aadTenantId,
      });
      return refreshed.value;
    }
    log(`refresh failed (${refreshed.error.message}); starting a new device-code login`);
  }

  log('Prototype 3: device-code as first-party BC web client');
  log(`client=${FIRST_PARTY_CLIENT}`);
  log(`scope=${WEB_CLIENT_SCOPE}`);
  log('');

  const started = await client.startDeviceCode();
  if (isErr(started)) throw new Error(`device-code start: ${started.error.message}`);
  log(started.value.message);
  log('');
  log(`Open: ${started.value.verificationUri}`);
  log(`Code: ${started.value.userCode}`);
  log(`Waiting for you to sign in (timeout ${Math.round((started.value.expiresAt - Date.now()) / 1000)}s)…`);

  const tokens = await client.pollDeviceCode(started.value);
  if (isErr(tokens)) throw new Error(tokens.error.message);

  cache.save({
    accessToken: tokens.value.accessToken,
    refreshToken: tokens.value.refreshToken,
    expiresAt: tokens.value.expiresAt,
    clientId: FIRST_PARTY_CLIENT,
    aadTenantId,
  });
  log(`got access_token + ${tokens.value.refreshToken ? 'refresh_token' : 'no refresh'}`
    + `${tokens.value.idToken ? ' + id_token' : ' (no id_token)'}`);
  return tokens.value;
}

async function probeHttp(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', headers });
  const location = res.headers.get('location');
  const cookies = cookieNames(res.headers.getSetCookie?.() ?? []);
  log(label);
  log(`  URL ${url}`);
  log(`  HTTP ${res.status} ${res.statusText}`);
  if (location) log(`  Location: ${location.split('?')[0]}`);
  log(`  Set-Cookie names: ${cookies.length ? cookies.join(', ') : '(none)'}`);
  const sf = res.headers.get('x-servicefabric');
  if (sf) log(`  x-servicefabric: ${sf}`);
  await res.arrayBuffer();
  return { status: res.status, location };
}

function probeWs(url: string, headers: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(url, { headers });
    const done = (ok: boolean, detail: string) => {
      try { ws.close(); } catch { /* ignore */ }
      resolveWs({ ok, detail });
    };
    ws.on('open', () => done(true, 'OPEN 101'));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        const clip = body.replace(/\s+/g, ' ').slice(0, 160);
        done(false, `REJECTED HTTP ${res.statusCode} ${res.statusMessage ?? ''}${clip ? ` body=${clip}` : ''}`);
      });
    });
    ws.on('error', (e) => done(false, `ERROR ${e.message}`));
    setTimeout(() => done(false, 'TIMEOUT 10s'), 10_000);
  });
}

async function runProbes(
  saas: NonNullable<ReturnType<typeof parseSaasUrl>>,
  bearer: string,
  label: string,
): Promise<boolean> {
  const headers = {
    Authorization: `Bearer ${bearer}`,
    'User-Agent': 'BCMCPServer/2.0',
    Origin: saas.origin,
  };

  log('');
  log(`--- probes with ${label} ---`);
  const portal = await probeHttp('[1] GET portal', saas.portalUrl, headers);
  const entra = isEntraLogin(portal.location, saas.portalUrl);

  log('');
  const cshHttp = await probeHttp('[2] GET /csh', `${saas.portalUrl}/csh`, headers);

  log('');
  const wsUrl = `${saas.portalUrl.replace(/^http/, 'ws')}/csh?ackseqnb=-1`;
  log(`[3] WS upgrade ${wsUrl}`);
  const ws = await probeWs(wsUrl, headers);
  log(`  ${ws.detail}`);

  if (ws.ok) {
    log(`PASS: /csh opened with ${label}`);
    return true;
  }
  log(`no /csh with ${label}`
    + `${entra ? ' (portal 302 to Entra)' : ''}`
    + `${cshHttp.status === 404 ? ' (GET /csh 404)' : ''}`);
  return false;
}

async function main(): Promise<void> {
  const raw = (process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }

  const tokens = await acquireToken(saas.aadTenantId);
  const accessOk = await runProbes(saas, tokens.accessToken, 'access_token');
  if (accessOk) process.exit(0);

  if (tokens.idToken && tokens.idToken !== tokens.accessToken) {
    const idOk = await runProbes(saas, tokens.idToken, 'id_token');
    if (idOk) process.exit(0);
  } else {
    log('');
    log('no distinct id_token to retry');
  }

  log('');
  log('FAIL: first-party device-code token did not open /csh');
  log('  Interactive login without an Entra app works (Prototype 0+1).');
  log('  /csh still needs the first-party /remote-sign-in cookie session.');
  log('  Per plan: stop. No Puppeteer. Decide later if a bc_query-only SaaS slice is worth merging.');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
