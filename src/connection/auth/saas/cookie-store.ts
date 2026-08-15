import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CookieRecord } from './cookie-jar.js';

export const SAAS_COOKIE_FILE = 'saas-web-cookies.json';

export function saasCookieStorePath(stateDir: string): string {
  return join(stateDir, SAAS_COOKIE_FILE);
}

export interface StoredCookies {
  v: 1;
  aadTenantId: string;
  environmentName: string;
  savedAt: number;
  cookies: CookieRecord[];
}

/**
 * Persist portal cookies next to STATE_DIR so an ESTS login survives
 * process restarts. Mode 0600 — the file holds `{tenant}.auth`.
 *
 * Cookies for a different AAD tenant or environment are ignored so a
 * config change cannot reuse a DEV session on production.
 */
export class FileCookieStore {
  constructor(private readonly filePath: string) {}

  load(aadTenantId: string, environmentName: string): CookieRecord[] | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredCookies>;
      if (parsed.v !== 1 || !Array.isArray(parsed.cookies)) return undefined;
      if (parsed.aadTenantId !== aadTenantId || parsed.environmentName !== environmentName) {
        return undefined;
      }
      const cookies = parsed.cookies.filter(isCookieRecord);
      return cookies.length > 0 ? cookies : undefined;
    } catch {
      return undefined;
    }
  }

  save(aadTenantId: string, environmentName: string, cookies: CookieRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: StoredCookies = {
      v: 1,
      aadTenantId,
      environmentName,
      savedAt: Date.now(),
      cookies,
    };
    writeFileSync(this.filePath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows may ignore mode; chmod failure is not fatal.
    }
  }

  clear(): void {
    if (!existsSync(this.filePath)) return;
    try {
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }
}

function isCookieRecord(value: unknown): value is CookieRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Partial<CookieRecord>;
  return typeof rec.name === 'string'
    && typeof rec.value === 'string'
    && typeof rec.domain === 'string'
    && typeof rec.path === 'string'
    && typeof rec.secure === 'boolean';
}
