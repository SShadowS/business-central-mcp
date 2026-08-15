/**
 * Hunt the SaaS /csh endpoint: full env JSON, public HTML/JS, path matrix.
 * Uses the Prototype 0 API token. Does not print secrets or tokens.
 */
import { resolve } from 'node:path';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';

const WELL_KNOWN_CLIENT = '1950a258-227b-4e31-a9cf-717495945fc2';
const DELEGATED_SCOPE = 'https://api.businesscentral.dynamics.com/user_impersonation offline_access';
const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';
const JS_HINT = /csh|websocket|wss:\/\/|clientservices|\/cs\/|signalr|openSession/i;

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function loadApiToken(aadTenantId: string): Promise<string> {
  const cache = new FileTokenCache(resolve(process.env.STATE_DIR || './.state', 'proto-saas-tokens.json'));
  let tokens = cache.load(WELL_KNOWN_CLIENT, aadTenantId);
  if (!tokens) throw new Error('no API token. Run proto-saas-login.ts');
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('token expired');
  const client = new OAuthTokenClient({ aadTenantId, clientId: WELL_KNOWN_CLIENT, scope: DELEGATED_SCOPE });
  const refreshed = await client.refresh(tokens.refreshToken);
  if (isErr(refreshed)) throw new Error(refreshed.error.message);
  cache.save({
    accessToken: refreshed.value.accessToken,
    refreshToken: refreshed.value.refreshToken ?? tokens.refreshToken,
    expiresAt: refreshed.value.expiresAt,
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId,
  });
  return refreshed.value.accessToken;
}

async function main(): Promise<void> {
  const saas = parseSaasUrl((process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, ''));
  if (!saas) throw new Error('bad url');
  const token = await loadApiToken(saas.aadTenantId);
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'BCMCPServer/2.0' };

  log('=== full DEV env (admin) ===');
  const envRes = await fetch(
    `https://api.businesscentral.dynamics.com/admin/v2.28/applications/BusinessCentral/environments/${saas.environmentName}`,
    { headers: auth },
  );
  log(`HTTP ${envRes.status}`);
  const envJson = await envRes.json() as Record<string, unknown>;
  log(JSON.stringify(envJson, null, 2));

  log('\n=== portal HTML (no follow) ===');
  const htmlRes = await fetch(saas.portalUrl, { redirect: 'manual', headers: { ...auth, Origin: saas.origin } });
  log(`HTTP ${htmlRes.status} loc=${htmlRes.headers.get('location')?.split('?')[0] ?? '-'}`);
  // Follow one hop only if same origin; otherwise GET the login-less static bits from root
  const root = await fetch('https://businesscentral.dynamics.com/', { redirect: 'manual', headers: { 'User-Agent': 'BCMCPServer/2.0' } });
  log(`GET / HTTP ${root.status} loc=${root.headers.get('location')?.split('?')[0] ?? '-'}`);
  const rootHtml = await root.text().catch(() => '');
  const scriptSrcs = [...rootHtml.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]!);
  log(`scripts on / : ${scriptSrcs.length}`);
  for (const s of scriptSrcs.slice(0, 30)) log(`  ${s}`);

  const htmlHints = rootHtml.match(/csh|webSocket|clientService|spaInstance/gi);
  log(`html keyword hits: ${htmlHints?.slice(0, 20).join(', ') ?? '(none)'}`);

  log('\n=== path matrix (Bearer + Origin) ===');
  const paths = [
    '/csh',
    `/${saas.aadTenantId}/csh`,
    `/${saas.aadTenantId}/${saas.environmentName}/csh`,
    `/${saas.environmentName}/csh`,
    '/BC/csh',
    '/cs',
    '/cs/csh',
    '/clientservices',
    '/clientservices/csh',
    '/ws/connect',
    `/${saas.aadTenantId}/${saas.environmentName}/ws/connect`,
    '/_remote-sign-in',
    '/remote-sign-in',
  ];
  for (const p of paths) {
    const url = `https://businesscentral.dynamics.com${p}`;
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { ...auth, Origin: saas.origin, 'User-Agent': 'BCMCPServer/2.0' },
    });
    log(`  ${res.status} ${p} loc=${(res.headers.get('location') ?? '').split('?')[0] || '-'} sf=${res.headers.get('x-servicefabric') ?? '-'}`);
    await res.arrayBuffer();
  }
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
