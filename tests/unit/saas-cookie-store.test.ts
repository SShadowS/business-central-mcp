import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCookieStore } from '../../src/connection/auth/saas/cookie-store.js';
import type { CookieRecord } from '../../src/connection/auth/saas/cookie-jar.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const ENV = 'DEV';

const cookie: CookieRecord = {
  name: `${TENANT}.auth`,
  value: 'sess-value',
  domain: 'businesscentral.dynamics.com',
  path: '/',
  secure: true,
};

describe('FileCookieStore', () => {
  let dir: string;
  let store: FileCookieStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-saas-cookies-'));
    store = new FileCookieStore(join(dir, 'saas-web-cookies.json'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips cookies for the matching tenant and environment', () => {
    store.save(TENANT, ENV, [cookie]);
    expect(store.load(TENANT, ENV)).toEqual([cookie]);
  });

  it('returns undefined for a different tenant or environment', () => {
    store.save(TENANT, ENV, [cookie]);
    expect(store.load('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ENV)).toBeUndefined();
    expect(store.load(TENANT, 'production')).toBeUndefined();
  });

  it('returns undefined for a missing or corrupt file', () => {
    expect(store.load(TENANT, ENV)).toBeUndefined();
    writeFileSync(join(dir, 'saas-web-cookies.json'), '{not json', 'utf8');
    expect(store.load(TENANT, ENV)).toBeUndefined();
  });

  it('does not persist password or JWT fields', () => {
    store.save(TENANT, ENV, [cookie]);
    const raw = JSON.parse(readFileSync(join(dir, 'saas-web-cookies.json'), 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(raw)).not.toMatch(/password|passwd|flowToken|canary/i);
    expect(raw).toMatchObject({ v: 1, aadTenantId: TENANT, environmentName: ENV });
  });

  it('writes mode 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    store.save(TENANT, ENV, [cookie]);
    const mode = statSync(join(dir, 'saas-web-cookies.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('clear() removes the file', () => {
    store.save(TENANT, ENV, [cookie]);
    store.clear();
    expect(store.load(TENANT, ENV)).toBeUndefined();
  });
});
