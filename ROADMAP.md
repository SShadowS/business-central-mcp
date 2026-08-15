# Roadmap

Future work, ordered by priority within each section. Open an issue or PR if you want to push something up the list.

## Auth

- **OAuth / AAD authentication.** Device-code and client-credentials grants
  are implemented for the official Standard API (`bc_query`) and SaaS portal
  URLs are parsed. The native `/csh` WebSocket on BC Online still needs the
  first-party web-client OpenID Connect cookie session
  (`996def3d-…` → `/remote-sign-in`); an API Bearer token does not establish
  that session. Remaining work: a legitimate way to obtain that cookie
  session (or Microsoft documenting a token-accepted `/csh` upgrade) so
  `bc_open_page` and the other UI tools work against SaaS sandboxes.
- **Windows authentication.** For domain-joined on-prem deployments where NavUserPassword is not enabled.

## Install ergonomics

- **Cursor support.** Add an "Install in Cursor" badge and a manual `~/.cursor/mcp.json` snippet to the README.
- **Interactive setup wizard.** `npx business-central-mcp init` that detects which host(s) are installed (Claude Desktop, Claude Code, VSCode, Cursor), prompts for BC URL/user/password, and writes the config files directly.
- **Host auto-detection inside the wizard.** Per-OS path detection for the four hosts above.

## Protocol

- **More tools.** Cover the remaining ~10% of the web client that the current 12 tools do not. Tracked via issues.
- **BC29+ wire-compat verification.** Verify each new BC version as it ships.

## Distribution

- **Sign the `.dxt`.** Once Claude Desktop's signing requirements stabilize, sign the artifact in the release workflow.
- **MCP marketplace.** Publish to whatever official extension index emerges (Claude's, VSCode's, generic MCP registry).
- **`manifest.json` `entry_point` consistency.** The current `manifest.json` declares `entry_point: "dist/stdio-server.js"` because the `@anthropic-ai/dxt` CLI schema requires the field, but the `.dxt` archive intentionally does not bundle `dist/`. Claude Desktop's runtime reads only `mcp_config` (verified against the `@anthropic-ai/dxt` SDK source), so `entry_point` is effectively unused. Verify this empirically during the next manual smoke test, and revisit if a future schema or runtime starts honoring `entry_point`.
