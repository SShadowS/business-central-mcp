import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load a .env file into `env` before connection resolution, without ever
 * overriding a variable that is already set. Path is BC_ENV_FILE if set,
 * otherwise <cwd>/.env. A missing file is a silent no-op.
 */
export function loadDotenv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { loaded: boolean; path: string | undefined } {
  const path = env.BC_ENV_FILE || join(cwd, '.env');
  if (!existsSync(path)) return { loaded: false, path: undefined };
  dotenvConfig({ path, override: false, processEnv: env });
  return { loaded: true, path };
}
