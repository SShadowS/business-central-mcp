/**
 * Prototype A1 — device code as Azure PowerShell public client,
 * audience = first-party BC resource 996def3d-… (not the API host).
 *
 *   npx tsx scripts/proto-saas-aud-996def3d.ts
 *
 * Complete the device-code prompt in your browser. Then the script
 * decodes JWT aud/scp (not the token) and retries portal + /csh.
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient, type TokenSet } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const RESOURCE = '996def3d-b36c-4153-8607-a6fd3c01b89f';
const SCOPE = `${RESOURCE}/.default offline_access`;
const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';
const CACHE_FILE = 'proto-saas-tokens-aud-996def3d.json';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function printClaims(token: string): void {
  const c = jwtClaims(token);
  const pick = ['aud', 'appid', 'azp', 'scp', 'roles', 'tid', 'iss', 'ver'];
  for (const k of pick) {
    if (c[k] !== undefined) log(`  jwt.${k}=${JSON.stringify(c[k])}`);
  }
}

async function acquire(aadTenantId: string): Promise<TokenSet> {
  const cache = new FileTokenCache(resolve(process.env.STATE_DIR || './.state', CACHE_FILE));
  const client = new OAuthTokenClient({
    aadTenantId,
    clientId: WELL_KNOWN_CLIENT,
    scope: SCOPE,
  });
  const existing = cache.load(WELL_KNOWN_CLIENT, aadTenantId);
  if (existing && existing.expiresAt - 60_000 > Date.now()) {
    log('using cached 996def3d-audience token');
    return {
      accessToken: existing.accessToken,
      refreshToken: existing.refreshToken,
      expiresAt: existing.expiresAt,
      tokenType: 'Bearer',
    };
  }
  if (existing?.refreshToken) {
    log('refreshing 996def3d-audience token…');
    const refreshed = await client.refresh(existing.refreshToken);
    if (!isErr(refreshed)) {
      cache.save({
        accessToken: refreshed.value.accessToken,
        refreshToken: refreshed.value.refreshToken ?? existing.refreshToken,
        expiresAt: refreshed.value.expiresAt,
        clientId: WELL_KNOWN_CLIENT,
        aadTenantId,
      });
      return refreshed.value;
    }
    log(`refresh failed (${refreshed.error.message}); new device code`);
  }

  log('Prototype A1: device code, public client, aud=996def3d');
  log(`client=${WELL_KNOWN_CLIENT}`);
  log(`scope=${SCOPE}`);
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
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId,
  });
  log('got access_token + refresh (not printed)');
  return tokens.value;
}

async function probeHttp(label: string, url: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', headers });
  log(label);
  log(`  HTTP ${res.status} ${res.statusText}`);
  const loc = res.headers.get('location');
  if (loc) log(`  Location: ${loc.split('?')[0]}`);
  const sf = res.headers.get('x-servicefabric');
  if (sf) log(`  x-servicefabric: ${sf}`);
  const names = (res.headers.getSetCookie?.() ?? []).map((c) => c.split('=')[0]).join(', ');
  log(`  Set-Cookie names: ${names || '(none)'}`);
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

  const tokens = await acquire(saas.aadTenantId);
  log('');
  log('token claims (no token printed):');
  printClaims(tokens.accessToken);

  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'User-Agent': 'BCMCPServer/2.0',
    Origin: saas.origin,
  };
  log('');
  const portalStatus = await probeHttp('[1] GET portal', saas.portalUrl, headers);
  log('');
  const cshStatus = await probeHttp('[2] GET /csh', `${saas.portalUrl}/csh`, headers);
  log('');
  const wsUrl = `${saas.portalUrl.replace(/^http/, 'ws')}/csh?ackseqnb=-1`;
  log(`[3] WS ${wsUrl}`);
  const ws = await probeWs(wsUrl, headers);
  log(`  ${ws}`);

  if (ws.startsWith('OPEN')) {
    log('PASS: /csh opened with 996def3d-audience token');
    process.exit(0);
  }
  log('FAIL: 996def3d-audience token did not open /csh');
  if (portalStatus === 302) log('  portal still 302 to Entra');
  if (cshStatus === 404) log('  GET /csh still 404');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
