<p align="center">
  <h1 align="center">business-central-mcp</h1>
  <p align="center">
    Give AI assistants direct access to Microsoft Dynamics 365 Business Central.<br/>
    Native WebSocket protocol -- no OData, no APIs, no browser automation.
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/business-central-mcp"><img src="https://img.shields.io/npm/v/business-central-mcp" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/business-central-mcp"><img src="https://img.shields.io/npm/dm/business-central-mcp" alt="npm downloads"></a>
  <a href="https://github.com/SShadowS/business-central-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/business-central-mcp" alt="license"></a>
  <a href="vscode:mcp/install?%7B%22name%22%3A%22business-central%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22business-central-mcp%22%5D%2C%22inputs%22%3A%5B%7B%22id%22%3A%22bc_base_url%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20base%20URL%20%28e.g.%20http%3A%2F%2Fyour-bc-server%2FBC%29%22%7D%2C%7B%22id%22%3A%22bc_username%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20username%22%7D%2C%7B%22id%22%3A%22bc_password%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20password%22%2C%22password%22%3Atrue%7D%5D%2C%22env%22%3A%7B%22BC_BASE_URL%22%3A%22%24%7Binput%3Abc_base_url%7D%22%2C%22BC_USERNAME%22%3A%22%24%7Binput%3Abc_username%7D%22%2C%22BC_PASSWORD%22%3A%22%24%7Binput%3Abc_password%7D%22%7D%7D"><img src="https://img.shields.io/badge/VSCode-Install-007ACC?logo=visualstudiocode" alt="Install in VSCode"></a>
  <a href="https://github.com/SShadowS/business-central-mcp/releases/latest"><img src="https://img.shields.io/badge/Claude%20Desktop-Download%20.dxt-d97757" alt="Download .dxt for Claude Desktop"></a>
</p>

---

## Overview

