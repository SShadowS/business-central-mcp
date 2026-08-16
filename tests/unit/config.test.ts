import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { BC_API_DELEGATED_SCOPE } from '../../src/connection/auth/oauth-defaults.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BC_BASE_URL = 'http://test/BC';
    process.env.BC_USERNAME = 'testuser';
    process.env.BC_PASSWORD = 'testpass';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads required values from env', () => {
    const config = loadConfig();
    expect(config.bc.baseUrl).toBe('http://test/BC');
    expect(config.bc.username).toBe('testuser');
    expect(config.bc.password).toBe('testpass');
  });

  it('throws on missing BC_BASE_URL', () => {
    delete process.env.BC_BASE_URL;
    expect(() => loadConfig()).toThrow('BC_BASE_URL');
  });

  it('throws on missing BC_USERNAME', () => {
    delete process.env.BC_USERNAME;
    expect(() => loadConfig()).toThrow('BC_USERNAME');
  });

  it('throws on missing BC_PASSWORD', () => {
    delete process.env.BC_PASSWORD;
    expect(() => loadConfig()).toThrow('BC_PASSWORD');
  });

  it('uses defaults for optional values', () => {
    const config = loadConfig();
    expect(config.bc.tenantId).toBe('default');
    expect(config.bc.clientVersionString).toBe('28.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.logging.level).toBe('info');
  });

  it('strips trailing slashes from BC_BASE_URL', () => {
    process.env.BC_BASE_URL = 'https://demoportaldev.continiaonline.com/eae32d34-6603-4490-b967-0e064de52c3f/';
    expect(loadConfig().bc.baseUrl).toBe('https://demoportaldev.continiaonline.com/eae32d34-6603-4490-b967-0e064de52c3f');
  });

  it('strips multiple trailing slashes from BC_BASE_URL', () => {
    process.env.BC_BASE_URL = 'http://test/BC///';
    expect(loadConfig().bc.baseUrl).toBe('http://test/BC');
  });

  it('overrides optional values from env', () => {
    process.env.BC_TENANT_ID = 'custom';
    process.env.PORT = '4000';
    process.env.LOG_LEVEL = 'debug';
    const config = loadConfig();
    expect(config.bc.tenantId).toBe('custom');
    expect(config.port).toBe(4000);
    expect(config.logging.level).toBe('debug');
  });

  it('defaults authMode to NavUserPassword for on-prem URLs', () => {
    expect(loadConfig().bc.authMode).toBe('NavUserPassword');
    expect(loadConfig().bc.appendTenantQuery).toBe(true);
  });
});

