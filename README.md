# business-central-mcp

An MCP server that gives AI assistants direct access to Microsoft Dynamics 365 Business Central. It speaks BC's native WebSocket protocol -- no OData, no APIs, no browser automation.

## Tools

| Tool | Purpose |
|---|---|
| `bc_open_page` | Open any BC page by ID (list, card, document) |
| `bc_read_data` | Read header fields, line items, factbox data with filtering and paging |
| `bc_write_data` | Write field values on headers or line items |
| `bc_execute_action` | Run page actions (Post, Release, Copy Document, etc.) |
| `bc_respond_dialog` | Answer confirmation dialogs and request pages |
| `bc_navigate` | Select rows, drill down, lookup |
| `bc_search_pages` | Find pages by name via Tell Me search |
| `bc_close_page` | Close an open page context |
| `bc_switch_company` | Switch to a different company within the session |
| `bc_list_companies` | List all available companies |
| `bc_run_report` | Execute a report and interact with its request page |

## Setup

### Prerequisites

- Node.js 20+
- A Business Central instance with NavUserPassword authentication

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password",
        "BC_TENANT_ID": "default"
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BC_BASE_URL` | (required) | BC server URL |
| `BC_USERNAME` | (required) | BC username |
| `BC_PASSWORD` | (required) | BC password |
| `BC_TENANT_ID` | `default` | BC tenant ID |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `BC_INVOKE_TIMEOUT` | `30000` | Kill session if BC hangs (ms) |

## Features

- **Document pages** -- Sales Orders, Purchase Orders expose separate sections for header, lines, and factboxes
- **Multi-company** -- switch between companies within a session
- **Reports** -- execute reports, fill request page parameters (output capture not yet supported)
- **Session recovery** -- automatic reconnect with exponential backoff after session death
- **Paging** -- range-based reads with auto-scrolling for large lists

## Development

```bash
git clone https://github.com/TorbenLeth/business-central-mcp
cd business-central-mcp
npm install
npm run start:stdio-direct   # Run from source
npm test                     # Unit tests (128)
npm run test:integration     # Integration tests against real BC (103)
```

## License

ISC
