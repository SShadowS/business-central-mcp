# OAuth + BC Online (SaaS) — design

**Date:** 2026-08-15
**Status:** Implemented for the official API (`bc_query`). `/csh` on SaaS remains blocked by first-party OIDC.

## Problem

`business-central-mcp` spoke only NavUserPassword (`POST /SignIn` → cookies + antiforgery → `ws://…/csh`). That cannot reach a SaaS sandbox such as:

```
https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV
```

Roadmap item: "OAuth / AAD authentication. Largest gap."

## Two different surfaces

| Surface | Host | Auth Microsoft documents | Used by |
|---|---|---|---|
| Standard API / OData | `api.businesscentral.dynamics.com/v2.0/{tenant}/{env}` | Entra Bearer (`user_impersonation` or `API.ReadWrite.All`) | `bc_query` |
| Web client `/csh` | Front Door `businesscentral.dynamics.com/{tenant}/{env}` after a cookie session | First-party OpenID Connect | `bc_open_page` and every other UI tool |

Verified live 2026-08-15 against the DEV sandbox above:

- `GET {portal}/{env}` → **302** to `login.microsoftonline.com/{tenant}/oauth2/authorize?client_id=996def3d-b36c-4153-8607-a6fd3c01b89f&redirect_uri=https://businesscentral.dynamics.com/remote-sign-in&response_type=code&scope=openid%20profile&response_mode=form_post` plus `.AspNetCore.OpenIdConnect.Nonce.*`, `.AspNetCore.Correlation.*`, `{tenant}.Antiforgery.*`, `ASLBSA` cookies. `x-client-SKU=ID_NET8_0`.
- `GET {portal}/{env}/csh` (no session) → **404** `x-servicefabric: ResourceNotFound`. A dummy `Authorization: Bearer` does not change that.
- `GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/companies` → **401** `WWW-Authenticate: Bearer authorization_uri=https://login.microsoftonline.com/{tenant}/oauth2/authorize`.

`996def3d-b36c-4153-8607-a6fd3c01b89f` is Microsoft's Business Central **resource / first-party web-client** id (also used as the ADAL resource in the Admin Center API docs). A third-party MCP must not impersonate that client_id. Completing `/remote-sign-in` (`form_post`) from a headless process would require driving the user's browser or intercepting Microsoft's redirect — not a legitimate app registration.

So: **OAuth unlocks the official API immediately. It does not, by itself, unlock `/csh`.**

## Decisions

1. **Auto-detect SaaS URLs.** `parseSaasUrl` extracts Entra tenant + environment. `BC_AUTH` defaults to `auto` (SaaS → OAuth, else NavUserPassword).
2. **No MSAL.** Device-code, client-credentials, and refresh against the v2.0 token endpoint are small enough to implement and unit-test with mocked `fetch`.
3. **Require the user's Entra app** (`BC_CLIENT_ID`). Do not ship Microsoft's first-party client id as ours.
4. **Device code when there is no secret** (MCP/stdio: prompt on stderr). **Client credentials when `BC_CLIENT_SECRET` is set.** Optional `BC_ACCESS_TOKEN` skips both.
5. **Refresh cache** at `STATE_DIR/oauth-tokens.json` (mode 0600), keyed by clientId + tenant.
6. **`bc_query` must not open `/csh`.** Previously `ensureSession()` ran for every tool, so a SaaS `/csh` 404 would have blocked the one tool OAuth can serve.
7. **OAuth provider still implements `IBCAuthProvider`.** It sends Bearer + any cookies a Bearer GET of the portal produced. A 302 to `login.microsoftonline.com` is treated as "no web session" (cookies cleared), not as success. `invalidate()` drops cookies only, so reconnect does not force another device-code prompt.
8. **OData URL derivation.** SaaS portal → `https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}`. `?tenant=` is omitted (tenant is already in the path).

## What this does not claim

- `bc_open_page` / UI tools against SaaS. That needs the first-party cookie session or a documented token-accepted `/csh` upgrade.
- Windows / NTLM (still on the roadmap).
- ROPC (username/password against Entra). Deprecated and blocked by MFA.

## Follow-up

A legitimate `/csh` path would be one of:

- Microsoft accepting `Authorization: Bearer` on the cluster `/csh` upgrade (not observed on the unauthenticated front door).
- A documented token-to-web-session exchange that is not the first-party `/remote-sign-in` form_post.
- An optional, explicit browser-assisted cookie capture (out of scope here; this project is not a Playwright driver).

Until then the honest UX is: SaaS + OAuth → `bc_query` works; UI tools tell the user `/csh` needs the web-client session.

## References

- [Using OAuth to authorize Business Central web services](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/webservices/authenticate-web-services-using-oauth)
- [S2S authentication](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication)
- [API endpoint structure](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/webservices/api-endpoint-structure)
- [Admin Center API](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/administration/administration-center-api) (resource `996def3d-…`)
