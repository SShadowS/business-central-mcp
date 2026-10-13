import { deriveODataUrl } from '../../src/odata/odata-client.js';
import type { BCConfig } from '../../src/core/config.js';

/**
 * An on-prem (NavUserPassword) BCConfig with loadConfig()'s defaults. Typed as
 * the real BCConfig, so a field added there fails the typecheck here, not in
 * every test that hand-writes the literal.
 */
export function makeTestBCConfig(overrides: Partial<BCConfig> = {}): BCConfig {
  const baseUrl = overrides.baseUrl ?? 'http://cronus28/BC';
  return {
    baseUrl,
    username: 'u',
    password: 'p',
    tenantId: 'default',
    environmentName: undefined,
    authMode: 'NavUserPassword',
    oauth: undefined,
    appendTenantQuery: true,
    profile: '',
    applicationId: 'FIN',
    clientVersionString: '28.0.0.0',
    serverMajor: 28,
    timeoutMs: 120_000,
    invokeTimeoutMs: 30_000,
    isExecutingPollIntervalMs: 10_000,
    invokeMaxDurationMs: 600_000,
    reconnectMaxRetries: 4,
    reconnectBaseDelayMs: 1000,
    odataUrl: deriveODataUrl(baseUrl),
    odataCompanyName: undefined,
    downloadLimits: { maxBytes: 5_242_880, maxTotalBytes: 10_485_760, maxDownloads: 5, dir: undefined },
    maxSelection: 100,
    ...overrides,
  };
}
