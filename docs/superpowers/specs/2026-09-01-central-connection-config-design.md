# Central Connection Config — Design

Date: 2026-09-01
Status: Approved design, pending implementation plan

## Problem

The server's configuration is read entirely from `process.env` by
`loadConfig()` (`src/core/config.ts`). In Claude Code, those variables are
injected per repository through each repo's `.mcp.json` `env` block. A user who
runs several Claude Code sessions against several Business Central instances must
therefore duplicate and maintain a full connection env block in every repo's
`.mcp.json`. That duplication is the pain point: changing a password or URL
means editing many files, and adding a repo means copying the block again.

The goal is to let connection details live in one central place, register the
MCP server once (user scope), and have each session pick the right BC with zero
or one line of per-repo configuration — without changing the fact that
`process.env` remains the single source of truth the rest of the server reads.

## Goals

- One central file defines named BC connections (URL, auth mode, credentials).
- A session selects its connection by an explicit selector or automatically by
  its working directory, so mapped repos need no local config at all.
- Secrets can be kept out of the file via `${ENV}` interpolation.
- Full backward compatibility: with no central file present, behavior is
  exactly as today (pure environment variables).
- No change to `loadConfig()` or its tests; the new layer only pre-populates
  `process.env`.

## Non-Goals

- Sharing a single SaaS login (`.state` cookies) across repos. `.state` stays
  per working directory. Future work.
- OS keychain / credential-manager integration. `${ENV}` interpolation covers
  the immediate need; keychain support can be layered on later behind the same
  file schema.
- A GUI or `claude`-side command to edit the file. It is hand-edited JSONC.

## Architecture

Two new steps run at each server entry point, before the existing
`loadConfig()`:

```
entry (src/stdio-server.ts | src/server.ts)
  1. loadDotenv()          // BC_ENV_FILE or ./.env  -> process.env  (override:false)
  2. resolveConnection()   // central JSONC -> pick connection -> inject into process.env (no clobber)
  3. loadConfig()          // UNCHANGED: reads process.env exactly as today
```

Both new steps write into `process.env` **only where a variable is currently
unset**. This preserves the existing precedence: any variable that is already
set in the real environment (for example a `BC_BASE_URL` in a repo's
`.mcp.json`, or exported in the shell) wins over both the `.env` file and the
central connection file. `loadConfig()` never learns that this layer exists.

### Precedence (highest to lowest)

```
1. Individual field env var        (BC_BASE_URL, BC_PASSWORD, BC_AUTH, ...)
2. BC_CONNECTION=<name>            (explicit session selector, chooses a named connection)
3. cwd match in map[]             (passive; picks a connection from the working directory)
4. default connection             (the file's "default" key)
5. built-in code defaults         (loadConfig fallbacks: FIN, 28.0.0.0, port 3000, ...)
```

Tiers 2–4 select **which** named connection supplies field values; tier 1 can
still override any individual field of the chosen connection. `.env` (dotenv)
sits between the real environment and the central file: it is loaded first with
`override:false`, so a real env var beats it, and it in turn is not clobbered by
the central file.

## New Modules

### `src/core/dotenv-loader.ts`

```ts
export function loadDotenv(
  env?: NodeJS.ProcessEnv,   // default process.env
  cwd?: string,              // default process.cwd()
): { loaded: boolean; path: string | undefined };
```

A thin wrapper over the existing `dotenv` dependency. Resolves the file from
`env.BC_ENV_FILE` if set, otherwise `<cwd>/.env`. Calls dotenv with
`override:false` so it never overwrites variables already present. Missing file
is a silent no-op (`loaded:false`). No throw.

### `src/core/connection-resolver.ts`

```ts
export type ResolutionSource = 'env-selector' | 'cwd-map' | 'default' | 'none';

export interface ConnectionResolution {
  connectionName: string | undefined;  // chosen name, for logging
  source: ResolutionSource;
  configPath: string | undefined;      // which file was used, for logging
  injected: string[];                  // env keys written (values NOT included)
}

export function resolveConnection(opts?: {
  cwd?: string;                        // default process.cwd()
  env?: NodeJS.ProcessEnv;             // default process.env  (mutated in place)
}): ConnectionResolution;
```

Pure except for the documented `env` writes. Never throws for a missing config
file (returns `source:'none'`). Throws `ConfigError` for a malformed file, an
unknown connection name, or an unresolved `${ENV}` reference.

