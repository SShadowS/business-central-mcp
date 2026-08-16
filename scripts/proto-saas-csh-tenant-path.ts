/**
 * Retry /csh on /{tenant}/csh (auth-gated 302) vs /{tenant}/{env}/csh (404).
 * Uses both cached tokens. Does not print tokens.
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';
import { requireBaseUrl } from './proto-env.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const API_SCOPE = 'https://api.businesscentral.dynamics.com/user_impersonation offline_access';
const RESOURCE = '996def3d-b36c-4153-8607-a6fd3c01b89f';
const RES_SCOPE = `${RESOURCE}/.default offline_access`;

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function load(file: string, aadTenantId: string, scope: string): Promise<string | undefined> {
  const cache = new FileTokenCache(resolve(process.env.STATE_DIR || './.state', file));
  let tokens = cache.load(WELL_KNOWN_CLIENT, aadTenantId);
  if (!tokens) return undefined;
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) return undefined;
  const client = new OAuthTokenClient({ aadTenantId, clientId: WELL_KNOWN_CLIENT, scope });
  const refreshed = await client.refresh(tokens.refreshToken);
  if (isErr(refreshed)) return undefined;
  cache.save({
    accessToken: refreshed.value.accessToken,
    refreshToken: refreshed.value.refreshToken ?? tokens.refreshToken,
    expiresAt: refreshed.value.expiresAt,
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId,
  });
  return refreshed.value.accessToken;
}

function probeWs(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(url, { headers });
    const done = (d: string) => { try { ws.close(); } catch { /* */ } resolveWs(d); };
    ws.on('open', () => done('OPEN 101'));
    ws.on('unexpected-response', (_req, res) => done(`REJECTED HTTP ${res.statusCode} ${res.statusMessage ?? ''}`));
    ws.on('error', (e) => done(`ERROR ${e.message}`));
    setTimeout(() => done('TIMEOUT'), 8_000);
  });
}

async function http(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { redirect: 'manual', headers });
  const loc = (res.headers.get('location') ?? '').split('?')[0];
  const line = `HTTP ${res.status} loc=${loc || '-'} sf=${res.headers.get('x-servicefabric') ?? '-'}`;
  await res.arrayBuffer();
  return line;
}

async function main(): Promise<void> {
  const saas = parseSaasUrl(requireBaseUrl());
  if (!saas) throw new Error('bad url');
  const apiTok = await load('proto-saas-tokens.json', saas.aadTenantId, API_SCOPE);
  const resTok = await load('proto-saas-tokens-aud-996def3d.json', saas.aadTenantId, RES_SCOPE);
  log(`api token: ${apiTok ? 'yes' : 'NO'}  996def3d-aud token: ${resTok ? 'yes' : 'NO'}`);

  const paths = [
    `https://businesscentral.dynamics.com/${saas.aadTenantId}/csh`,
    `https://businesscentral.dynamics.com/${saas.aadTenantId}/csh?ackseqnb=-1`,
    `https://businesscentral.dynamics.com/${saas.aadTenantId}/${saas.environmentName}/csh`,
    `https://businesscentral.dynamics.com/${saas.aadTenantId}/${saas.environmentName}/?`,
  ];

  const tokens: Array<[string, string]> = [];
  if (apiTok) tokens.push(['api-aud', apiTok]);
  if (resTok) tokens.push(['996def3d-aud', resTok]);

  let opened = false;
  for (const [label, tok] of tokens) {
    const headers = {
      Authorization: `Bearer ${tok}`,
      Origin: saas.origin,
      'User-Agent': 'BCMCPServer/2.0',
    };
    log(`\n=== ${label} ===`);
    for (const url of paths) {
      log(`GET ${url}`);
      log(`  ${await http(url, headers)}`);
    }
    const wsUrls = [
      `wss://businesscentral.dynamics.com/${saas.aadTenantId}/csh?ackseqnb=-1`,
      `wss://businesscentral.dynamics.com/${saas.aadTenantId}/${saas.environmentName}/csh?ackseqnb=-1`,
    ];
    for (const w of wsUrls) {
      const r = await probeWs(w, headers);
      log(`WS ${w.replace('wss://businesscentral.dynamics.com', '')} → ${r}`);
      if (r.startsWith('OPEN')) opened = true;
    }
  }

  if (opened) {
    log('\nPASS: /csh opened on tenant-level path');
    process.exit(0);
  }
  log('\nFAIL: tenant-level /csh still not open with Bearer');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
