/**
 * Prototype 2 — portal GET + /csh with the Prototype 0 API token.
 *
 *   npx tsx scripts/proto-saas-csh.ts
 *
 * Prints status, Location, cookie names (not values), and WS upgrade result.
 * Does not print the token.
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';
import { requireBaseUrl } from './proto-env.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const DELEGATED_SCOPE = 'https://api.businesscentral.dynamics.com/user_impersonation offline_access';

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
    const next = new URL(location, base);
    const host = next.hostname.toLowerCase();
    return host === 'login.microsoftonline.com'
      || host === 'login.microsoft.com'
      || host === 'login.windows.net'
      || host.endsWith('.microsoftonline.com');
  } catch {
    return false;
  }
}

async function loadToken(aadTenantId: string): Promise<string> {
  const stateDir = resolve(process.env.STATE_DIR || './.state');
  const cache = new FileTokenCache(resolve(stateDir, 'proto-saas-tokens.json'));
  let tokens = cache.load(WELL_KNOWN_CLIENT, aadTenantId);
  if (!tokens) {
    throw new Error('no cached token. Run: npx tsx scripts/proto-saas-login.ts');
  }
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new Error('access token expired and no refresh_token. Re-run proto-saas-login.ts');
  }
  log('access token expired; refreshing…');
  const client = new OAuthTokenClient({
    aadTenantId,
    clientId: WELL_KNOWN_CLIENT,
    scope: DELEGATED_SCOPE,
  });
  const refreshed = await client.refresh(tokens.refreshToken);
  if (isErr(refreshed)) throw new Error(`refresh: ${refreshed.error.message}`);
  cache.save({
    accessToken: refreshed.value.accessToken,
    refreshToken: refreshed.value.refreshToken ?? tokens.refreshToken,
    expiresAt: refreshed.value.expiresAt,
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId,
  });
  return refreshed.value.accessToken;
}

async function probeHttp(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; location: string | null; cookies: string[] }> {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', headers });
  const location = res.headers.get('location');
  const cookies = cookieNames(res.headers.getSetCookie?.() ?? []);
  log(`${label}`);
  log(`  URL ${url}`);
  log(`  HTTP ${res.status} ${res.statusText}`);
  if (location) log(`  Location: ${location.split('?')[0]}`);
  log(`  Set-Cookie names: ${cookies.length ? cookies.join(', ') : '(none)'}`);
  const sf = res.headers.get('x-servicefabric');
  if (sf) log(`  x-servicefabric: ${sf}`);
  await res.arrayBuffer();
  return { status: res.status, location, cookies };
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

async function main(): Promise<void> {
  const raw = requireBaseUrl();
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }

  const token = await loadToken(saas.aadTenantId);
  const origin = saas.origin;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'BCMCPServer/2.0',
    Origin: origin,
  };

  log('Prototype 2: portal + /csh with API Bearer token');
  log(`tenant=${saas.aadTenantId} env=${saas.environmentName}`);
  log('');

  const portal = await probeHttp('[1] GET portal', saas.portalUrl, authHeaders);
  let entraRedirect = isEntraLogin(portal.location, saas.portalUrl);

  if (portal.status >= 300 && portal.status < 400 && portal.location && !entraRedirect) {
    const next = new URL(portal.location, saas.portalUrl);
    if (next.hostname === new URL(saas.portalUrl).hostname
      || next.hostname.endsWith('.businesscentral.dynamics.com')) {
      log('');
      const follow = await probeHttp('[1b] follow same-origin redirect', next.toString(), authHeaders);
      entraRedirect = isEntraLogin(follow.location, next.toString());
    }
  }

  log('');
  const cshHttp = await probeHttp('[2] GET /csh (no upgrade)', `${saas.portalUrl}/csh`, authHeaders);

  log('');
  const wsUrl = `${saas.portalUrl.replace(/^http/, 'ws')}/csh?ackseqnb=-1`;
  log(`[3] WS upgrade ${wsUrl}`);
  const ws = await probeWs(wsUrl, authHeaders);
  log(`  ${ws.detail}`);

  log('');
  if (ws.ok) {
    log('PASS: /csh WebSocket upgrade succeeded with the API Bearer token');
    process.exit(0);
  }

  log('FAIL: API Bearer token did not open /csh');
  if (entraRedirect) log('  portal still redirected to Entra login (/remote-sign-in path)');
  if (cshHttp.status === 404) log('  GET /csh is still 404 (front door did not route a session)');
  log('  Next if you want it: Prototype 3 (device code as first-party client 996def3d)');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
