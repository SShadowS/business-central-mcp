/**
 * Prototype 0 — device-code login against a SaaS portal URL.
 *
 * No Entra app registration. Uses the well-known Azure PowerShell public
 * client (same default as New-BcAuthContext -includeDeviceLogin).
 *
 * Not wired into the MCP server. Prints the Microsoft device-code prompt
 * on stderr; writes tokens to STATE_DIR without printing them.
 *
 *   npx tsx scripts/proto-saas-login.ts
 *   BC_BASE_URL=https://businesscentral.dynamics.com/{tenant}/{env} npx tsx scripts/proto-saas-login.ts
 */
import { resolve } from 'node:path';
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

async function main(): Promise<void> {
  const raw = (process.env.BC_BASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const saas = parseSaasUrl(raw);
  if (!saas) {
    log(`FAIL: not a SaaS portal URL: ${raw}`);
    process.exit(1);
  }

  const stateDir = resolve(process.env.STATE_DIR || './.state');
  const cache = new FileTokenCache(resolve(stateDir, 'proto-saas-tokens.json'));
  const existing = cache.load(WELL_KNOWN_CLIENT, saas.aadTenantId);
  if (existing && existing.expiresAt - 60_000 > Date.now()) {
    log(`PASS: cached token still valid (expires in ${Math.round((existing.expiresAt - Date.now()) / 1000)}s)`);
    log(`tenant=${saas.aadTenantId} env=${saas.environmentName} hasRefresh=${Boolean(existing.refreshToken)}`);
    process.exit(0);
  }

  const client = new OAuthTokenClient({
    aadTenantId: saas.aadTenantId,
    clientId: WELL_KNOWN_CLIENT,
    scope: DELEGATED_SCOPE,
  });

  log(`Prototype 0: device-code login`);
  log(`tenant=${saas.aadTenantId} env=${saas.environmentName}`);
  log(`client=${WELL_KNOWN_CLIENT} (Azure PowerShell well-known public app)`);
  log('');

  const started = await client.startDeviceCode();
  if (isErr(started)) {
    log(`FAIL: device-code start: ${started.error.message}`);
    process.exit(1);
  }

  log(started.value.message);
  log('');
  log(`Open: ${started.value.verificationUri}`);
  log(`Code: ${started.value.userCode}`);
  log(`Waiting for you to sign in (timeout ${Math.round((started.value.expiresAt - Date.now()) / 1000)}s)…`);

  const tokens = await client.pollDeviceCode(started.value);
  if (isErr(tokens)) {
    log(`FAIL: ${tokens.error.message}`);
    process.exit(1);
  }

  cache.save({
    accessToken: tokens.value.accessToken,
    refreshToken: tokens.value.refreshToken,
    expiresAt: tokens.value.expiresAt,
    clientId: WELL_KNOWN_CLIENT,
    aadTenantId: saas.aadTenantId,
  });

  log(`PASS: got access_token + ${tokens.value.refreshToken ? 'refresh_token' : 'no refresh_token'}`);
  log(`cached at ${resolve(stateDir, 'proto-saas-tokens.json')} (not printed)`);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
