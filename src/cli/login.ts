import { loadConfig, type AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { isErr } from '../core/result.js';
import { parseSaasUrl } from '../connection/saas-url.js';
import { PlatformBrowserOpener } from '../connection/auth/saas/browser-opener.js';
import { LoginWindow } from '../connection/auth/saas/login-window.js';

/** Optional human shortcut. Agent-started MCP never calls this. */
export async function runLoginCli(config: AppConfig = loadConfig()): Promise<void> {
  const saas = parseSaasUrl(config.bc.baseUrl);
  if (!saas || config.bc.authMode !== 'SaasWeb') {
    process.stderr.write('login is only for BC Online (a businesscentral.dynamics.com URL).\n');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logging);
  const window = new LoginWindow({
    opener: new PlatformBrowserOpener(),
    timeoutMs: 5 * 60_000,
    usernamePrefill: config.bc.username,
    portalUrl: saas.portalUrl,
    stateDir: config.stateDir,
    aadTenantId: saas.aadTenantId,
    environmentName: saas.environmentName,
    logger,
  });

  const result = await window.run();
  if (isErr(result)) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write('Signed in.\n');
}
