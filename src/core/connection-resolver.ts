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
