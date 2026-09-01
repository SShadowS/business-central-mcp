import { ConfigError } from './errors.js';

/** Connection field name -> the env var loadConfig() reads. */
export const FIELD_TO_ENV: Record<string, string> = {
  baseUrl: 'BC_BASE_URL',
  auth: 'BC_AUTH',
  username: 'BC_USERNAME',
  password: 'BC_PASSWORD',
  tenantId: 'BC_TENANT_ID',
  environment: 'BC_ENVIRONMENT',
  aadTenantId: 'BC_AAD_TENANT_ID',
  clientId: 'BC_CLIENT_ID',
  oauthScope: 'BC_OAUTH_SCOPE',
  profile: 'BC_PROFILE',
  applicationId: 'BC_APPLICATION_ID',
  odataUrl: 'BC_ODATA_URL',
  odataCompany: 'BC_ODATA_COMPANY',
};

/** Expand every ${VAR} against env. Missing/empty -> ConfigError. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new ConfigError(
        `Connection config references \${${name}} but that environment variable is not set`,
      );
    }
    return v;
  });
}

function normalizePath(s: string): string {
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern.length > i + 1 && pattern[i + 1] === '*') {
      // "/**" -> optional "/anything"; bare "**" -> ".*"
      if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?';
      else re += '.*';
      i++; // consume the second '*'
    } else if (pattern[i] === '*') {
      re += '[^/]*';
    } else {
      re += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

/** Case-insensitive glob/prefix match of a working directory to a map pattern. */
export function matchPath(cwd: string, pattern: string): boolean {
  const c = normalizePath(cwd);
  const p = normalizePath(pattern);
  if (!p.includes('*')) {
    return c === p || c.startsWith(p + '/');
  }
  return globToRegExp(p).test(c);
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stripJsonComments } from './jsonc.js';

export type ResolutionSource = 'env-selector' | 'cwd-map' | 'default' | 'none';

export interface ConnectionResolution {
  connectionName: string | undefined;
  source: ResolutionSource;
  configPath: string | undefined;
  injected: string[];
}

export interface ResolveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  warn?: (msg: string) => void;
}

interface ConfigFile {
  default?: string;
  connections?: Record<string, Record<string, string>>;
  map?: Array<{ path: string; connection: string }>;
}

function findConfigFile(env: NodeJS.ProcessEnv, home: string, cwd: string): string | undefined {
  const candidates = [
    env.BC_MCP_CONFIG,
    join(home, '.bc-mcp', 'config.jsonc'),
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'bc-mcp', 'config.jsonc') : undefined,
    join(cwd, '.bc-mcp.jsonc'),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c));
}

function warnLoosePerms(file: string, warn: (m: string) => void): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      warn(`connection config ${file} is mode ${mode.toString(8)}; tighten to 0600 to protect credentials`);
    }
  } catch { /* stat failure is non-fatal */ }
}

export function resolveConnection(opts: ResolveOptions = {}): ConnectionResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`[config] ${m}\n`));

  const file = findConfigFile(env, home, cwd);
  if (!file) return { connectionName: undefined, source: 'none', configPath: undefined, injected: [] };

  warnLoosePerms(file, warn);

  let doc: ConfigFile;
  try {
    doc = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as ConfigFile;
  } catch {
    throw new ConfigError(`Failed to parse connection config ${file} (invalid JSON)`);
  }

  if (
    doc.connections !== undefined &&
    (typeof doc.connections !== 'object' || doc.connections === null || Array.isArray(doc.connections))
  ) {
    throw new ConfigError(`Connection config ${file} has an invalid 'connections' value (expected an object)`);
  }
  const connections = doc.connections ?? {};

  let name: string | undefined;
  let source: ResolutionSource;
  if (env.BC_CONNECTION) {
    name = env.BC_CONNECTION;
    source = 'env-selector';
  } else {
    if (doc.map !== undefined && !Array.isArray(doc.map)) {
      throw new ConfigError(`Connection config ${file} has an invalid 'map' value (expected an array)`);
    }
    const hit = (doc.map ?? []).find((m) => matchPath(cwd, m.path));
    if (hit) { name = hit.connection; source = 'cwd-map'; }
    else if (doc.default) { name = doc.default; source = 'default'; }
    else { return { connectionName: undefined, source: 'none', configPath: file, injected: [] }; }
  }

  const conn = connections[name];
  if (!conn) {
    const valid = Object.keys(connections).join(', ') || '(none defined)';
    throw new ConfigError(`Connection '${name}' not found in ${file}. Valid connections: ${valid}`);
  }
  if (typeof conn !== 'object' || conn === null || Array.isArray(conn)) {
    throw new ConfigError(`Connection '${name}' in ${file} has an invalid value (expected an object)`);
  }

  const injected: string[] = [];
  for (const [field, rawVal] of Object.entries(conn)) {
    const key = FIELD_TO_ENV[field];
    if (!key) { warn(`unknown field '${field}' in connection '${name}' (ignored)`); continue; }
    if (env[key] === undefined) {
      env[key] = expandEnv(String(rawVal), env);
      injected.push(key);
    }
  }

  return { connectionName: name, source, configPath: file, injected };
}
