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
  <a href="https://github.com/TorbenLeth/business-central-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/business-central-mcp" alt="license"></a>
</p>

---

## Quick start

Add to your Claude Desktop config:

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

That's it. The LLM can now open pages, read and write data, run actions, and navigate BC -- just like a human using the web client.

## What can it do?

| Tool | What it does |
|---|---|
| `bc_open_page` | Open any page by ID -- lists, cards, documents |
| `bc_read_data` | Read fields, line items, factboxes with filters and paging |
| `bc_write_data` | Write field values, BC validates and echoes confirmed values |
| `bc_execute_action` | Post, Release, Delete, Copy Document, any page action |
| `bc_respond_dialog` | Handle confirmation prompts and request pages |
| `bc_navigate` | Select rows, drill down into records, field lookups |
| `bc_search_pages` | Find pages by name via Tell Me |
| `bc_close_page` | Close a page and free server resources |
| `bc_switch_company` | Switch to a different company mid-session |
| `bc_list_companies` | Discover available companies |
| `bc_run_report` | Execute reports and fill request page parameters |

## How it works

This server speaks BC's internal WebSocket protocol directly -- the same protocol the browser-based web client uses. It was reverse-engineered from decompiled BC server assemblies. No OData endpoints, no SOAP services, no Selenium.

One WebSocket connection per session. All operations serialized through a promise queue. BC27 and BC28 are wire-compatible.

<details>
<summary><strong>Session resilience</strong></summary>

- Automatic reconnect with exponential backoff after session death
- Handles BC's ~15s NTLM auth slot hold after crashes
- Auto-dismisses license popups on fresh databases
- Invoke timeout kills hung sessions and triggers recovery

</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `BC_BASE_URL` | (required) | BC server URL |
| `BC_USERNAME` | (required) | BC username |
| `BC_PASSWORD` | (required) | BC password |
| `BC_TENANT_ID` | `default` | Tenant ID |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `BC_INVOKE_TIMEOUT` | `30000` | Kill session if BC hangs (ms) |
| `BC_RECONNECT_MAX_RETRIES` | `4` | Reconnect attempts |
| `BC_RECONNECT_BASE_DELAY` | `1000` | Backoff base delay (ms) |

</details>

## Development

```bash
git clone https://github.com/TorbenLeth/business-central-mcp
cd business-central-mcp
npm install
npm run start:stdio-direct   # Run from source
npm test                     # 128 unit tests
npm run test:integration     # 103 integration tests against real BC
```

## License

MIT
