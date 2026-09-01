# Central Connection Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one central JSONC file (plus an optional `.env`) define named BC connections that each Claude Code session selects by an explicit `BC_CONNECTION` selector or by its working directory, eliminating the duplicated connection block in every repo's `.mcp.json`.

**Architecture:** Two new steps run at each server entry point before the unchanged `loadConfig()`: `loadDotenv()` loads a `.env`, then `resolveConnection()` reads the central JSONC file, picks a connection, and writes its fields into `process.env` **only where each variable is unset**. Because `process.env` stays the single source of truth, `loadConfig()` and its tests are untouched and the real environment always overrides.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-ins (`node:fs`, `node:path`, `node:os`), existing `dotenv` dependency (v17.4.1), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-central-connection-config-design.md`

## Global Constraints

- ESM project: every relative import ends in `.js`.
- Run `npx tsc --noEmit` after each task; it must pass with zero errors.
- Unit tests only (no BC protocol is touched). Run `npx vitest run <file>`.
- No emojis in any file (Windows rendering).
- Windows paths use forward slashes in bash.
- `src/core/config.ts` and its tests MUST remain unchanged.
- Precedence (highest to lowest): individual field env var > `BC_CONNECTION` selector > cwd `map[]` match > `default` connection > built-in `loadConfig` defaults. Injection into `process.env` is always no-clobber (never overwrite an already-set variable).
- Values are never logged; only env-key names, the chosen connection name, and the config path may appear in logs.

---

### Task 1: Foundation — `ConfigError` and JSONC comment stripping

**Files:**
- Modify: `src/core/errors.ts` (add `ConfigError` after the other `BCError` subclasses)
- Create: `src/core/jsonc.ts`
- Test: `tests/unit/jsonc.test.ts`

**Interfaces:**
- Consumes: `BCError` (abstract base in `src/core/errors.ts`, protected constructor `(message, code, context?)`).
- Produces:
  - `class ConfigError extends BCError` — code `'CONFIG_ERROR'`, constructor `(message: string, context?: Record<string, unknown>)`.
  - `function stripJsonComments(text: string): string` — removes `//` line and `/* */` block comments while preserving comment-like text inside JSON strings.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/jsonc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripJsonComments } from '../../src/core/jsonc.js';