`ConfigError` is a small named error class exported from the module (or reused
from an existing core error type if one fits) so entry points can render a clear
startup message.

## Central File

### Location and resolve order

The first existing file wins:

1. `$BC_MCP_CONFIG` — explicit path (highest priority; lets one machine point
   many user-scope registrations at a chosen file).
2. `~/.bc-mcp/config.jsonc`
3. `$XDG_CONFIG_HOME/bc-mcp/config.jsonc` (probed on all platforms; on Windows
   `XDG_CONFIG_HOME` is usually unset, so this is effectively Linux/macOS).
4. `./.bc-mcp.jsonc` — project-local, relative to the server's cwd.

If none exist, `resolveConnection()` returns `source:'none'` and the server runs
in pure-environment mode.

### Format

JSONC (JSON with `//` and `/* */` comments). Comments are stripped with a small
tolerant scanner (string- and escape-aware) before `JSON.parse`. No new
dependency.

### Schema

```jsonc
{
  // Name used when no BC_CONNECTION and no cwd map entry matches.
  "default": "cronus28",

  "connections": {
    "cronus28": {
      "baseUrl": "http://cronus28/BC",
      "auth": "NavUserPassword",
      "username": "sshadows",
      "password": "${CRONUS28_PW}",   // ${ENV} expanded; a literal is also allowed
      "tenantId": "default"
    },
    "prodA": {
      "baseUrl": "https://businesscentral.dynamics.com/<aad-tenant>/PROD",
      "auth": "SaasWeb",              // no password; device/cookie login
      "clientId": "${BC_CLIENT_ID}"   // needed only for bc_query on SaaS
    }
  },

  // First matching entry (file order) selects a connection by working directory.
  "map": [
    { "path": "U:/git/custA/**", "connection": "prodA" },
    { "path": "U:/git/test*/**", "connection": "cronus28" }
  ]
}
```

### Field-to-env mapping

Each connection field maps to the environment variable `loadConfig()` already
reads. Injection uses this table; unknown keys are warned and ignored.

| File field      | Env var             |
|-----------------|---------------------|
| `baseUrl`       | `BC_BASE_URL`       |
| `auth`          | `BC_AUTH`           |
| `username`      | `BC_USERNAME`       |
| `password`      | `BC_PASSWORD`       |
| `tenantId`      | `BC_TENANT_ID`      |
| `environment`   | `BC_ENVIRONMENT`    |
| `aadTenantId`   | `BC_AAD_TENANT_ID`  |
| `clientId`      | `BC_CLIENT_ID`      |
| `oauthScope`    | `BC_OAUTH_SCOPE`    |
| `profile`       | `BC_PROFILE`        |
| `applicationId` | `BC_APPLICATION_ID` |
| `odataUrl`      | `BC_ODATA_URL`      |
| `odataCompany`  | `BC_ODATA_COMPANY`  |

## Resolution Algorithm

```
file = firstExisting(
    env.BC_MCP_CONFIG,
    ~/.bc-mcp/config.jsonc,
    $XDG_CONFIG_HOME/bc-mcp/config.jsonc,
    <cwd>/.bc-mcp.jsonc)
if file is none:
    return { source:'none' }                       // pure-env, back-compat

doc = parseJsonc(read(file))                        // throw ConfigError on parse failure

name = env.BC_CONNECTION                            // tier 2 selector
     ?? firstMapMatch(cwd, doc.map)                 // tier 3 cwd glob
     ?? doc.default                                 // tier 4

if name is undefined:
    return { source:'none', configPath:file }       // file present but nothing selected

conn = doc.connections[name]
if conn is undefined:
    throw ConfigError("connection '<name>' not found; valid: <list>")

for (field, rawVal) of conn:
    key = FIELD_TO_ENV[field]
    if key is undefined: warn("unknown field '<field>'"); continue
    val = expandEnv(rawVal)                          // ${VAR}; missing -> throw ConfigError
    if env[key] is undefined:                        // NO CLOBBER: field env tier wins
        env[key] = val
        injected.push(key)

return { connectionName:name, source, configPath:file, injected }
```

### Glob matching (`firstMapMatch`)

- Normalize both the cwd and each `path` to forward slashes and lower case
  (Windows paths are case-insensitive; this keeps `U:/Git` and `u:/git`
  equivalent).
