import { describe, it, expect } from 'vitest';
import { createAuthProvider, composeAuthProviders } from '../../src/connection/auth/create-auth-provider.js';
import { ClientElicitationPort } from '../../src/mcp/elicitation-port.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { OAuthAuthProvider } from '../../src/connection/auth/oauth-provider.js';
import { SaasWebSessionProvider } from '../../src/connection/auth/saas-web-session-provider.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { AppConfig } from '../../src/core/config.js';

function app(overrides: Partial<AppConfig['bc']> & { authMode: AppConfig['bc']['authMode'] }): AppConfig {
  return {
    bc: {
      baseUrl: 'http://cronus28/BC',
      username: 'u',
      password: 'p',
      tenantId: 'default',
      environmentName: undefined,
      oauth: undefined,
      appendTenantQuery: true,
      profile: '',
      applicationId: 'FIN',
      clientVersionString: '28.0.0.0',
      serverMajor: 28,
      timeoutMs: 1000,
      invokeTimeoutMs: 1000,
      reconnectMaxRetries: 0,
      reconnectBaseDelayMs: 0,
      odataUrl: 'http://cronus28:7048/BC',
      odataCompanyName: undefined,
      downloadLimits: { maxBytes: 1, maxTotalBytes: 1, maxDownloads: 1, dir: undefined },
      maxSelection: 100,
      ...overrides,
    },
    logging: { level: 'error', channels: '', dir: '/tmp', redactValues: false },
    server: { bindAddress: '127.0.0.1', diagnosticsEnabled: false },
    port: 3000,
    stateDir: '/tmp',
  };
}

describe('createAuthProvider', () => {
  it('returns NTLMAuthProvider for NavUserPassword', () => {
    const p = createAuthProvider(app({ authMode: 'NavUserPassword' }), createNullLogger());
    expect(p).toBeInstanceOf(NTLMAuthProvider);
  });

  it('returns SaasWebSessionProvider for SaasWeb without extra deps', () => {
    const p = createAuthProvider(app({
      authMode: 'SaasWeb',
      baseUrl: 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV',
    }), createNullLogger());
    expect(p).toBeInstanceOf(SaasWebSessionProvider);
  });

  it('throws when SaasWeb URL is not a portal URL', () => {
    expect(() => createAuthProvider(app({
      authMode: 'SaasWeb',
      baseUrl: 'https://example.com/not-saas',
    }), createNullLogger())).toThrow(/portal URL/);
  });

  it('returns OAuthAuthProvider for OAuth', () => {
    const p = createAuthProvider(app({
      authMode: 'OAuth',
      oauth: {
        aadTenantId: '7bcb54ae-6d5e-43c7-9402-928aed68ad00',
        clientId: 'c',
        scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
      },
    }), createNullLogger());
    expect(p).toBeInstanceOf(OAuthAuthProvider);
  });
});

describe('composeAuthProviders', () => {
  const OAUTH = {
    aadTenantId: '7bcb54ae-6d5e-43c7-9402-928aed68ad00',
    clientId: 'c',
    scope: 'https://api.businesscentral.dynamics.com/user_impersonation offline_access',
  };

  it('OAuth mode shares ONE provider for UI and API (same token/pending files)', () => {
    // Two instances over the same oauth-tokens.json race refresh rotation
    // and clobber each other's pending device codes.
    const { uiAuth, apiAuth } = composeAuthProviders(
      app({ authMode: 'OAuth', oauth: OAUTH }),
      createNullLogger(),
      new ClientElicitationPort(),
    );
    expect(uiAuth).toBeInstanceOf(OAuthAuthProvider);
    expect(apiAuth).toBe(uiAuth);
  });

  it('SaasWeb mode keeps a distinct OAuth provider for bc_query', () => {
    const { uiAuth, apiAuth } = composeAuthProviders(
      app({
        authMode: 'SaasWeb',
        baseUrl: 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV',
        oauth: OAUTH,
      }),
      createNullLogger(),
      new ClientElicitationPort(),
    );
    expect(uiAuth).toBeInstanceOf(SaasWebSessionProvider);
    expect(apiAuth).toBeInstanceOf(OAuthAuthProvider);
    expect(apiAuth).not.toBe(uiAuth);
  });

  it('SaasWeb mode without BC_CLIENT_ID falls back to the UI provider', () => {
    const { uiAuth, apiAuth } = composeAuthProviders(
      app({
        authMode: 'SaasWeb',
        baseUrl: 'https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV',
      }),
      createNullLogger(),
      new ClientElicitationPort(),
    );
    expect(apiAuth).toBe(uiAuth);
  });
});
