import type { AppConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import { parseSaasUrl } from '../saas-url.js';
import type { IBCAuthProvider } from './auth-provider.js';
import { NTLMAuthProvider } from './ntlm-provider.js';
import { OAuthAuthProvider } from './oauth-provider.js';
import { SaasWebSessionProvider } from './saas-web-session-provider.js';
import type { BrowserOpener } from './saas/browser-opener.js';
import { PlatformBrowserOpener } from './saas/browser-opener.js';
import type { LoginFn } from './saas/login-window.js';
import type { ClientElicitationPort } from '../../mcp/elicitation-port.js';

export interface SaasWebOpts {
  opener?: BrowserOpener;
  fetchFn?: typeof fetch;
  elicitation?: ClientElicitationPort;
  loginTimeoutMs?: number;
  loginFn?: LoginFn;
}

export function createAuthProvider(
  config: AppConfig,
  logger: Logger,
  saasOpts?: SaasWebOpts,
): IBCAuthProvider {
  switch (config.bc.authMode) {
    case 'OAuth': {
      const oauth = config.bc.oauth;
      if (!oauth) {
        throw new Error('Internal error: authMode is OAuth but oauth config is missing');
      }
      return new OAuthAuthProvider({
        baseUrl: config.bc.baseUrl,
        aadTenantId: oauth.aadTenantId,
        tenantId: config.bc.tenantId,
        clientId: oauth.clientId,
        scope: oauth.scope,
        stateDir: config.stateDir,
      }, logger);
    }
    case 'NavUserPassword':
      return new NTLMAuthProvider({
        baseUrl: config.bc.baseUrl,
        username: config.bc.username,
        password: config.bc.password,
        tenantId: config.bc.tenantId,
      }, logger);
    case 'SaasWeb': {
      const saas = parseSaasUrl(config.bc.baseUrl);
      if (!saas) {
        throw new Error(
          'authMode is SaasWeb but BC_BASE_URL is not a businesscentral.dynamics.com portal URL.',
        );
      }
      return new SaasWebSessionProvider({
        saas,
        stateDir: config.stateDir,
        usernamePrefill: config.bc.username,
        loginTimeoutMs: saasOpts?.loginTimeoutMs ?? 5 * 60_000,
        opener: saasOpts?.opener ?? new PlatformBrowserOpener(),
        elicitation: saasOpts?.elicitation,
        fetchFn: saasOpts?.fetchFn,
        loginFn: saasOpts?.loginFn,
        logger,
      });
    }
    default: {
      const _exhaustive: never = config.bc.authMode;
      throw new Error(`Unknown authMode: ${String(_exhaustive)}`);
    }
  }
}

export function composeAuthProviders(
  config: AppConfig,
  logger: Logger,
  elicitation: ClientElicitationPort,
): { uiAuth: IBCAuthProvider; apiAuth: IBCAuthProvider } {
  const uiAuth = createAuthProvider(config, logger, { elicitation });
  const apiAuth = config.bc.oauth
    ? new OAuthAuthProvider({
        baseUrl: config.bc.baseUrl,
        aadTenantId: config.bc.oauth.aadTenantId,
        tenantId: config.bc.tenantId,
        clientId: config.bc.oauth.clientId,
        scope: config.bc.oauth.scope,
        stateDir: config.stateDir,
      }, logger)
    : uiAuth;
  return { uiAuth, apiAuth };
}
