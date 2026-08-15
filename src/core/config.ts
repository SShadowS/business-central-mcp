import { deriveODataUrl } from '../odata/odata-client.js';
import { parseSaasUrl } from '../connection/saas-url.js';

export type AuthMode = 'NavUserPassword' | 'OAuth';

export interface OAuthConfig {
  aadTenantId: string;
  clientId: string;
  clientSecret: string | undefined;
  scope: string;
  accessToken: string | undefined;
}

export interface BCConfig {
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
  /** SaaS environment name (DEV, sandbox, production). Undefined on-prem. */
  environmentName: string | undefined;
  authMode: AuthMode;
  oauth: OAuthConfig | undefined;
  /** When false, ODataClient does not append ?tenant= (SaaS has tenant in the path). */
  appendTenantQuery: boolean;
  profile: string;
  applicationId: string;
  clientVersionString: string;
  serverMajor: number;
  timeoutMs: number;
  invokeTimeoutMs: number;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
  /** Base URL for the BC OData / Standard API endpoint (port 7048).
   *  Derived from baseUrl by injecting port 7048 if BC_ODATA_URL is not set.
   *  SaaS portal URLs derive https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}. */
  odataUrl: string;
  /** Company name for OData queries. Omit to use the first available company. */
  odataCompanyName: string | undefined;
  downloadLimits: {
    maxBytes: number;
    maxTotalBytes: number;
    maxDownloads: number;
    /** Directory to write captured downloads to. undefined = no disk write. */
    dir: string | undefined;
  };
  /** Max bookmarks accepted in one multi-row selection (bc_execute_action bookmarks[]). */
  maxSelection: number;
}

export interface LoggingConfig {
  level: string;
  channels: string;
  dir: string;
  redactValues: boolean;
}

export interface ServerConfig {
  bindAddress: string;
  diagnosticsEnabled: boolean;
  apiToken?: string;
}

