import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CachedTokens {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number;
  clientId: string;
  aadTenantId: string;
}

/**
 * Persist OAuth tokens next to STATE_DIR so a device-code login survives
 * process restarts. Mode 0600 — the file holds a refresh token.
 *
 * Tokens for a different clientId/tenant are ignored so a config change
 * cannot reuse a grant issued to another app.
 */
export class FileTokenCache {
  constructor(private readonly filePath: string) {}

  load(clientId: string, aadTenantId: string): CachedTokens | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CachedTokens>;
      if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') {
        return undefined;
      }
      if (parsed.clientId !== clientId || parsed.aadTenantId !== aadTenantId) {
        return undefined;
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
        expiresAt: parsed.expiresAt,
        clientId: parsed.clientId,
        aadTenantId: parsed.aadTenantId,
      };
    } catch {
      return undefined;
    }
  }

  save(tokens: CachedTokens): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(tokens), { encoding: 'utf8', mode: 0o600 });
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
