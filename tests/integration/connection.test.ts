import { describe, it, expect, beforeAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { isOk } from '../../src/core/result.js';

dotenvConfig();

describe('BC Connection (integration)', () => {
  let factory: ConnectionFactory;

  beforeAll(() => {
    const appConfig = loadConfig();
    const logger = createNullLogger();
    const auth = new NTLMAuthProvider({
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    }, logger);
    factory = new ConnectionFactory(auth, appConfig.bc, logger);
  });

  it('authenticates and connects WebSocket to BC', async () => {
    const result = await factory.create();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.isConnected).toBe(true);
      result.value.close();
    }
  });
});
