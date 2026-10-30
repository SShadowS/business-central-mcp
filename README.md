# business-central-mcp

An MCP server that lets AI agents work in Microsoft Dynamics 365 Business Central the way a user does: open pages, fill fields, post documents, run reports.

[![npm](https://img.shields.io/npm/v/business-central-mcp)](https://www.npmjs.com/package/business-central-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Install in VSCode](https://img.shields.io/badge/VSCode-Install-007ACC)](vscode:mcp/install?%7B%22name%22%3A%22business-central%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22business-central-mcp%22%5D%2C%22inputs%22%3A%5B%7B%22id%22%3A%22bc_base_url%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20base%20URL%20%28e.g.%20http%3A%2F%2Fyour-bc-server%2FBC%29%22%7D%2C%7B%22id%22%3A%22bc_username%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20username%22%7D%2C%7B%22id%22%3A%22bc_password%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22BC%20password%22%2C%22password%22%3Atrue%7D%5D%2C%22env%22%3A%7B%22BC_BASE_URL%22%3A%22%24%7Binput%3Abc_base_url%7D%22%2C%22BC_USERNAME%22%3A%22%24%7Binput%3Abc_username%7D%22%2C%22BC_PASSWORD%22%3A%22%24%7Binput%3Abc_password%7D%22%7D%7D)
[![Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-Download%20.dxt-d97757)](https://github.com/SShadowS/business-central-mcp/releases/latest)

The UI tools speak the web client's own WebSocket protocol, which I reverse-engineered from the decompiled BC server. Anything a user can do on a page, the agent can do, under that user's permissions and with BC's validation. For bulk reads there is OData, and on BC 29+ the tools in BC's own MCP server: AL queries over any table, and any installed API.

## Overview

| | |
|---|---|
| BC versions | BC26 to BC29. `bc_data_*` and `bc_api_*` need BC 29+ |
| Hosting | On-prem and BC Online |
| Auth | On-prem NavUserPassword. BC Online: browser sign-in for the UI, device code for OData and BC's MCP server |
| Tools | 25, plus 10 prompts and 3 skills |
| Transports | stdio, Streamable HTTP, REST |
| Runtime | Node 20+ |
| Tests | 1328 unit/protocol, 194 integration against live BC (as of 2.4.0) |

## Install

On-prem, NavUserPassword. For BC Online, read [docs/saas.md](docs/saas.md) first: no password goes in env there.

**Claude Code**

```bash
claude mcp add business-central \
  -e BC_BASE_URL=http://your-bc-server/BC \
  -e BC_USERNAME=you \
  -e BC_PASSWORD=secret \
  -- npx -y business-central-mcp
```

Add `--scope project` to keep it to one repo.

**VS Code**

Click the Install badge above. VS Code asks for URL, username and password and writes the entry to your user `mcp.json`.

**Claude Desktop**

Download the `.dxt` from [Releases](https://github.com/SShadowS/business-central-mcp/releases/latest), double-click it, fill in URL, username and password, restart Claude Desktop.

**Anything else** (Cursor, Grok, a workspace `.vscode/mcp.json`):

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

VS Code's file uses `"servers"` instead of `"mcpServers"`. That's it.

## Try it

Ask the agent things like:

- "Open the customer list and show me everyone in London with a balance over 1000."
- "Create a sales order for customer 10000 with 5 of item 1896-S, then post it as Ship."
- "Run the Trial Balance report for last month and save the PDF."
- "Which items have not sold in 90 days?" (an AL query on BC 29+)

## Tools

**Pages, the way a user works**

| Tool | What it does |
|------|--------------|
| `bc_search_pages` | Tell Me search for pages and reports |
| `bc_open_page` | Open any page by id: list, card, document, Role Center. Returns header, lines, factboxes and cue tiles as `sections[]` |
| `bc_read_data` | Re-read one section with filters, paging and column selection |
| `bc_write_data` | Write fields; BC validates and echoes what it stored |
| `bc_execute_action` | Run a page, row or cue action (New, Delete, Post, Release, ...). Multi-row selection where the page allows it |
| `bc_navigate` | Select rows and drill down |
| `bc_lookup` | List the valid values for a lookup field |
| `bc_respond_dialog` | Answer confirms, messages and request pages |
| `bc_wizard_navigate` | Back / Next / Finish through a wizard |
| `bc_close_page` | Close a page |
| `bc_upload_file` | Upload a local file into a BC upload dialog |

**Company, reports, tests**

| Tool | What it does |
|------|--------------|
| `bc_list_companies` / `bc_switch_company` | List companies, switch the session |
| `bc_run_report` | Run a report, fill its request page, capture the PDF/Excel/Word |
| `bc_run_tests` | Run AL test codeunits through the Test Runner (page 130455) |
| `bc_get_operation` | Look up an earlier call by `operationId` and read the record back |

**Bulk reads**

| Tool | What it does |
|------|--------------|
| `bc_query` | Read-only OData over the Standard API v2.0 |
| `bc_data_find_tables` | Find tables by name or meaning (BC 29+) |
| `bc_data_get_table_schema` | Fields, types, FlowField formulas and relations of a table |
| `bc_data_get_table_relations` | TableRelation links, for joins |
| `bc_data_query` | Compile and run an AL `query` object, read-only, 50 rows per page |

**Any installed API (BC 29+)**

| Tool | What it does |
|------|--------------|
| `bc_api_search` | Find actions on any API page or query: Microsoft's, ISV and your own |
| `bc_api_describe` | An action's fields, filters and parameters |
| `bc_api_list` | Read through an API with OData filter, select, orderby and paging |
| `bc_api_invoke` | Create, modify, delete or run a bound action, where an admin enabled it |

Every tool carries MCP annotations, so a client can auto-approve the 15 read-only ones and ask before the rest.

## Safe retries

A timeout in the middle of a posting is the worst case: did it post or not? The ten tools that change state take an optional `operationId`. Retrying with the same id returns the stored result instead of posting twice. If the first call's outcome is unknown, you get `OPERATION_IN_DOUBT` with a snapshot of the target, and `bc_get_operation` reads the record back with an evidence hash. Each result also says `replaySafe: true` only when BC's response proved a re-run cannot double-apply.

Details, including the REST mapping: [docs/replay-safety.md](docs/replay-safety.md).

## BC 29: BC's own MCP server

BC 29 ships its own MCP server on the OData port (`/BC/mcp`). bc-mcp connects to it and puts its tools next to the UI tools, so one agent gets both.

**Data query (`bc_data_*`).** The model writes an AL `query` object, BC compiles it on the fly and runs it read-only under the user's permissions. Works on any table the user can read, API page or not. Compile errors come back as `DATA_QUERY_ERROR` with BC's AL diagnostics, so the model fixes the query and retries. The `bc-data-query` skill holds the AL syntax that actually compiles (checked on BC 29.1).

**APIs (`bc_api_*`).** Every installed API page and query the user can read shows up as a `List_*` action (`List_Customers_PAG30009`). Writes appear only for API objects an admin added to the MCP Server Configuration. BC's OData errors come back as `API_ACTION_ERROR` with `details.odataCode` (`Request_EntityChanged` for a stale etag).

To turn them on: enable "MCP Server" on the Copilot & agent capabilities page, then in MCP Server Configuration switch on "Data Query Tools (Preview)" and/or the API tools. Until then the tools return `BC_MCP_UNAVAILABLE` with a `reason` (`endpoint-missing`, `mcp-disabled`, `tools-disabled`).

Honest limits, as of BC 29.1 (October 2026): semantic table and API search returned nothing on-prem, so keyword search is what works there. Microsoft has announced billing for the data query tools at general availability.

## Configuration

The ones you are likely to touch:

| Variable | Default | Description |
|----------|---------|-------------|
| `BC_BASE_URL` | required | `http://your-bc-server/BC`, or a BC Online portal URL |
| `BC_USERNAME` / `BC_PASSWORD` | | On-prem credentials. Never set a password for BC Online |
| `BC_CLIENT_ID` | | Entra app for OData and BC's MCP server on BC Online ([docs/saas.md](docs/saas.md)) |
| `BC_PROFILE` | server default | Profile id, e.g. `BUSINESS MANAGER` |
| `BC_ODATA_COMPANY` | first company | Company for `bc_query`, fallback for `bc_data_*` / `bc_api_*` |
| `BC_DOWNLOAD_DIR` | | Also save report and export downloads to disk |
| `STATE_DIR` | `{cwd}/.state` | Cookies, tokens and the retry ledger |

All 30-odd variables, one config file for many BC instances (`~/.bc-mcp/config.jsonc`), and the `FIN`/`NAV` applicationId gotcha on on-prem containers: [docs/configuration.md](docs/configuration.md).

## How it works

```
Agent (Claude, Copilot, ...)
   |  MCP over stdio or Streamable HTTP
   v
business-central-mcp
   |-- WebSocket /csh, JSON-RPC ------> BC web client endpoint   (UI tools)
   |     (SignalR hub on BC26)
   |-- OData v4 ----------------------> BC API v2.0              (bc_query)
   |-- MCP Streamable HTTP -----------> BC 29 native MCP server  (bc_data_*, bc_api_*)
```

One WebSocket per session, every call serialised through a queue, because BC's protocol is stateful and concurrent sends corrupt it. BC26 to BC29 share one codec; BC26 only differs in framing.

What keeps it running:

- A dead session reconnects with backoff (1, 2, 4, 8 s).
- Long posts and reports stay alive as long as BC answers `IsExecuting` with yes. A hung call is killed when BC says no twice.
- Stale confirms and request pages left by a crash are closed with No / Cancel, never accepted. Anything else resets the session.
- License popups on fresh databases are dismissed.
- Downloads are fetched only from BC's own file handler on the same origin, never from an external URL.

Every protocol claim in this repo is checked against the decompiled BC source and a live container. [CLAUDE.md](CLAUDE.md) has the long version, with the classes that confirmed each one.

## Key files

| Path | Purpose |
|------|---------|
| `src/stdio-server.ts` | npm `bin` entry, stdio transport |
| `src/server.ts` | HTTP transport (MCP + REST) |
| `src/mcp/` | Tool registry, schemas, handler, prompts, skills, retry ledger |
| `src/operations/` | One operation per tool, with its `*.tool.ts` definition next to it |
| `src/services/` | Page, data, action, navigation and download logic |
| `src/protocol/` | Wire codec, form state, captures |
| `src/session/` | Session lifecycle, invoke queue, modal recovery |
| `src/connection/` | WebSocket, auth providers, HTTP |
| `src/bcmcp/` | Client for BC 29's native MCP server |
| `.github/workflows/release.yml` | On a `v*` tag: test, publish to npm with provenance, attach the `.dxt` |

## Development

```bash
git clone https://github.com/SShadowS/business-central-mcp
cd business-central-mcp
npm install
npm run typecheck
npm test                     # unit + protocol
npm run test:integration     # needs a live BC container
npm run start:stdio-direct   # run from source
```

Still missing: Windows auth for on-prem, Cursor install badge, an `init` wizard. See [ROADMAP.md](ROADMAP.md). Found a page it can't drive? Open an issue with the page id and the log from `LOG_DIR`.

---

**Author**: Torben Leth (sshadows@sshadows.dk)
**License**: MIT (see [LICENSE](LICENSE))
