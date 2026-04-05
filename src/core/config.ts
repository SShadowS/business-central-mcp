export interface BCConfig {
  baseUrl: string;
  username: string;
  password: string;
  tenantId: string;
  clientVersionString: string;
  serverMajor: number;
  timeoutMs: number;
  invokeTimeoutMs: number;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
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

  return {
    bc: {
      baseUrl: requireEnv('BC_BASE_URL'),
      username: requireEnv('BC_USERNAME'),
      password: requireEnv('BC_PASSWORD'),
      tenantId: optionalEnv('BC_TENANT_ID', 'default'),
      clientVersionString: optionalEnv('BC_CLIENT_VERSION', '27.0.0.0'),
      serverMajor: optionalEnvInt('BC_SERVER_MAJOR', 27),
      timeoutMs: optionalEnvInt('BC_TIMEOUT', 120000),
      invokeTimeoutMs: optionalEnvInt('BC_INVOKE_TIMEOUT', 30000),
      reconnectMaxRetries: optionalEnvInt('BC_RECONNECT_MAX_RETRIES', 4),
      reconnectBaseDelayMs: optionalEnvInt('BC_RECONNECT_BASE_DELAY', 1000),
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
