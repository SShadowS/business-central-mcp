import { loadConfig, type AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { isErr } from '../core/result.js';
import { createAuthProvider } from '../connection/auth/create-auth-provider.js';
import { PlatformBrowserOpener } from '../connection/auth/saas/browser-opener.js';

/** Optional human shortcut. Agent-started MCP never calls this. */
export async function runLoginCli(config: AppConfig = loadConfig()): Promise<void> {
  if (config.bc.authMode !== 'SaasWeb') {
    process.stderr.write('login is only for BC Online (a businesscentral.dynamics.com URL).\n');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logging);
  const provider = createAuthProvider(config, logger, {
    opener: new PlatformBrowserOpener(),
  });
  const result = await provider.authenticate();
  if (isErr(result)) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write('Signed in.\n');
}
