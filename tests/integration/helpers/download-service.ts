import { config as dotenvConfig } from 'dotenv';
import { BCHttpClient } from '../../../src/connection/bc-http.js';
import { DownloadService } from '../../../src/services/download-service.js';
import { loadConfig, type BCConfig } from '../../../src/core/config.js';
import type { Logger } from '../../../src/core/logger.js';

// `stubDownloadService` calls `loadConfig()`, which requires BC_BASE_URL etc.
// to already be in process.env. Integration tests run in a single shared
// process (vitest.integration.config.ts: fileParallelism:false, isolate:false),
// and not every test file that now uses this helper called `dotenvConfig()`
// itself -- historically only files that needed live config did. Loading here,
// once, as a module-level side effect makes env availability independent of
// which test file happens to import this helper first.
dotenvConfig();

/**
 * A DownloadService wired to a real BCHttpClient whose auth-headers accessor
 * is a stub (`() => ({})`). Every integration test in this suite that only
 * exercises RunReportOperation/ExecuteActionOperation/RespondDialogOperation/
 * WizardNavigateOperation constructor plumbing -- but never drives a flow that
 * emits a FileDownloadReady/UriToShow event -- never triggers DownloadService.capture()'s
 * http.get() call, so the stub auth headers are never actually used. Kept as a real
 * BCHttpClient (not a mock) to match the constructor shape exactly.
 */
export function stubDownloadService(logger: Logger): DownloadService {
  const cfg = loadConfig();
  const http = new BCHttpClient(cfg.bc.baseUrl, () => ({}), logger);
  return new DownloadService(http, cfg.bc.baseUrl, cfg.bc.downloadLimits, logger);
}

/**
 * A DownloadService wired to a real BCHttpClient with a real auth-headers
 * accessor, for tests that actually fetch a downloaded file's bytes over HTTP.
 */
export function realDownloadService(
  cfg: BCConfig,
  authHeaders: () => Record<string, string>,
  logger: Logger,
): DownloadService {
  const http = new BCHttpClient(cfg.baseUrl, authHeaders, logger);
  return new DownloadService(http, cfg.baseUrl, cfg.downloadLimits, logger);
}
