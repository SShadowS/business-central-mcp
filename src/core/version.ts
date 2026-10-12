import { createRequire } from 'node:module';

/**
 * Server version, read from package.json at runtime. `../../package.json`
 * resolves to the repo root from both `src/core/` (tsx, vitest) and
 * `dist/core/` (published build — npm always ships package.json).
 */
export const SERVER_VERSION: string =
  (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
