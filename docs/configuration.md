# Configuration

Every setting is an environment variable. A `<cwd>/.env` (or the file at `BC_ENV_FILE`) is loaded at startup; variables already set in the real environment win.

## Environment variables

### Connection and auth

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_BASE_URL` | required | On-prem `http://your-bc-server/BC`, or a BC Online portal URL `https://businesscentral.dynamics.com/{aadTenant}/{environment}` |
| `BC_USERNAME` | | On-prem username. On BC Online only an email prefill for the sign-in window |
| `BC_PASSWORD` | | On-prem password. Ignored on BC Online (never put a SaaS password in env) |
| `BC_AUTH` | `auto` | `auto` (SaaS URL selects `SaasWeb`, otherwise NavUserPassword), `OAuth`, `SaasWeb` or `NavUserPassword` |
| `BC_TENANT_ID` | `default` | On-prem tenant id. BC Online uses the Entra tenant from the URL |
| `BC_AAD_TENANT_ID` | from URL | Entra tenant GUID, when it is not in `BC_BASE_URL` |
| `BC_ENVIRONMENT` | from URL | BC Online environment name (`DEV`, `sandbox`, `production`) |
| `BC_CLIENT_ID` | | Entra app for device-code sign-in on BC Online (`bc_query`, `bc_data_*`, `bc_api_*`). See [saas.md](saas.md#which-client-id-signs-in-bc_client_id) |
| `BC_OAUTH_SCOPE` | `user_impersonation` + `offline_access` | Override the device-code scope |
| `BC_PROFILE` | server default | Profile id, e.g. `BUSINESS MANAGER`. Picks the Role Center and the pages Tell Me indexes |
| `BC_APPLICATION_ID` | detected | `applicationId` sent at OpenSession. See [below](#on-prem-containers-applicationid-fin-vs-nav) |
| `BC_CLIENT_VERSION` | `28.0.0.0` | Client version reported at OpenSession |
| `BC_CONNECTION` | | Named connection from `~/.bc-mcp/config.jsonc` |

### OData and BC's own MCP server

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_ODATA_URL` | `BC_BASE_URL` on port 7048 | OData base for `bc_query`. BC Online derives `https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}` |
| `BC_ODATA_COMPANY` | first company | Company for `bc_query`, and the fallback company for `bc_data_*` / `bc_api_*` |
| `BC_MCP_URL` | `{OData URL}/mcp` | BC's native MCP endpoint (BC 29+) |

### Timeouts and recovery

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_INVOKE_TIMEOUT` | `30000` | RPC timeout (ms) for OpenSession and modal-recovery calls |
| `BC_ISEXECUTING_POLL_INTERVAL` | `10000` | While a call runs, ask BC every N ms whether it is still working. A long post stays alive while BC says yes; a hung call is killed once BC says no |
| `BC_INVOKE_MAX_DURATION` | `600000` | Hard cap (ms) for one call, even while BC is still working |
| `BC_RECONNECT_MAX_RETRIES` | `4` | Reconnect attempts after session death |
| `BC_RECONNECT_BASE_DELAY` | `1000` | Base delay (ms) for the exponential reconnect backoff |

### Downloads, selection and replay

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_DOWNLOAD_DIR` | `BC_REPORT_DIR` | Also write captured downloads to this directory (`savedPath` in the result) |
| `BC_MAX_DOWNLOAD_BYTES` | `5242880` (5 MB) | Per-file download cap |
| `BC_MAX_DOWNLOAD_TOTAL_BYTES` | `10485760` (10 MB) | Total download cap per call |
| `BC_MAX_DOWNLOADS` | `5` | Max downloads per call |
| `BC_MAX_SELECTION` | `100` | Max rows in a multi-row `bookmarks[]` selection |
| `BC_OPERATION_TTL` | `86400000` (24h) | How long a completed `operationId` stays replayable. Must be > 0 |
| `BC_OPERATION_INDOUBT_TTL` | `2592000000` (30 days) | How long `sent`/`unknown` ledger entries are kept. At least 24h and 2x `BC_INVOKE_MAX_DURATION` |

### Server and logging

| Variable | Default | Description |
|----------|---------|-------------|
| `STATE_DIR` | `{cwd}/.state` | Cookies, OAuth tokens (mode 0600) and the `operations/` ledger. Per repo, so two repos never share a login |
| `PORT` | `3000` | HTTP transport port (stdio ignores it) |
| `BIND_ADDRESS` | `127.0.0.1` | HTTP bind address. A non-loopback address requires `API_TOKEN` |
| `API_TOKEN` | | Bearer token for the HTTP transport |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | `./logs` | Log directory |

## Central connection config

Running several Claude Code sessions against several BC instances does not need a full `BC_*` block in every repo's `.mcp.json`. Register the server once at user scope and keep the connections in one file.

1. Register the server globally:

   ```bash
   claude mcp add business-central -s user -- npx -y business-central-mcp
   ```

2. Create `~/.bc-mcp/config.jsonc` (see [`config.jsonc.example`](../config.jsonc.example)): named `connections`, an optional `default`, and an optional `map[]` from repo path to connection.

3. Each session picks its connection, highest priority first:

   - an explicit `BC_*` env var always wins for that field;
   - `BC_CONNECTION=<name>` selects a named connection;
   - a `map[]` entry whose `path` matches the session's working directory;
   - the `default` connection.

Keep secrets out of the file with `${ENV}` references (expanded from the process environment). On macOS/Linux the file should be mode `0600`. BC Online connections carry no password. With no config file the server runs from plain `BC_*` variables, as before.

## On-prem containers: `applicationId` (`FIN` vs `NAV`)

`OpenSession` must carry the `applicationId` the server expects. BC Online and cronus images expect `FIN`; BcContainerHelper `onprem` containers generally expect `NAV`. With `BC_APPLICATION_ID` unset, bc-mcp reads the value the web client would use from `{BC_BASE_URL}/boot/browser/desktop?tenant=…` (served without sign-in) before the first session, and falls back to `FIN` if that fails (logged as a warning).

If the session still dies at `OpenSession` with `NavCancelCredentialPromptException` although sign-in and the WebSocket upgrade both worked, set it:

```
BC_APPLICATION_ID=NAV
```

The error is misleading: sign-in and the `/csh` upgrade complete first (you get a 101), and BC only rejects the `applicationId` inside the `OpenSession` body. Verified against BC 27.1 `onprem` (issue #10).
