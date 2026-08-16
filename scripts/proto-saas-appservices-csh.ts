/**
 * Probe /csh on the appservices cluster hosts discovered from the local
 * Chromium cookie *names* (not values), using the device-code Bearer tokens.
 */
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { isErr } from '../src/core/result.js';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { requireBaseUrl } from './proto-env.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const SAAS = parseSaasUrl(requireBaseUrl());
if (!SAAS) {
  process.stderr.write('FAIL: BC_BASE_URL is not a SaaS portal URL\n');
  process.exit(1);
}
const TENANT = SAAS.aadTenantId;
const HOSTS = [
  'msft1eu2as5743-3mujv5i.appservices.us.businesscentral.dynamics.com',
  'msft1eu2as5632-xlxnecq.appservices.us.businesscentral.dynamics.com',
];

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function token(file: string, scope: string): Promise<string | undefined> {
  const cache = new FileTokenCache(resolve(process.env.STATE_DIR || './.state', file));
  let t = cache.load(WELL_KNOWN_CLIENT, TENANT);
  if (!t) return undefined;
  if (t.expiresAt - 60_000 > Date.now()) return t.accessToken;
  if (!t.refreshToken) return undefined;
  const c = new OAuthTokenClient({ aadTenantId: TENANT, clientId: WELL_KNOWN_CLIENT, scope });
  const r = await c.refresh(t.refreshToken);
  if (isErr(r)) return undefined;
  cache.save({
    accessToken: r.value.accessToken,
    refreshToken: r.value.refreshToken ?? t.refreshToken,
    expiresAt: r.value.expiresAt,
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId: TENANT,
  });
  return r.value.accessToken;
}

function probeWs(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(url, { headers });
    const done = (d: string) => { try { ws.close(); } catch { /* */ } resolveWs(d); };
    ws.on('open', () => done('OPEN 101'));
    ws.on('unexpected-response', (_req, res) => done(`REJECTED HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`ERROR ${e.message}`));
    setTimeout(() => done('TIMEOUT'), 8_000);
  });
}

async function http(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { redirect: 'manual', headers });
  const loc = (res.headers.get('location') ?? '').split('?')[0];
  await res.arrayBuffer();
  return `HTTP ${res.status} loc=${loc || '-'} sf=${res.headers.get('x-servicefabric') ?? '-'}`;
}

async function main(): Promise<void> {
  const api = await token('proto-saas-tokens.json', 'https://api.businesscentral.dynamics.com/user_impersonation offline_access');
  const res = await token('proto-saas-tokens-aud-996def3d.json', '996def3d-b36c-4153-8607-a6fd3c01b89f/.default offline_access');
  log(`tokens api=${api ? 'yes' : 'no'} aud996=${res ? 'yes' : 'no'}`);

  const toks: Array<[string, string]> = [];
  if (api) toks.push(['api', api]);
  if (res) toks.push(['996def3d', res]);

  let opened = false;
  for (const host of HOSTS) {
    log(`\n=== ${host} ===`);
    log(`GET / noauth ${await http(`https://${host}/`, { 'User-Agent': 'BCMCPServer/2.0' })}`);
    log(`GET /csh noauth ${await http(`https://${host}/csh`, { 'User-Agent': 'BCMCPServer/2.0', Origin: `https://${host}` })}`);
    for (const [label, tok] of toks) {
      for (const origin of [`https://${host}`, 'https://businesscentral.dynamics.com']) {
        const headers = {
          Authorization: `Bearer ${tok}`,
          Origin: origin,
          'User-Agent': 'BCMCPServer/2.0',
        };
        log(`GET /csh ${label} Origin=${origin}`);
        log(`  ${await http(`https://${host}/csh`, headers)}`);
        const w = await probeWs(`wss://${host}/csh?ackseqnb=-1`, headers);
        log(`  WS ${w}`);
        if (w.startsWith('OPEN')) opened = true;
      }
    }
  }
  if (opened) {
    log('\nPASS: /csh opened on appservices host with Bearer');
    process.exit(0);
  }
  log('\nFAIL: appservices /csh did not accept Bearer either');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