- Support a small glob subset — literal segments, `*` (within a segment), and
  `**` (across segments) — implemented inline; no `minimatch` dependency.
- First entry that matches (file order) wins.
- A `path` may also be a plain prefix (no wildcards), matching when the cwd is
  at or below it.

### `${ENV}` expansion (`expandEnv`)

- Replaces every `${VAR}` with `env[VAR]`.
- If any referenced `VAR` is unset or empty, throw `ConfigError` naming the
  missing variable. This fails loud rather than sending empty credentials.
- Only whole `${...}` tokens are expanded; a value with no `${` is returned
  verbatim (so a literal password works).

## Security

- **File permissions.** On POSIX, if the resolved config file's mode is looser
  than `0600` (group/other bits set), log a warning naming the file. Not fatal.
  Skipped on Windows, where the mode bits are not a reliable signal.
- **Fail loud on missing secrets.** An unresolved `${ENV}` is a hard error;
  the server never starts with a silently-empty password or client id.
- **Redaction.** Values are never logged. Only env-key names (`injected`), the
  chosen connection name, and the config path appear in logs. This matches the
  existing `LOG_REDACT_VALUES` posture and the download-path redaction rules.
- **SaaS unchanged.** SaaS connections carry no password; device-code / cookie
  login is untouched. `.state` remains per-cwd.

## Error Handling

| Case                                              | Behavior                                              |
|---------------------------------------------------|-------------------------------------------------------|
| No config file found                              | Silent; pure-env mode (full backward compatibility).  |
| Malformed JSONC                                   | Throw `ConfigError` with file path + parser message.  |
| `BC_CONNECTION` / map / default names an unknown connection | Throw `ConfigError`, listing valid connection names. |
| Unresolved `${ENV}` reference                     | Throw `ConfigError` naming the missing variable.      |
| Unknown field key in a connection                 | Warn once, continue.                                  |
| File present but nothing selects a connection     | `source:'none'`; pure-env mode (no injection).        |
| Config file looser than 0600 (POSIX)              | Warn, continue.                                       |

Entry points catch `ConfigError` and exit with a one-line, non-stack message so
a misconfigured file is obvious at startup.

## Entry-Point Changes

`src/stdio-server.ts` and `src/server.ts` each gain two lines before their
existing `loadConfig()` call:

```ts
loadDotenv();
resolveConnection();          // logs chosen connection at info level
const config = loadConfig();  // unchanged
```

The resolution result is logged at info (connection name, source, config path,
injected key names) to make the active connection visible in the server log.

## Testing

Unit only — no BC protocol is touched, so no integration tier.

- `tests/unit/connection-resolver.test.ts`
  - Precedence matrix across all five tiers (field env beats selector beats map
    beats default; no-clobber verified per field).
  - cwd glob matching: `**`, `*`, prefix, case-insensitivity, first-match-wins,
    no-match falls through to default.
  - `${ENV}` expansion: success, missing-var throw, literal passthrough.
  - Unknown connection name throws with the valid list.
  - Unknown field key warns and is skipped.
  - No config file present returns `source:'none'` and injects nothing.
  - Malformed JSONC throws `ConfigError`.
  - Redaction: injected reports keys only, never values.
  - All tests inject a fake `env` object and `cwd` string; file cases use a
    temp dir. No real BC, no real home directory writes.
- `tests/unit/dotenv-loader.test.ts`
  - `override:false` (pre-set var survives), missing file is a no-op.

Docs:

- `.env.example` gains a short "Central connection config" note pointing at the
  file and `BC_CONNECTION` / `BC_ENV_FILE`.
- New `config.jsonc.example` at repo root, mirroring the schema above.
- README gains a "Central connection config" section: register the server once
  at user scope, create the file, use `map[]` and/or `BC_CONNECTION`.

## Files Touched

New:
- `src/core/connection-resolver.ts`
- `src/core/dotenv-loader.ts`
- `config.jsonc.example`
- `tests/unit/connection-resolver.test.ts`
- `tests/unit/dotenv-loader.test.ts`

Edited:
- `src/stdio-server.ts` (2 lines)
- `src/server.ts` (2 lines)
- `.env.example`
- `README`

Unchanged:
- `src/core/config.ts` and its tests.
