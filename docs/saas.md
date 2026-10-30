# BC Online (SaaS)

You only need the URL from the browser address bar, the one you use to open Business Central Online:

```
https://businesscentral.dynamics.com/<aad-tenant-id>/<environment>
```

`<environment>` is usually `DEV`, `sandbox` or `production`. **Do not set `BC_PASSWORD`.**

## Sign in for the UI tools

1. Put the portal URL in `BC_BASE_URL` (no extra path, no query string).
2. Optionally set `BC_USERNAME` to your work email. It only prefills the sign-in form.
3. Point the MCP at this project (Claude Code `--scope project`, a workspace `mcp.json`, Grok `.grok/config.toml`). Leave `STATE_DIR` unset so cookies land in `{project}/.state/`.
4. Start the agent on a machine with a display (Linux needs `DISPLAY` or `WAYLAND_DISPLAY`). Headless CI cannot complete MFA.
5. Ask the agent to open a page (`bc_open_page`, e.g. Customer List = 22). A local window on `127.0.0.1` opens. Sign in with Microsoft and finish Authenticator there. Never paste the password into chat or tool arguments.
6. Retry the tool. Cookies are saved in `{project}/.state/saas-web-cookies.json` (mode 0600). Later sessions in the same repo reuse them; another repo signs in on its own.

Or sign in up front, from the same working directory as the MCP:

```bash
npx business-central-mcp login
```

The WebSocket is not on the portal host. After sign-in the server discovers the cluster and sends `Origin: https://businesscentral.dynamics.com`. You never put a cluster URL in config.

### Config snippets

Claude Desktop / VS Code:

```json
{
  "mcpServers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "https://businesscentral.dynamics.com/<aad-tenant-id>/DEV",
        "BC_USERNAME": "you@tenant.com"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add business-central \
  -e BC_BASE_URL=https://businesscentral.dynamics.com/<aad-tenant-id>/DEV \
  -e BC_USERNAME=you@tenant.com \
  --scope project \
  -- npx -y business-central-mcp
```

Grok (`.grok/config.toml`, keep it out of git if the tenant URL is private):

```toml
[mcp_servers.business-central]
command = "npx"
args = ["-y", "business-central-mcp"]

[mcp_servers.business-central.env]
BC_BASE_URL = "https://businesscentral.dynamics.com/<aad-tenant-id>/DEV"
BC_USERNAME = "you@tenant.com"
```

## OData and BC's MCP tools: device-code sign-in

`bc_query`, `bc_data_*` and `bc_api_*` do not use the `/csh` cookie session. They use a Bearer token from a device-code sign-in. When sign-in is needed, the first call returns `DEVICE_LOGIN_REQUIRED` with a `https://microsoft.com/devicelogin` URL and a user code. Complete it in a browser and retry; the retry picks up the pending sign-in and runs the call. The refresh token is stored in `STATE_DIR/oauth-tokens.json` (mode 0600).

Without `BC_CLIENT_ID` these tools return `OAUTH_NOT_CONFIGURED`. They never send Basic auth to BC Online.

### Which client id signs in (`BC_CLIENT_ID`)

`BC_CLIENT_ID` is a **multi-tenant public** Entra app with delegated `Dynamics 365 Business Central / user_impersonation`. The publisher registers it once in their own tenant. Customer tenants register nothing: each user consents at first sign-in (`user_impersonation` is user-consentable), and tenants that disable user consent need one admin-consent click.

Do not borrow a Microsoft first-party client (Azure PowerShell `1950a258-…` as `New-BcAuthContext` does, Azure CLI, …). On tenants with Entra first-party hardening the sign-in fails in the browser with `AADSTS65002` ("consent between first party application and first party resource must be configured via preauthorization"), and no tenant admin can consent around it. Verified live 2026-08-16: the same sign-in worked on one tenant and failed with 65002 on another. A third-party multi-tenant app is immune, since 65002 only gates Microsoft-owned client/resource pairs.

Create the app once, in the publisher tenant:

```bash
az ad app create --display-name "business-central-mcp" \
  --is-fallback-public-client true \
  --sign-in-audience AzureADMultipleOrgs \
  --required-resource-accesses '[{"resourceAppId":"996def3d-b36c-4153-8607-a6fd3c01b89f","resourceAccess":[{"id":"bce0976a-cb0b-473b-8800-84eda9f8e447","type":"Scope"}]}]' \
  --query appId -o tsv
```

(`996def3d…` is the Dynamics 365 Business Central resource, `bce0976a…` its delegated `user_impersonation` scope.) Put the printed appId in `BC_CLIENT_ID`.

Known wart: when the browser sign-in fails (65002, blocked consent), Entra keeps the device code `authorization_pending`, so retries re-serve the same doomed code until it expires (about 15 minutes). Fix the client id or consent, ignore the old code, and retry for a fresh one.