describe('loadConfig OAuth / SaaS', () => {
  const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BC_USERNAME;
    delete process.env.BC_PASSWORD;
    delete process.env.BC_AAD_TENANT_ID;
    delete process.env.BC_CLIENT_ID;
    delete process.env.BC_AUTH;
    delete process.env.BC_ODATA_URL;
    delete process.env.BC_ENVIRONMENT;
    delete process.env.BC_TENANT_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('auto-selects SaasWeb for a businesscentral.dynamics.com URL and parses tenant/env', () => {
    process.env.BC_BASE_URL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
    const c = loadConfig();
    expect(c.bc.authMode).toBe('SaasWeb');
    expect(c.bc.tenantId).toBe(TENANT);
    expect(c.bc.environmentName).toBe('DEV');
    expect(c.bc.baseUrl).toBe(`https://businesscentral.dynamics.com/${TENANT}/DEV`);
    expect(c.bc.odataUrl).toBe(`https://api.businesscentral.dynamics.com/v2.0/${TENANT}/DEV`);
    expect(c.bc.appendTenantQuery).toBe(false);
    expect(c.bc.oauth).toBeUndefined();
    expect(c.bc.username).toBe('');
    expect(c.bc.password).toBe('');
  });

  it('populates oauth on SaaS when BC_CLIENT_ID is set', () => {
    process.env.BC_BASE_URL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
    process.env.BC_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
    expect(loadConfig().bc.oauth).toEqual({
      aadTenantId: TENANT,
      clientId: '11111111-1111-1111-1111-111111111111',
      scope: BC_API_DELEGATED_SCOPE,
    });
  });

  it('does not require BC_USERNAME/BC_PASSWORD for SaaS', () => {
    process.env.BC_BASE_URL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
    expect(() => loadConfig()).not.toThrow();
  });

  it('ignores BC_PASSWORD on a SaaS URL', () => {
    process.env.BC_BASE_URL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
    process.env.BC_PASSWORD = 'leak';
    expect(loadConfig().bc.password).toBe('');
  });

  it('BC_AUTH=OAuth on an on-prem URL requires BC_AAD_TENANT_ID', () => {
    process.env.BC_BASE_URL = 'http://cronus28/BC';
    process.env.BC_AUTH = 'OAuth';
    expect(() => loadConfig()).toThrow('BC_AAD_TENANT_ID');
  });

  it('BC_AUTH=OAuth requires BC_CLIENT_ID', () => {
    process.env.BC_BASE_URL = 'http://cronus28/BC';
    process.env.BC_AUTH = 'OAuth';
    process.env.BC_AAD_TENANT_ID = TENANT;
    expect(() => loadConfig()).toThrow('BC_CLIENT_ID');
  });

  it('BC_AUTH=OAuth uses BC_CLIENT_ID once tenant and client are set', () => {
    process.env.BC_BASE_URL = 'http://cronus28/BC';
    process.env.BC_AUTH = 'OAuth';
    process.env.BC_AAD_TENANT_ID = TENANT;
    process.env.BC_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
    const c = loadConfig();
    expect(c.bc.authMode).toBe('OAuth');
    expect(c.bc.oauth?.clientId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('BC_AUTH=NavUserPassword keeps requiring username/password even for a SaaS URL', () => {
    process.env.BC_BASE_URL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
    process.env.BC_AUTH = 'NavUserPassword';
    expect(() => loadConfig()).toThrow('BC_USERNAME');
  });
});

describe('download limits', () => {
  const KEYS = ['BC_MAX_DOWNLOAD_BYTES', 'BC_MAX_DOWNLOAD_TOTAL_BYTES', 'BC_MAX_DOWNLOADS', 'BC_DOWNLOAD_DIR', 'BC_REPORT_DIR', 'BC_BASE_URL', 'BC_USERNAME', 'BC_PASSWORD'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); KEYS.forEach(k => delete process.env[k]); });
  afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('defaults to 5MB / 10MB / 5 / no dir', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_USERNAME = 'test';
    process.env.BC_PASSWORD = 'test';
    const c = loadConfig();
    expect(c.bc.downloadLimits).toEqual({ maxBytes: 5242880, maxTotalBytes: 10485760, maxDownloads: 5, dir: undefined });
  });

  it('BC_DOWNLOAD_DIR wins over BC_REPORT_DIR', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_USERNAME = 'test';
    process.env.BC_PASSWORD = 'test';
    process.env.BC_REPORT_DIR = '/reports';
    process.env.BC_DOWNLOAD_DIR = '/downloads';
    expect(loadConfig().bc.downloadLimits.dir).toBe('/downloads');
  });

  it('falls back to BC_REPORT_DIR when BC_DOWNLOAD_DIR unset', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_USERNAME = 'test';
    process.env.BC_PASSWORD = 'test';
    process.env.BC_REPORT_DIR = '/reports';
    expect(loadConfig().bc.downloadLimits.dir).toBe('/reports');
  });
});

describe('max selection', () => {
  const KEYS = ['BC_MAX_SELECTION', 'BC_BASE_URL', 'BC_USERNAME', 'BC_PASSWORD'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); KEYS.forEach(k => delete process.env[k]); });
  afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('defaults BC_MAX_SELECTION to 100', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_USERNAME = 'test';
    process.env.BC_PASSWORD = 'test';
    expect(loadConfig().bc.maxSelection).toBe(100);
  });
  it('reads BC_MAX_SELECTION from env', () => {
    process.env.BC_BASE_URL = 'http://x/BC';
    process.env.BC_USERNAME = 'test';
    process.env.BC_PASSWORD = 'test';
    process.env.BC_MAX_SELECTION = '25';
    expect(loadConfig().bc.maxSelection).toBe(25);
  });
});
