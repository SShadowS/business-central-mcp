import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConnection } from '../../src/core/connection-resolver.js';
import { ConfigError } from '../../src/core/errors.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeConfig(body: string): string {
  const p = join(dir, 'config.jsonc');
  writeFileSync(p, body);
  return p;
}

const FILE = `{
  // central config
  "default": "cronus28",
  "connections": {
    "cronus28": { "baseUrl": "http://cronus28/BC", "auth": "NavUserPassword",
                  "username": "sshadows", "password": "\${CRONUS28_PW}" },
    "prodA": { "baseUrl": "https://businesscentral.dynamics.com/aad/PROD", "auth": "SaasWeb" }
  },
  "map": [
    { "path": "U:/git/custA/**", "connection": "prodA" }
  ]
}`;

describe('resolveConnection', () => {
  it('returns source:none when no config file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = resolveConnection({ env, cwd: 'U:/git/anything', homeDir: dir });
    expect(r.source).toBe('none');
    expect(r.injected).toEqual([]);
  });

  it('picks the default connection and injects its fields', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: '1234' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(r.source).toBe('default');
    expect(r.connectionName).toBe('cronus28');
    expect(env.BC_BASE_URL).toBe('http://cronus28/BC');
    expect(env.BC_PASSWORD).toBe('1234');
    expect(r.injected).toContain('BC_PASSWORD');
  });

  it('cwd map beats default', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    const r = resolveConnection({ env, cwd: 'U:/git/custA/sub', homeDir: dir });
    expect(r.source).toBe('cwd-map');
    expect(r.connectionName).toBe('prodA');
    expect(env.BC_BASE_URL).toBe('https://businesscentral.dynamics.com/aad/PROD');
  });

  it('BC_CONNECTION selector beats cwd map', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, BC_CONNECTION: 'cronus28', CRONUS28_PW: 'x' };
    const r = resolveConnection({ env, cwd: 'U:/git/custA/sub', homeDir: dir });
    expect(r.source).toBe('env-selector');
    expect(r.connectionName).toBe('cronus28');
  });

  it('does not clobber an already-set field env var', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: '1234', BC_BASE_URL: 'http://override/BC' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(env.BC_BASE_URL).toBe('http://override/BC');
    expect(r.injected).not.toContain('BC_BASE_URL');
  });

  it('throws when the selected connection name is unknown, listing valid names', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, BC_CONNECTION: 'ghost' };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir }))
      .toThrow(/ghost.*cronus28.*prodA/s);
  });

  it('throws ConfigError on malformed JSONC', () => {
    const cfg = writeConfig('{ not json ');
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir })).toThrow(ConfigError);
  });

  it('throws on unresolved ${ENV} in a selected connection', () => {
    const cfg = writeConfig(FILE); // CRONUS28_PW not set
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir })).toThrow(/CRONUS28_PW/);
  });

  it('does not throw on unresolved ${ENV} in a field already overridden by real env', () => {
    const cfg = writeConfig(FILE); // CRONUS28_PW not set
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, BC_PASSWORD: 'preset' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(env.BC_PASSWORD).toBe('preset');
    expect(r.injected).not.toContain('BC_PASSWORD');
  });

  it('throws ConfigError when a connection entry is not an object', () => {
    const cfg = writeConfig('{ "default":"a", "connections": { "a": "not-an-object" } }');
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir })).toThrow(ConfigError);
  });

  it('throws ConfigError when map is not an array', () => {
    const cfg = writeConfig(
      '{ "default":"a", "connections": { "a": { "baseUrl":"http://x/BC" } }, "map": "oops" }',
    );
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir })).toThrow(ConfigError);
  });

  it('warns and skips an unknown field key', () => {
    const cfg = writeConfig('{ "default":"a", "connections": { "a": { "baseUrl":"http://x/BC", "bogus":"y" } } }');
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    const r = resolveConnection({ env, cwd: 'U:/x', homeDir: dir, warn: (m) => warnings.push(m) });
    expect(env.BC_BASE_URL).toBe('http://x/BC');
    expect(warnings.join(' ')).toMatch(/bogus/);
  });

  it('never puts secret values in the injected list', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: 'topsecret' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(r.injected.join(' ')).not.toContain('topsecret');
  });
});
