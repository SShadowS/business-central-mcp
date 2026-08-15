import type { AppConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';
import type { Result } from '../../core/result.js';
import type { AuthenticationError, SignInRequiredError, UrlElicitationRequiredError } from '../../core/errors.js';
import { parseSaasUrl } from '../saas-url.js';
import type { IBCAuthProvider } from './auth-provider.js';
import { NTLMAuthProvider } from './ntlm-provider.js';
import { OAuthAuthProvider } from './oauth-provider.js';
import { SaasWebSessionProvider } from './saas-web-session-provider.js';
import type { BrowserOpener } from './saas/browser-opener.js';
import { PlatformBrowserOpener } from './saas/browser-opener.js';
import { LoginWindow } from './saas/login-window.js';
import type { ClientElicitationPort } from '../../mcp/elicitation-port.js';

export interface SaasWebDeps {
  opener: BrowserOpener;
  /** PR 5 default: load cookie store or SignInRequiredError.
   *  PR 6: () => loginWindow.run() (may return UrlElicitationRequiredError). */
  ensurePortalSession: () => Promise<
    Result<void, SignInRequiredError | AuthenticationError | UrlElicitationRequiredError>
  >;
  fetchFn?: typeof fetch;
  elicitation?: ClientElicitationPort;
  loginTimeoutMs?: number;
}

export function createAuthProvider(
  config: AppConfig,
  logger: Logger,
  saasDeps?: SaasWebDeps,
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
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        scope: oauth.scope,
        accessToken: oauth.accessToken,
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
      if (!saasDeps) {
        throw new Error(
          'authMode is SaasWeb but createAuthProvider was called without SaasWebDeps. '
          + 'Pass opener + ensurePortalSession (see stdio-server / server composition).',
        );
      }
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
        loginTimeoutMs: saasDeps.loginTimeoutMs ?? 5 * 60_000,
        opener: saasDeps.opener,
        ensurePortalSession: saasDeps.ensurePortalSession,
        elicitation: saasDeps.elicitation,
        fetchFn: saasDeps.fetchFn,
        logger,
      });
    }
    default: {
      const _exhaustive: never = config.bc.authMode;
      throw new Error(`Unknown authMode: ${String(_exhaustive)}`);
    }
  }
}

export function buildSaasWebDeps(
  config: AppConfig,
  logger: Logger,
  elicitation: ClientElicitationPort,
  fetchFn?: typeof fetch,
): SaasWebDeps {
  const saas = parseSaasUrl(config.bc.baseUrl);
  if (!saas) {
    throw new Error('buildSaasWebDeps requires a SaaS portal URL');
  }
  const opener = new PlatformBrowserOpener();
  const loginTimeoutMs = 5 * 60_000;
  const loginWindow = new LoginWindow({
    opener,
    timeoutMs: loginTimeoutMs,
    usernamePrefill: config.bc.username,
    portalUrl: saas.portalUrl,
    stateDir: config.stateDir,
    aadTenantId: saas.aadTenantId,
    environmentName: saas.environmentName,
    elicitation,
    fetchFn,
    logger,
  });
  return {
    opener,
    ensurePortalSession: () => loginWindow.run(),
    elicitation,
    loginTimeoutMs,
    fetchFn,
  };
}

export function composeAuthProviders(
  config: AppConfig,
  logger: Logger,
  elicitation: ClientElicitationPort,
): { uiAuth: IBCAuthProvider; apiAuth: IBCAuthProvider } {
  const saasDeps = config.bc.authMode === 'SaasWeb'
    ? buildSaasWebDeps(config, logger, elicitation)
    : undefined;
  const uiAuth = createAuthProvider(config, logger, saasDeps);
  const apiAuth = config.bc.oauth
    ? new OAuthAuthProvider({
        baseUrl: config.bc.baseUrl,
        aadTenantId: config.bc.oauth.aadTenantId,
        clientId: config.bc.oauth.clientId,
        clientSecret: config.bc.oauth.clientSecret,
        scope: config.bc.oauth.scope,
        accessToken: config.bc.oauth.accessToken,
        stateDir: config.stateDir,
      }, logger)
    : uiAuth;
  return { uiAuth, apiAuth };
}
