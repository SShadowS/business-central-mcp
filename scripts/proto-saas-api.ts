/**
 * Prototype 1 — call the official SaaS API with the Prototype 0 token.
 *
 *   npx tsx scripts/proto-saas-api.ts
 *
 * GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/companies
 * Prints status + company names. Does not print the token.
 */
import { resolve } from 'node:path';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { BC_API_DELEGATED_SCOPE, BC_API_PUBLIC_CLIENT_ID } from '../src/connection/auth/oauth-defaults.js';
import { OAuthTokenClient } from '../src/connection/auth/oauth-token-client.js';
import { FileTokenCache } from '../src/connection/auth/token-cache.js';
import { isErr } from '../src/core/result.js';
const DEFAULT_URL = 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const raw = (process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }

  const stateDir = resolve(process.env.STATE_DIR || './.state');
  const cachePath = resolve(stateDir, 'proto-saas-tokens.json');
  const cache = new FileTokenCache(cachePath);
  let tokens = cache.load(BC_API_PUBLIC_CLIENT_ID, saas.aadTenantId);
  if (!tokens) {
    log('FAIL: no cached token. Run: npx tsx scripts/proto-saas-login.ts');
    process.exit(1);
  }

  const client = new OAuthTokenClient({
    aadTenantId: saas.aadTenantId,
    clientId: BC_API_PUBLIC_CLIENT_ID,
    scope: BC_API_DELEGATED_SCOPE,
  });

  if (tokens.expiresAt - 60_000 <= Date.now()) {
    if (!tokens.refreshToken) {
      log('FAIL: access token expired and no refresh_token. Re-run proto-saas-login.ts');
      process.exit(1);
    }
    log('access token expired; refreshing…');
    const refreshed = await client.refresh(tokens.refreshToken);
    if (isErr(refreshed)) {
      log(`FAIL: refresh: ${refreshed.error.message}`);
      process.exit(1);
    }
    tokens = {
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken ?? tokens.refreshToken,
      expiresAt: refreshed.value.expiresAt,
      clientId: BC_API_PUBLIC_CLIENT_ID,
      aadTenantId: saas.aadTenantId,
    };
    cache.save(tokens);
  }

  const url = `${saas.odataUrl}/api/v2.0/companies`;
  log(`Prototype 1: GET ${url}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json',
    },
  });

  const wwwAuth = response.headers.get('www-authenticate');
  log(`HTTP ${response.status} ${response.statusText}`);
  if (wwwAuth) log(`WWW-Authenticate: ${wwwAuth}`);

  let bodyText = await response.text();
  let names: string[] = [];
  try {
    const json = JSON.parse(bodyText) as {
      value?: Array<{ name?: string; displayName?: string }>;
      error?: { code?: string; message?: string };
    };
    if (json.error) {
      log(`BC error: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim());
    }
    names = (json.value ?? [])
      .map((c) => c.name || c.displayName || '')
      .filter(Boolean);
  } catch {
    const clipped = bodyText.replace(/\s+/g, ' ').slice(0, 240);
    if (clipped) log(`body (truncated): ${clipped}`);
  }

  if (!response.ok) {
    log('FAIL: API did not accept the device-code token');
    process.exit(1);
  }

  log(`PASS: ${names.length} compan${names.length === 1 ? 'y' : 'ies'}${names.length ? `: ${names.join(', ')}` : ''}`);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
