import type { AppConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import type { IBCAuthProvider } from './auth-provider.js';
import { NTLMAuthProvider } from './ntlm-provider.js';
import { OAuthAuthProvider } from './oauth-provider.js';

export function createAuthProvider(config: AppConfig, logger: Logger): IBCAuthProvider {
  if (config.bc.authMode === 'OAuth') {
    const oauth = config.bc.oauth;
    if (!oauth) {
      throw new Error('Internal error: authMode is OAuth but oauth config is missing');
    }
    return new OAuthAuthProvider({
      baseUrl: config.bc.baseUrl,
      aadTenantId: oauth.aadTenantId,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      scope: oauth.scope,
      accessToken: oauth.accessToken,
      stateDir: config.stateDir,
    }, logger);
  }

  return new NTLMAuthProvider({
    baseUrl: config.bc.baseUrl,
    username: config.bc.username,
    password: config.bc.password,
    tenantId: config.bc.tenantId,
  }, logger);
}