export interface AppConfig {
  bc: BCConfig;
  logging: LoggingConfig;
  server: ServerConfig;
  port: number;
  stateDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set. See .env.example for configuration.`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return parsed;
}

function optionalEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(): AppConfig {
  const bindAddress = optionalEnv('BIND_ADDRESS', '127.0.0.1');
  const apiToken = process.env.API_TOKEN;

  if (bindAddress !== '127.0.0.1' && bindAddress !== 'localhost' && !apiToken) {
    throw new Error('API_TOKEN is required when BIND_ADDRESS is non-loopback');
  }

  const rawBaseUrl = requireEnv('BC_BASE_URL').replace(/\/+$/, '');
  const saas = parseSaasUrl(rawBaseUrl);
  const resolved = resolveAuth(saas);

  return {
    bc: {
      baseUrl: saas ? saas.portalUrl : rawBaseUrl,
      username: resolved.username,
      password: resolved.password,
      tenantId: resolved.tenantId,
      environmentName: resolved.environmentName,
      authMode: resolved.authMode,
      oauth: resolved.oauth,
      appendTenantQuery: resolved.appendTenantQuery,
      profile: optionalEnv('BC_PROFILE', ''),
      applicationId: optionalEnv('BC_APPLICATION_ID', 'FIN'),
      clientVersionString: optionalEnv('BC_CLIENT_VERSION', '28.0.0.0'),
      serverMajor: optionalEnvInt('BC_SERVER_MAJOR', 28),
      timeoutMs: optionalEnvInt('BC_TIMEOUT', 120000),
      invokeTimeoutMs: optionalEnvInt('BC_INVOKE_TIMEOUT', 30000),
      reconnectMaxRetries: optionalEnvInt('BC_RECONNECT_MAX_RETRIES', 4),
      reconnectBaseDelayMs: optionalEnvInt('BC_RECONNECT_BASE_DELAY', 1000),
      odataUrl: deriveODataUrl(saas ? saas.portalUrl : rawBaseUrl),
      odataCompanyName: process.env.BC_ODATA_COMPANY || undefined,
      downloadLimits: {
        maxBytes: optionalEnvInt('BC_MAX_DOWNLOAD_BYTES', 5_242_880),
        maxTotalBytes: optionalEnvInt('BC_MAX_DOWNLOAD_TOTAL_BYTES', 10_485_760),
        maxDownloads: optionalEnvInt('BC_MAX_DOWNLOADS', 5),
        dir: process.env['BC_DOWNLOAD_DIR'] || process.env['BC_REPORT_DIR'] || undefined,
      },
      maxSelection: optionalEnvInt('BC_MAX_SELECTION', 100),
    },
    logging: {
      level: optionalEnv('LOG_LEVEL', 'info'),
      channels: optionalEnv('LOG_CHANNELS', ''),
      dir: optionalEnv('LOG_DIR', './logs'),
      redactValues: optionalEnvBool('LOG_REDACT_VALUES', false),
    },
    server: {
      bindAddress,
      diagnosticsEnabled: optionalEnvBool('DIAGNOSTICS_ENABLED', false),
      apiToken,
    },
    port: optionalEnvInt('PORT', 3000),
    stateDir: optionalEnv('STATE_DIR', './.state'),
  };
}

const DELEGATED_SCOPE = 'https://api.businesscentral.dynamics.com/user_impersonation offline_access';
const APP_SCOPE = 'https://api.businesscentral.dynamics.com/.default';

function resolveAuthMode(raw: string | undefined, isSaas: boolean): AuthMode {
  const value = (raw ?? 'auto').trim().toLowerCase();
  if (value === 'oauth' || value === 'aad' || value === 'entra') return 'OAuth';
  if (value === 'navuserpassword' || value === 'userpassword' || value === 'password') {
    return 'NavUserPassword';
  }
  return isSaas ? 'OAuth' : 'NavUserPassword';
}

function resolveAuth(saas: ReturnType<typeof parseSaasUrl>): {
  authMode: AuthMode;
  username: string;
  password: string;
  tenantId: string;
  environmentName: string | undefined;
  oauth: OAuthConfig | undefined;
  appendTenantQuery: boolean;
} {
  const authMode = resolveAuthMode(process.env.BC_AUTH, saas !== undefined);
  const environmentName = process.env.BC_ENVIRONMENT || saas?.environmentName;
  const tenantId = process.env.BC_TENANT_ID || saas?.aadTenantId || 'default';

  if (authMode === 'NavUserPassword') {
    return {
      authMode,
      username: requireEnv('BC_USERNAME'),
      password: requireEnv('BC_PASSWORD'),
      tenantId,
      environmentName,
      oauth: undefined,
      appendTenantQuery: saas === undefined,
    };
  }

  const clientId = process.env.BC_CLIENT_ID ?? '';
  const accessToken = process.env.BC_ACCESS_TOKEN || undefined;
  if (!clientId && !accessToken) {
    throw new Error(
      'OAuth is selected (SaaS URL or BC_AUTH=OAuth) but neither BC_CLIENT_ID nor BC_ACCESS_TOKEN is set. '
      + 'Register an Entra app with Dynamics 365 Business Central API permissions, then set BC_CLIENT_ID. '
      + 'Device code (delegated): allow public-client flows and grant user_impersonation. '
      + 'Client credentials (S2S): create a client secret, grant API.ReadWrite.All, consent the app, '
      + 'and register it on the Microsoft Entra Applications page in BC. See README.',
    );
  }

  const aadTenantId = process.env.BC_AAD_TENANT_ID || saas?.aadTenantId || process.env.BC_TENANT_ID || '';
  if (!aadTenantId && !accessToken) {
    throw new Error(
      'OAuth requires the Entra tenant id. Use a SaaS URL '
      + '(https://businesscentral.dynamics.com/{tenant}/{environment}) or set BC_AAD_TENANT_ID.',
    );
  }

  const clientSecret = process.env.BC_CLIENT_SECRET || undefined;
  const defaultScope = clientSecret ? APP_SCOPE : DELEGATED_SCOPE;

  return {
    authMode,
    username: optionalEnv('BC_USERNAME', ''),
    password: optionalEnv('BC_PASSWORD', ''),
    tenantId,
    environmentName,
    oauth: {
      aadTenantId,
      clientId,
      clientSecret,
      scope: process.env.BC_OAUTH_SCOPE || defaultScope,
      accessToken,
    },
    appendTenantQuery: saas === undefined,
  };
}
