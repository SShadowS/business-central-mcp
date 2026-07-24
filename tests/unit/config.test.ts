import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

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
});

describe('download limits', () => {
  const KEYS = ['BC_MAX_DOWNLOAD_BYTES', 'BC_MAX_DOWNLOAD_TOTAL_BYTES', 'BC_MAX_DOWNLOADS', 'BC_DOWNLOAD_DIR', 'BC_REPORT_DIR'];
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