| Property | Value |
|----------|-------|
| Language | TypeScript / Node 20+ |
| npm package | [`business-central-mcp`](https://www.npmjs.com/package/business-central-mcp) |
| BC versions | BC27, BC28 (wire-compatible) |
| Auth | NavUserPassword (OAuth on roadmap) |
| Tools | 12 |
| Tests | 284 unit/protocol + 111 integration |
| License | MIT |

## Install

### VSCode

[![Install in VSCode](https://img.shields.io/badge/VSCode-Install-007ACC?logo=visualstudiocode)](vscode:mcp/install?%7B%22name%22%3A%22business-central%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22business-central-mcp%22%5D%2C%22inputs%22%3A%5B%7B%22id%22%3A%22bc_base_url%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20base%20URL%20%28e.g.%20http%3A%2F%2Fyour-bc-server%2FBC%29%22%7D%2C%7B%22id%22%3A%22bc_username%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20username%22%7D%2C%7B%22id%22%3A%22bc_password%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20password%22%2C%22password%22%3Atrue%7D%5D%2C%22env%22%3A%7B%22BC_BASE_URL%22%3A%22%24%7Binput%3Abc_base_url%7D%22%2C%22BC_USERNAME%22%3A%22%24%7Binput%3Abc_username%7D%22%2C%22BC_PASSWORD%22%3A%22%24%7Binput%3Abc_password%7D%22%7D%7D)

Click the badge. VSCode opens and prompts for your BC URL, username, and password, then writes the configured entry to your user `mcp.json`.

<details>
<summary><strong>Manual install</strong></summary>

Workspace: create `.vscode/mcp.json`:

```json
{
  "servers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password"
      }
    }
  }
}
```

</details>

### Claude Code

```bash
claude mcp add business-central \
  -e BC_BASE_URL=http://your-bc-server/BC \
  -e BC_USERNAME=you \
  -e BC_PASSWORD=secret \
  -- npx -y business-central-mcp
```

Scope it to the current project with `--scope project`. See `claude mcp --help` for scoping options.

### Claude Desktop

1. Download the latest `.dxt` from [Releases](https://github.com/SShadowS/business-central-mcp/releases/latest).
2. Double-click. Claude Desktop opens Settings → Extensions and prompts for BC URL, username, and password.
3. Restart Claude Desktop.

<details>
<summary><strong>Manual install</strong></summary>

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop.

</details>

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BC_BASE_URL` | Yes | — | BC server base URL, e.g. `http://your-bc-server/BC` |
| `BC_USERNAME` | Yes | — | NavUserPassword username |
| `BC_PASSWORD` | Yes | — | NavUserPassword password |
| `BC_PROFILE` | No | server default | Profile id, e.g. `BUSINESS MANAGER`. Affects which Role Center loads and which pages Tell Me indexes. |
| `BC_TENANT_ID` | No | `default` | Multi-tenant deployments only. |
| `BC_CLIENT_VERSION` | No | `27.0.0.0` | Version reported to BC during session open. |
| `PORT` | No | `3000` | HTTP transport port (stdio transport ignores this). |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error`. |
| `LOG_DIR` | No | `./logs` | Directory for log files. |
| `STATE_DIR` | No | `./.state` | Directory for session state. |
| `BC_INVOKE_TIMEOUT` | No | `30000` | Per-invoke timeout in ms. Kills hung sessions. |
| `BC_RECONNECT_MAX_RETRIES` | No | `4` | Reconnect attempts after session death. |
| `BC_RECONNECT_BASE_DELAY` | No | `1000` | Base delay (ms) for exponential reconnect backoff. |

## What can it do?

| Tool | What it does |
|---|---|
| `bc_open_page` | Open any page by ID -- lists, cards, documents, role centers. Returns the page as `sections[]` with header, lines, factboxes, and Role Center cuegroup tiles. |
| `bc_read_data` | Refresh a single section: filter, paginate, slice, project tab/columns. Returns the same `Section` shape as `bc_open_page`. |
| `bc_write_data` | Write field values; BC validates and echoes confirmed values. Section-aware (lines, factboxes, header). |
| `bc_execute_action` | Run header / row / wizard actions, OR drill down on Role Center cue tiles via `cue` input. |
| `bc_respond_dialog` | Handle confirmation prompts and request pages |
| `bc_navigate` | Select rows, drill down into records, field lookups |
| `bc_search_pages` | Tell Me search. Returns `{ name, objectType, runTarget, departmentPath, category, score }` per result. |
| `bc_close_page` | Close a page and free server resources |
| `bc_switch_company` | Switch to a different company mid-session |
| `bc_list_companies` | Discover available companies |
| `bc_run_report` | Execute reports and fill request page parameters |
| `bc_wizard_navigate` | Drive NavigatePage / wizard flows (back / next / finish / cancel) |

## How it works

This server speaks BC's internal WebSocket protocol directly -- the same protocol the browser-based web client uses. It was reverse-engineered from decompiled BC server assemblies. No OData endpoints, no SOAP services, no Selenium.

One WebSocket connection per session. All operations serialized through a promise queue. BC27 and BC28 are wire-compatible.

```
LLM (Claude / Copilot / etc.)
   |
   v   MCP (stdio or HTTP)
business-central-mcp
   |
   v   WebSocket + JSON-RPC
BC Web Service Tier (BC27 / BC28)
   |
   v   internal calls
BC Server
```

<details>
<summary><strong>Page output shape</strong></summary>

`bc_open_page` returns the page as a flat list of sections:

```json
{
  "pageContextId": "session:page:21:abc",
  "pageType": "Card",
  "caption": "Customer Card",
  "isModal": false,
  "sections": [
    { "sectionId": "header",                       "kind": "header",  "fields": [...], "actions": [...] },
    { "sectionId": "factbox:Customer Statistics",  "kind": "factbox", "fields": [...] }
  ]
}
```

Each section carries its own content shape:
- **Card-style** (`header` on Card pages, `factbox`, `requestPage`): `fields[]` and (for `header`) `actions[]`
- **List-style** (`lines` on Documents, `header` on List pages, repeater subpages): `rows[]` and `totalRowCount`
- **Cue tiles** (Role Center hosted CardParts): `cues[]` with each tile's `name`, `value`, `groupCaption`, `synopsis`, `hasAction`. Drill down with `bc_execute_action { section, cue }`.

`bc_read_data` returns a single `Section` for the requested `sectionId` (defaults to `"header"`). The section ID for a FactBox or subpage comes from the `bc_open_page` response.

</details>

<details>
<summary><strong>Session resilience</strong></summary>

- Automatic reconnect with exponential backoff after session death
- Handles BC's ~15s NTLM auth slot hold after crashes
- Auto-dismisses license popups on fresh databases
- Invoke timeout kills hung sessions and triggers recovery
- Auto-recovery from `LogicalModalityViolationException` mid-session: reconciles the modal stack and retries transparently; falls back to session reset when BC keeps a confirm dialog sticky

</details>

## Key files

| File | Purpose |
|------|---------|
| `src/stdio-server.ts` | npm `bin` entry -- stdio MCP transport |
| `src/server.ts` | HTTP MCP transport entry |
| `src/mcp/` | MCP tool registry, schemas, request handler |
| `src/operations/` | One handler per tool (`bc_open_page`, `bc_read_data`, etc.) |
| `src/services/` | Page, data, action, navigation, search business logic |
| `src/protocol/` | WebSocket transport, wire types, captures |
| `src/session/` | Session lifecycle, modal stack, reconnect |
| `manifest.json` | Claude Desktop Extension manifest |
| `scripts/build-dxt.ts` | Builds `.dxt` artifact for Claude Desktop |
| `.github/workflows/release.yml` | Builds + attaches `.dxt` on `v*` tag pushes |
| `ROADMAP.md` | Deferred work (OAuth, Cursor, init wizard) |

## Development

```bash
git clone https://github.com/SShadowS/business-central-mcp
cd business-central-mcp
npm install
npm run start:stdio-direct   # Run from source
npm test                     # 284 unit + protocol tests
npm run test:integration     # 111 integration tests against real BC (requires running BC server)
```

## Roadmap

OAuth, Cursor support, an interactive `init` wizard, and a few protocol gaps.
See [ROADMAP.md](ROADMAP.md) for the full list and priorities.

---

**Author:** Torben Leth (sshadows@sshadows.dk)
**License:** MIT (see [LICENSE](LICENSE))
