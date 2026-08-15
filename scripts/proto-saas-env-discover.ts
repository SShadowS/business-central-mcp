/**
 * Prototype A2 — discover environment / cluster URLs with the Prototype 0 API token.
 * Then retry /csh on any host that is not the Front Door portal we already 404'd.
 *
 *   npx tsx scripts/proto-saas-env-discover.ts
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const DELEGATED_SCOPE = 'https://api.businesscentral.dynamics.com/user_impersonation offline_access';
const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function loadApiToken(aadTenantId: string): Promise<string> {
  const cache = new FileTokenCache(resolve(process.env.STATE_DIR || './.state', 'proto-saas-tokens.json'));
  let tokens = cache.load(WELL_KNOWN_CLIENT, aadTenantId);
  if (!tokens) throw new Error('no API token cache. Run proto-saas-login.ts');
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('API token expired; re-run proto-saas-login.ts');
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

function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectUrls(v, into);
  }
}

function summarize(value: unknown, indent = '  '): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    log(`${indent}[${value.length} items]`);
    if (value[0]) summarize(value[0], indent + '  ');
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      log(`${indent}${k}: null`);
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      log(`${indent}${k}: ${v}`);
    } else if (Array.isArray(v)) {
      log(`${indent}${k}: array(${v.length})`);
      if (v[0] && typeof v[0] === 'object') summarize(v[0], indent + '  ');
    } else {
      log(`${indent}${k}:`);
      summarize(v, indent + '  ');
    }
  }
}

async function getJson(url: string, token: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
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
    setTimeout(() => done('TIMEOUT'), 8_000);
  });
}

function cshCandidates(saasPortal: string, urls: Set<string>): string[] {
  const portalOrigin = new URL(saasPortal).origin;
  const bases = new Set<string>();
  for (const u of urls) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { continue; }
    if (parsed.hostname === 'api.businesscentral.dynamics.com') continue;
    if (parsed.hostname === 'login.microsoftonline.com') continue;
    const origin = parsed.origin;
    if (origin === portalOrigin) {
      // already probed as Front Door
      continue;
    }
    bases.add(`${origin}${parsed.pathname.replace(/\/+$/, '')}`);
  }
  return [...bases];
}

async function main(): Promise<void> {
  const raw = (process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }
  const token = await loadApiToken(saas.aadTenantId);
  log('Prototype A2: environment discovery');
  log(`tenant=${saas.aadTenantId} env=${saas.environmentName}`);
  log('');

  const endpoints = [
    'https://api.businesscentral.dynamics.com/environments/v1.2',
    'https://api.businesscentral.dynamics.com/environments/v1.1',
    `https://api.businesscentral.dynamics.com/admin/v2.28/applications/BusinessCentral/environments`,
    `https://api.businesscentral.dynamics.com/admin/v2.28/applications/BusinessCentral/environments/${saas.environmentName}`,
  ];

  const allUrls = new Set<string>();
  for (const url of endpoints) {
    log(`GET ${url}`);
    const { status, json, text } = await getJson(url, token);
    log(`  HTTP ${status}`);
    if (!json) {
      log(`  body: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      log('');
      continue;
    }
    summarize(json);
    collectUrls(json, allUrls);
    log('');
  }

  log(`URL-shaped fields found (${allUrls.size}):`);
  for (const u of allUrls) log(`  ${u}`);

  const extra = cshCandidates(saas.portalUrl, allUrls);
  log('');
  if (extra.length === 0) {
    log('FAIL: no alternate host for /csh (only portal Front Door and/or api.businesscentral.dynamics.com)');
    process.exit(1);
  }

  let opened = false;
  for (const base of extra) {
    const httpCsh = `${base.replace(/\/csh$/, '')}/csh`;
    log(`GET ${httpCsh}`);
    const res = await fetch(httpCsh, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: new URL(base).origin,
        'User-Agent': 'BCMCPServer/2.0',
      },
    });
    log(`  HTTP ${res.status} sf=${res.headers.get('x-servicefabric') ?? '-'}`);
    await res.arrayBuffer();
    const wsUrl = `${httpCsh.replace(/^http/, 'ws')}?ackseqnb=-1`;
    const ws = await probeWs(wsUrl, {
      Authorization: `Bearer ${token}`,
      Origin: new URL(base).origin,
    });
    log(`  WS ${ws}`);
    if (ws.startsWith('OPEN')) opened = true;
  }

  if (opened) {
    log('PASS: /csh opened on a discovered host');
    process.exit(0);
  }
  log('FAIL: discovered hosts did not accept /csh with the API token');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
