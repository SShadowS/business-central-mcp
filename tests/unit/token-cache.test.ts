import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenCache, FilePendingDeviceCache } from '../../src/connection/auth/token-cache.js';

const CLIENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('FileTokenCache', () => {
  let dir: string;
  let cache: FileTokenCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-'));
    cache = new FileTokenCache(join(dir, 'oauth-tokens.json'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips tokens for the matching client/tenant', () => {
    cache.save({
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresAt: 123,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    expect(cache.load(CLIENT, TENANT)).toEqual({
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresAt: 123,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
  });

  it('ignores a cache written for a different client', () => {
    cache.save({
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresAt: 123,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    expect(cache.load('other-client', TENANT)).toBeUndefined();
  });

  it('returns undefined for a missing or corrupt file', () => {
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
    const bad = new FileTokenCache(join(dir, 'oauth-tokens.json'));
    // write garbage via save then overwrite
    cache.save({
      accessToken: 'tok',
      refreshToken: undefined,
      expiresAt: 1,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    // chmod is not the point — corrupt JSON:
    writeFileSync(join(dir, 'oauth-tokens.json'), '{not json', 'utf8');
    expect(bad.load(CLIENT, TENANT)).toBeUndefined();
  });

  it('clear() removes the file', () => {
    cache.save({
      accessToken: 'tok',
      refreshToken: undefined,
      expiresAt: 1,
      clientId: CLIENT,
      aadTenantId: TENANT,
    });
    cache.clear();
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
  });
});

describe('FilePendingDeviceCache', () => {
  let dir: string;
  let cache: FilePendingDeviceCache;

  const PENDING = {
    deviceCode: 'dev-code',
    userCode: 'ABC-123',
    verificationUri: 'https://microsoft.com/devicelogin',
    intervalSec: 5,
    expiresAt: 999_999,
    clientId: CLIENT,
    aadTenantId: TENANT,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-oauth-pending-'));
    cache = new FilePendingDeviceCache(join(dir, 'oauth-pending.json'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a pending device code', () => {
    cache.save(PENDING);
    expect(cache.load(CLIENT, TENANT)).toEqual(PENDING);
  });

  it('defaults intervalSec to 5 when missing on disk', () => {
    const { intervalSec: _drop, ...withoutInterval } = PENDING;
    writeFileSync(join(dir, 'oauth-pending.json'), JSON.stringify(withoutInterval), 'utf8');
    expect(cache.load(CLIENT, TENANT)?.intervalSec).toBe(5);
  });

  it('ignores a pending entry for a different client or tenant', () => {
    cache.save(PENDING);
    expect(cache.load('other-client', TENANT)).toBeUndefined();
    expect(cache.load(CLIENT, 'other-tenant')).toBeUndefined();
  });

  it('returns undefined for a missing, corrupt, or malformed file', () => {
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
    writeFileSync(join(dir, 'oauth-pending.json'), '{not json', 'utf8');
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
    writeFileSync(join(dir, 'oauth-pending.json'), JSON.stringify({ deviceCode: 42 }), 'utf8');
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
  });

  it('clear() removes the file and tolerates a missing file', () => {
    cache.save(PENDING);
    cache.clear();
    expect(cache.load(CLIENT, TENANT)).toBeUndefined();
    cache.clear();
  });
});
