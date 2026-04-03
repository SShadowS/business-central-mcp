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
    expect(config.bc.clientVersionString).toBe('27.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.logging.level).toBe('info');
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
