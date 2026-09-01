import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotenv } from '../../src/core/dotenv-loader.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcenv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loadDotenv', () => {
  it('is a no-op when no .env exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotenv(env, dir);
    expect(r.loaded).toBe(false);
    expect(env.BC_CONNECTION).toBeUndefined();
  });

  it('loads cwd/.env into the given env', () => {
    writeFileSync(join(dir, '.env'), 'BC_CONNECTION=prodB\n');
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotenv(env, dir);
    expect(r.loaded).toBe(true);
    expect(env.BC_CONNECTION).toBe('prodB');
  });

  it('does not override an already-set variable', () => {
    writeFileSync(join(dir, '.env'), 'BC_CONNECTION=fromfile\n');
    const env: NodeJS.ProcessEnv = { BC_CONNECTION: 'preset' };
    loadDotenv(env, dir);
    expect(env.BC_CONNECTION).toBe('preset');
  });

  it('honors BC_ENV_FILE over cwd/.env', () => {
    const custom = join(dir, 'custom.env');
    writeFileSync(custom, 'BC_CONNECTION=custom\n');
    const env: NodeJS.ProcessEnv = { BC_ENV_FILE: custom };
    loadDotenv(env, dir);
    expect(env.BC_CONNECTION).toBe('custom');
  });
});