describe('stripJsonComments', () => {
  it('removes line comments', () => {
    expect(stripJsonComments('{"a":1} // trailing')).toBe('{"a":1} ');
  });

  it('removes block comments', () => {
    expect(stripJsonComments('{/* note */"a":1}')).toBe('{"a":1}');
  });

  it('preserves comment-like text inside strings', () => {
    const src = '{"url":"http://x/BC","p":"a//b"}';
    expect(stripJsonComments(src)).toBe(src);
  });

  it('preserves escaped quotes inside strings', () => {
    const src = '{"p":"a\\"// not a comment"}';
    expect(stripJsonComments(src)).toBe(src);
  });

  it('leaves newlines intact when removing line comments', () => {
    expect(stripJsonComments('{\n// c\n"a":1\n}')).toBe('{\n\n"a":1\n}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/jsonc.test.ts`
Expected: FAIL — cannot resolve `../../src/core/jsonc.js`.

- [ ] **Step 3: Implement `stripJsonComments`**

Create `src/core/jsonc.ts`:

```ts
/**
 * Remove // line comments and block comments from JSONC text, leaving the
 * result parseable by JSON.parse. String contents (including comment-like
 * sequences and escaped quotes) are preserved verbatim. Trailing commas are
 * NOT supported — the example config avoids them.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}
```

- [ ] **Step 4: Add `ConfigError` to `src/core/errors.ts`**

Add after the existing `BCError` subclasses (near `MultiRowActionUnavailableError`):

```ts
export class ConfigError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
  }
}
```

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run tests/unit/jsonc.test.ts && npx tsc --noEmit`
Expected: PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/jsonc.ts src/core/errors.ts tests/unit/jsonc.test.ts
git commit -m "feat(config): add ConfigError and JSONC comment stripping"
```

---

### Task 2: Pure resolver helpers — `expandEnv` and `matchPath`

**Files:**
- Create: `src/core/connection-resolver.ts` (partial — helpers + the field map; `resolveConnection` added in Task 3)
- Test: `tests/unit/connection-resolver-helpers.test.ts`

**Interfaces:**
- Consumes: `ConfigError` from `src/core/errors.ts`.
- Produces:
  - `const FIELD_TO_ENV: Record<string, string>` — maps a connection field name to its env var.
  - `function expandEnv(value: string, env: NodeJS.ProcessEnv): string` — replaces every `${VAR}`; throws `ConfigError` if a referenced var is unset or empty; returns a value with no `${` verbatim.
  - `function matchPath(cwd: string, pattern: string): boolean` — case-insensitive, forward-slash-normalized glob/prefix match supporting `*` (within a segment) and `**` (across segments and matching the directory itself).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/connection-resolver-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { expandEnv, matchPath, FIELD_TO_ENV } from '../../src/core/connection-resolver.js';
import { ConfigError } from '../../src/core/errors.js';

describe('expandEnv', () => {
  it('expands a single variable', () => {
    expect(expandEnv('${PW}', { PW: 'secret' })).toBe('secret');
  });
  it('returns non-template values verbatim', () => {
    expect(expandEnv('http://cronus28/BC', {})).toBe('http://cronus28/BC');
  });
  it('throws on a missing variable, naming it', () => {
    expect(() => expandEnv('${NOPE}', {})).toThrow(ConfigError);
    expect(() => expandEnv('${NOPE}', {})).toThrow(/NOPE/);
  });
  it('throws on an empty variable', () => {
    expect(() => expandEnv('${PW}', { PW: '' })).toThrow(ConfigError);
  });
});

describe('matchPath', () => {
  it('matches a ** suffix including the directory itself', () => {
    expect(matchPath('U:/git/custA', 'U:/git/custA/**')).toBe(true);
    expect(matchPath('U:/git/custA/sub', 'U:/git/custA/**')).toBe(true);
  });
  it('is case-insensitive and slash-normalized', () => {
    expect(matchPath('u:\\Git\\CustA\\x', 'U:/git/custA/**')).toBe(true);
  });
  it('matches a single-segment * ', () => {
    expect(matchPath('U:/git/test1/x', 'U:/git/test*/**')).toBe(true);
    expect(matchPath('U:/git/testing', 'U:/git/test*/**')).toBe(true);
  });
  it('does not let * cross a segment boundary', () => {
    expect(matchPath('U:/git/test/a/b', 'U:/git/test*')).toBe(false);
  });
  it('treats a wildcard-free pattern as a prefix', () => {
    expect(matchPath('U:/git/custA/deep', 'U:/git/custA')).toBe(true);
    expect(matchPath('U:/git/custAB', 'U:/git/custA')).toBe(false);
  });
  it('returns false on no match', () => {
    expect(matchPath('U:/git/other', 'U:/git/custA/**')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/connection-resolver-helpers.test.ts`
Expected: FAIL — cannot resolve `../../src/core/connection-resolver.js`.

- [ ] **Step 3: Implement helpers**

Create `src/core/connection-resolver.ts`:

```ts
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
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // "/**" -> optional "/anything"; bare "**" -> ".*"
      if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?';
      else re += '.*';
      i++; // consume the second '*'
    } else if (pattern[i] === '*') {
      re += '[^/]*';
    } else {
      re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
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
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run tests/unit/connection-resolver-helpers.test.ts && npx tsc --noEmit`
Expected: PASS, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/connection-resolver.ts tests/unit/connection-resolver-helpers.test.ts
git commit -m "feat(config): add expandEnv and cwd glob matcher for connection resolution"
```

---

### Task 3: `resolveConnection` orchestration

**Files:**
- Modify: `src/core/connection-resolver.ts` (add file discovery + `resolveConnection`)
- Test: `tests/unit/connection-resolver.test.ts`

**Interfaces:**
- Consumes: `FIELD_TO_ENV`, `expandEnv`, `matchPath` (Task 2); `stripJsonComments` (Task 1); `ConfigError` (Task 1); `node:fs` (`existsSync`, `readFileSync`, `statSync`), `node:path` (`join`), `node:os` (`homedir`).
- Produces:
  - `type ResolutionSource = 'env-selector' | 'cwd-map' | 'default' | 'none'`
  - `interface ConnectionResolution { connectionName: string | undefined; source: ResolutionSource; configPath: string | undefined; injected: string[]; }`
  - `interface ResolveOptions { cwd?: string; env?: NodeJS.ProcessEnv; homeDir?: string; warn?: (msg: string) => void; }`
  - `function resolveConnection(opts?: ResolveOptions): ConnectionResolution` — mutates `opts.env` (default `process.env`) in place, no-clobber. Returns `source:'none'` when no file is found or nothing selects a connection. Throws `ConfigError` on malformed JSONC, unknown connection name, or unresolved `${ENV}`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/connection-resolver.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConnection } from '../../src/core/connection-resolver.js';
import { ConfigError } from '../../src/core/errors.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeConfig(body: string): string {
  const p = join(dir, 'config.jsonc');
  writeFileSync(p, body);
  return p;
}

const FILE = `{
  // central config
  "default": "cronus28",
  "connections": {
    "cronus28": { "baseUrl": "http://cronus28/BC", "auth": "NavUserPassword",
                  "username": "sshadows", "password": "\${CRONUS28_PW}" },
    "prodA": { "baseUrl": "https://businesscentral.dynamics.com/aad/PROD", "auth": "SaasWeb" }
  },
  "map": [
    { "path": "U:/git/custA/**", "connection": "prodA" }
  ]
}`;

describe('resolveConnection', () => {
  it('returns source:none when no config file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = resolveConnection({ env, cwd: 'U:/git/anything', homeDir: dir });
    expect(r.source).toBe('none');
    expect(r.injected).toEqual([]);
  });

  it('picks the default connection and injects its fields', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: '1234' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(r.source).toBe('default');
    expect(r.connectionName).toBe('cronus28');
    expect(env.BC_BASE_URL).toBe('http://cronus28/BC');
    expect(env.BC_PASSWORD).toBe('1234');
    expect(r.injected).toContain('BC_PASSWORD');
  });

  it('cwd map beats default', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    const r = resolveConnection({ env, cwd: 'U:/git/custA/sub', homeDir: dir });
    expect(r.source).toBe('cwd-map');
    expect(r.connectionName).toBe('prodA');
    expect(env.BC_BASE_URL).toBe('https://businesscentral.dynamics.com/aad/PROD');
  });

  it('BC_CONNECTION selector beats cwd map', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, BC_CONNECTION: 'cronus28', CRONUS28_PW: 'x' };
    const r = resolveConnection({ env, cwd: 'U:/git/custA/sub', homeDir: dir });
    expect(r.source).toBe('env-selector');
    expect(r.connectionName).toBe('cronus28');
  });

  it('does not clobber an already-set field env var', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: '1234', BC_BASE_URL: 'http://override/BC' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(env.BC_BASE_URL).toBe('http://override/BC');
    expect(r.injected).not.toContain('BC_BASE_URL');
  });

  it('throws when the selected connection name is unknown, listing valid names', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, BC_CONNECTION: 'ghost' };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir }))
      .toThrow(/ghost.*cronus28.*prodA/s);
  });

  it('throws ConfigError on malformed JSONC', () => {
    const cfg = writeConfig('{ not json ');
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/x', homeDir: dir })).toThrow(ConfigError);
  });

  it('throws on unresolved ${ENV} in a selected connection', () => {
    const cfg = writeConfig(FILE); // CRONUS28_PW not set
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    expect(() => resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir })).toThrow(/CRONUS28_PW/);
  });

  it('warns and skips an unknown field key', () => {
    const cfg = writeConfig('{ "default":"a", "connections": { "a": { "baseUrl":"http://x/BC", "bogus":"y" } } }');
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg };
    const r = resolveConnection({ env, cwd: 'U:/x', homeDir: dir, warn: (m) => warnings.push(m) });
    expect(env.BC_BASE_URL).toBe('http://x/BC');
    expect(warnings.join(' ')).toMatch(/bogus/);
  });

  it('never puts secret values in the injected list', () => {
    const cfg = writeConfig(FILE);
    const env: NodeJS.ProcessEnv = { BC_MCP_CONFIG: cfg, CRONUS28_PW: 'topsecret' };
    const r = resolveConnection({ env, cwd: 'U:/git/misc', homeDir: dir });
    expect(r.injected.join(' ')).not.toContain('topsecret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/connection-resolver.test.ts`
Expected: FAIL — `resolveConnection` is not exported.

- [ ] **Step 3: Implement `resolveConnection`**

Append to `src/core/connection-resolver.ts`:

```ts
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
  } catch (e) {
    throw new ConfigError(`Failed to parse connection config ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const connections = doc.connections ?? {};

  let name: string | undefined;
  let source: ResolutionSource;
  if (env.BC_CONNECTION) {
    name = env.BC_CONNECTION;
    source = 'env-selector';
  } else {
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

  const injected: string[] = [];
  for (const [field, rawVal] of Object.entries(conn)) {
    const key = FIELD_TO_ENV[field];
    if (!key) { warn(`unknown field '${field}' in connection '${name}' (ignored)`); continue; }
    const val = expandEnv(String(rawVal), env);
    if (env[key] === undefined) {
      env[key] = val;
      injected.push(key);
    }
  }

  return { connectionName: name, source, configPath: file, injected };
}
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run tests/unit/connection-resolver.test.ts && npx tsc --noEmit`
Expected: PASS, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/connection-resolver.ts tests/unit/connection-resolver.test.ts
git commit -m "feat(config): resolve named BC connection from central JSONC file"
```

---

### Task 4: `loadDotenv`

**Files:**
- Create: `src/core/dotenv-loader.ts`
- Test: `tests/unit/dotenv-loader.test.ts`

**Interfaces:**
- Consumes: `dotenv` (v17, `config({ path, override, processEnv })`); `node:fs` (`existsSync`), `node:path` (`join`).
- Produces: `function loadDotenv(env?: NodeJS.ProcessEnv, cwd?: string): { loaded: boolean; path: string | undefined }` — loads `env.BC_ENV_FILE` or `<cwd>/.env` with `override:false`; missing file is a silent no-op.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dotenv-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotenv } from '../../src/core/dotenv-loader.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcenv-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loadDotenv', () => {
  it('is a no-op when no .env exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotenv(env, dir);
    expect(r.loaded).toBe(false);
    expect(env.BC_CONNECTION).toBeUndefined();
  });

  it('loads cwd/.env into the given env', () => {
    writeFileSync(join(dir, '.env'), 'BC_CONNECTION=prodB\n');
    const env: NodeJS.ProcessEnv = {};
    const r = loadDotenv(env, dir);
    expect(r.loaded).toBe(true);
    expect(env.BC_CONNECTION).toBe('prodB');
  });

  it('does not override an already-set variable', () => {
    writeFileSync(join(dir, '.env'), 'BC_CONNECTION=fromfile\n');
    const env: NodeJS.ProcessEnv = { BC_CONNECTION: 'preset' };
    loadDotenv(env, dir);
    expect(env.BC_CONNECTION).toBe('preset');
  });

  it('honors BC_ENV_FILE over cwd/.env', () => {
    const custom = join(dir, 'custom.env');
    writeFileSync(custom, 'BC_CONNECTION=custom\n');
    const env: NodeJS.ProcessEnv = { BC_ENV_FILE: custom };
    loadDotenv(env, dir);
    expect(env.BC_CONNECTION).toBe('custom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dotenv-loader.test.ts`
Expected: FAIL — cannot resolve `../../src/core/dotenv-loader.js`.

- [ ] **Step 3: Implement `loadDotenv`**

Create `src/core/dotenv-loader.ts`:

```ts
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load a .env file into `env` before connection resolution, without ever
 * overriding a variable that is already set. Path is BC_ENV_FILE if set,
 * otherwise <cwd>/.env. A missing file is a silent no-op.
 */
export function loadDotenv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): { loaded: boolean; path: string | undefined } {
  const path = env.BC_ENV_FILE || join(cwd, '.env');
  if (!existsSync(path)) return { loaded: false, path: undefined };
  dotenvConfig({ path, override: false, processEnv: env });
  return { loaded: true, path };
}
```

- [ ] **Step 4: Run tests + type check**

Run: `npx vitest run tests/unit/dotenv-loader.test.ts && npx tsc --noEmit`
Expected: PASS, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/dotenv-loader.ts tests/unit/dotenv-loader.test.ts
git commit -m "feat(config): add .env autoloader (override:false)"
```

---

### Task 5: Wire resolution into both entry points

**Files:**
- Modify: `src/stdio-server.ts` (top of `main()`, before the `login` branch and before `loadConfig()`)
- Modify: `src/server.ts` (top of `main()`, before `loadConfig()`)

**Interfaces:**
- Consumes: `loadDotenv` (Task 4), `resolveConnection` (Task 3), `ConfigError` (Task 1).
- Produces: no new exports. Behavior: on startup both servers load `.env`, resolve the connection into `process.env`, then call the unchanged `loadConfig()`; the chosen connection is logged at info; a `ConfigError` surfaces through the existing top-level `main().catch` as a one-line `[FATAL]` message.

- [ ] **Step 1: Add imports to `src/stdio-server.ts`**

After the `import { loadConfig } from './core/config.js';` line add:

```ts
import { loadDotenv } from './core/dotenv-loader.js';
import { resolveConnection } from './core/connection-resolver.js';
```

- [ ] **Step 2: Resolve before config in `src/stdio-server.ts`**

At the very start of `async function main() {`, before the `if (process.argv[2] === 'login')` block, insert:

```ts
  loadDotenv();
  const connection = resolveConnection();
```

Then immediately after `const logger = createLogger(config.logging);` (the existing line), insert:

```ts
  if (connection.source !== 'none') {
    logger.info('Connection resolved from central config', {
      connection: connection.connectionName,
      source: connection.source,
      configPath: connection.configPath,
      injected: connection.injected,
    });
  }
```

- [ ] **Step 3: Add imports to `src/server.ts`**

After the `import { loadConfig } from './core/config.js';` line add:

```ts
import { loadDotenv } from './core/dotenv-loader.js';
import { resolveConnection } from './core/connection-resolver.js';
```

- [ ] **Step 4: Resolve before config in `src/server.ts`**

At the start of `async function main() {`, before `const config = loadConfig();`, insert:

```ts
  loadDotenv();
  const connection = resolveConnection();
```

Then after `const logger = createLogger(config.logging);` insert:

```ts
  if (connection.source !== 'none') {
    logger.info('Connection resolved from central config', {
      connection: connection.connectionName,
      source: connection.source,
      configPath: connection.configPath,
      injected: connection.injected,
    });
  }
```

- [ ] **Step 5: Type check + full unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: zero type errors; all existing unit tests plus the four new files pass. (Existing `config.ts` tests unchanged.)

- [ ] **Step 6: Manual smoke — pure-env mode still works (no config file)**

Run (Git bash), from a directory with no `.bc-mcp.jsonc` and no `~/.bc-mcp/config.jsonc`:

```bash
cd U:/git/bc-mcp && BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
  node -e "process.argv=[]; import('./src/core/connection-resolver.js').then(m=>{const r=m.resolveConnection();console.log(JSON.stringify(r));})" \
  || npx tsx -e "import('./src/core/connection-resolver.js').then(m=>console.log(JSON.stringify(m.resolveConnection())))"
```
Expected: prints `{"connectionName":null|undefined,"source":"none",...}` (source `none`) — confirms back-compat when no central file is present.

- [ ] **Step 7: Commit**

```bash
git add src/stdio-server.ts src/server.ts
git commit -m "feat(config): resolve central connection at server startup"
```

---

### Task 6: Docs and example files

**Files:**
- Create: `config.jsonc.example` (repo root)
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: user-facing docs for the feature.

- [ ] **Step 1: Create `config.jsonc.example`**

```jsonc
{
  // Name used when neither BC_CONNECTION nor a map[] entry matches this cwd.
  "default": "cronus28",

  "connections": {
    // On-prem NavUserPassword. Keep the password out of the file with ${ENV};
    // a literal value also works if this file is mode 0600.
    "cronus28": {
      "baseUrl": "http://cronus28/BC",
      "auth": "NavUserPassword",
      "username": "sshadows",
      "password": "${CRONUS28_PW}",
      "tenantId": "default"
    },

    // SaaS / BC Online. No password: sign in via the local window or
    // `npx business-central-mcp login`. clientId is only needed for bc_query.
    "prodA": {
      "baseUrl": "https://businesscentral.dynamics.com/00000000-0000-0000-0000-000000000000/PROD",
      "auth": "SaasWeb",
      "clientId": "${BC_CLIENT_ID}"
    }
  },

  // First matching entry (file order) selects a connection by working directory.
  // Supports * (within a path segment) and ** (across segments, incl. the dir itself).
  "map": [
    { "path": "U:/git/custA/**", "connection": "prodA" },
    { "path": "U:/git/test*/**", "connection": "cronus28" }
  ]
}
```

- [ ] **Step 2: Append a note to `.env.example`**

Add at the end:

```
# --- Central connection config (optional) ---
# Instead of repeating the BC_* block in every repo's .mcp.json, define named
# connections once in a central file and register this server at user scope.
# Resolve order: BC_MCP_CONFIG > ~/.bc-mcp/config.jsonc >
#   $XDG_CONFIG_HOME/bc-mcp/config.jsonc > ./.bc-mcp.jsonc
# Pick a connection per session with BC_CONNECTION=<name>, or map a repo path
# to a connection in the file's map[]. See config.jsonc.example.
# BC_CONNECTION=
# BC_MCP_CONFIG=
# BC_ENV_FILE=            # load a specific .env instead of ./.env
```

- [ ] **Step 3: Add a README section**

Add a "Central connection config" section under the existing configuration docs:

```markdown
## Central connection config

Running several Claude Code sessions against several BC instances no longer
requires a full `BC_*` env block in every repo's `.mcp.json`. Register the
server once at user scope and define the connections in one file.

1. Register the server globally:

   ```bash
   claude mcp add business-central -s user -- node U:/git/bc-mcp/node_modules/tsx/dist/cli.mjs U:/git/bc-mcp/src/stdio-server.ts
   ```

2. Create `~/.bc-mcp/config.jsonc` (see `config.jsonc.example`): a set of named
   `connections`, an optional `default`, and an optional `map[]` from repo path
   to connection.

3. Each session picks its connection, highest priority first:

   - an explicit `BC_*` env var (e.g. `BC_BASE_URL`) always wins for that field;
   - `BC_CONNECTION=<name>` selects a named connection;
   - a `map[]` entry whose `path` matches the session's working directory;
   - the `default` connection.

Keep secrets out of the file with `${ENV}` references (expanded from the
process environment); on macOS/Linux the file should be mode `0600`. SaaS
connections carry no password — sign in via the local window or
`npx business-central-mcp login`. With no config file present, the server runs
exactly as before from plain `BC_*` environment variables.
```

- [ ] **Step 4: Commit**

```bash
git add config.jsonc.example .env.example README.md
git commit -m "docs(config): document central connection config and example file"
```

---

## Self-Review

**Spec coverage:**
- Two-step boot (dotenv -> resolve -> unchanged loadConfig): Tasks 4, 5. `config.ts` untouched — constraint honored.
- Precedence (field env > BC_CONNECTION > cwd map > default > code): Task 3 selection + no-clobber; tested in `connection-resolver.test.ts`.
- JSONC file + resolve order (BC_MCP_CONFIG > ~ > XDG > cwd): Task 3 `findConfigFile`; comment stripping Task 1.
- Field-to-env table: Task 2 `FIELD_TO_ENV` (all 13 fields from the spec table).
- `${ENV}` interpolation, fail-loud on missing: Task 2 `expandEnv`; tested.
- cwd glob (`*`, `**`, prefix, case-insensitive, first-match): Task 2 `matchPath`; tested.
- Security: 0600 warn (Task 3 `warnLoosePerms`), redaction (injected = keys only, tested), fail-loud secrets (Task 2).
- Error handling table: missing file -> none (Task 3, tested), malformed -> ConfigError (tested), unknown name -> throw with list (tested), unresolved ${ENV} -> throw (tested), unknown field -> warn (tested).
- Entry points surface ConfigError as one-line FATAL: existing `main().catch` in both files already does this (verified) — no new catch needed.
- dotenv override:false: Task 4; tested.
- Docs + examples: Task 6.

**Placeholder scan:** none — every code and test step contains full content.

**Type consistency:** `resolveConnection`/`ConnectionResolution`/`ResolveOptions` names match across Tasks 3 and 5. `FIELD_TO_ENV`, `expandEnv`, `matchPath` defined in Task 2, consumed in Task 3. `loadDotenv` signature identical in Tasks 4 and 5. `ConfigError(message, context?)` matches the `BCError` protected constructor.
