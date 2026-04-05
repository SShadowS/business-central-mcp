# BC MCP Server

An MCP (Model Context Protocol) server that gives AI assistants direct access to Microsoft Dynamics 365 Business Central. It speaks BC's native WebSocket protocol -- no OData, no APIs, no browser automation.

## What it does

An LLM connected to this server can open BC pages, read data, write fields, execute actions, handle dialogs, and navigate between records -- the same operations a human performs in the BC web client, but over a structured tool interface.

### Tools

| Tool | Purpose |
|---|---|
| `bc_open_page` | Open any BC page by ID (list, card, document) |
| `bc_read_data` | Read header fields, line items, factbox data with filtering, tab scoping, and paging |
| `bc_write_data` | Write field values on headers or line items |
| `bc_execute_action` | Run page actions (Post, Release, Copy Document, etc.) |
| `bc_respond_dialog` | Answer confirmation dialogs and request pages |
| `bc_navigate` | Select rows, drill down, lookup |
| `bc_search_pages` | Find pages by name via Tell Me search |
| `bc_close_page` | Close an open page context |
| `bc_switch_company` | Switch to a different company within the session |
| `bc_list_companies` | List all available companies |
| `bc_run_report` | Execute a report and interact with its request page |

## Quick start

### Prerequisites

- Node.js 20+
- A Business Central instance with NavUserPassword authentication
- A BC user account

### Install

```bash
git clone <repo-url>
cd bc-mcp
npm install
```

### Configure

Create a `.env` file:

```env
BC_BASE_URL=http://your-bc-server/BC
BC_USERNAME=your-user
BC_PASSWORD=your-password
BC_TENANT_ID=default
LOG_LEVEL=info

# Optional: session resilience tuning
BC_INVOKE_TIMEOUT=30000       # Kill session if BC hangs longer than this (ms)
BC_RECONNECT_MAX_RETRIES=4    # Retry attempts after session death
BC_RECONNECT_BASE_DELAY=1000  # Base delay for exponential backoff (ms)
```

### Run

**HTTP server** (for multi-client access):
```bash
npm start
# MCP endpoint: POST http://localhost:3000/mcp
# REST API:     POST http://localhost:3000/api/v1/...
```

**Stdio server** (for Claude Desktop):
```bash
npm run start:stdio-direct
```

### Claude Desktop configuration

```json
{
  "mcpServers": {
    "business-central": {
      "command": "node",
      "args": ["<path-to-repo>/node_modules/tsx/dist/cli.mjs", "<path-to-repo>/src/stdio-server.ts"],
      "cwd": "<path-to-repo>",
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

Note: Use the direct `tsx` path (`node_modules/tsx/dist/cli.mjs`), not `npx tsx`, which pollutes stdout and breaks JSON-RPC.

## Architecture

```
connection/  WebSocket + NTLM auth
protocol/    Event decoding, interaction encoding, control tree parsing
session/     BC session lifecycle, invoke queue, dead-session recovery
services/    Page, data, action, filter, navigation, search services
operations/  MCP tool implementations (one per tool)
mcp/         Tool registry, schemas, MCP handler
api/         REST API routes (alternative to MCP)
```

The server maintains a single WebSocket connection per session. All invokes are serialized through a promise queue -- BC's protocol is stateful and concurrent sends corrupt sequence numbers.

### Protocol

This server speaks BC's internal WebSocket protocol directly. The protocol was reverse-engineered from decompiled BC server assemblies (`Microsoft.Dynamics.Framework.UI`, `Microsoft.Dynamics.Framework.UI.Web`, `Microsoft.Dynamics.Nav.Service.ClientService`).

Key protocol details:
- JSON-RPC over WebSocket with NTLM authentication
- Handler-based response format (12 handler types)
- ~50 type abbreviations for wire efficiency
- Event-driven state: `FormCreated`, `DataLoaded`, `PropertyChanged`, `DialogOpened`
- BC27 and BC28 are wire-compatible (protocol version 15041)

## Features

### Multi-section document pages
Sales Orders, Purchase Orders, and other document pages expose separate sections for header, lines, and factboxes. Each section can be read and written independently.

### FactBox data
FactBox sections (Customer Details, Sales Line Details, Customer Statistics, etc.) are auto-loaded with field values on both list and card/document pages.

### Tab groups
Header fields are grouped by tab (General, Invoice Details, Shipping and Billing, etc.). Read specific tabs with the `tab` parameter.

### Dialog handling
Actions that trigger dialogs (Post, Copy Document, confirmations) return structured dialog info including parsed fields. Respond with `bc_respond_dialog`.

### Session recovery
Dead sessions (InvalidSessionException, WebSocket disconnect) are automatically detected. The server reconnects with exponential backoff (1s, 2s, 4s, 8s) to wait out BC's ~15-second NTLM auth slot hold after a crash. The LLM receives a clear error listing invalidated page context IDs so it can re-open pages. Stale modal state from crashed sessions (`LogicalModalityViolationException`) is also handled with retry.

If an invoke hangs indefinitely (a known BC bug), the session-level timeout kills the connection and triggers automatic recovery on the next request.

### Multi-company
Switch between companies within a session using `bc_switch_company`. All open pages are invalidated on switch since BC resets server-side page state. Use `bc_list_companies` to discover available companies.

### Report execution
Run BC reports via `bc_run_report`. Reports with request pages (parameter dialogs) return structured fields -- fill parameters with `bc_write_data` and execute with `bc_respond_dialog`. Report output capture (PDF/Excel download) is not yet supported -- use this for reports that perform server-side actions (batch posting, adjustments) or to inspect request page parameters.

### Paging
Large lists support range-based reads with `range: { offset, limit }`. The server auto-scrolls via BC's `ScrollRepeater` protocol when the requested range exceeds the loaded viewport.

## Testing

```bash
npm run typecheck              # Type check
npm test                       # Unit + protocol tests
npm run test:integration       # Integration tests against real BC
```

Unit tests (128) run without BC. Integration tests (103) require a running BC instance configured via `.env`.

## Known limitations

### License popup on fresh databases
After restoring a BC database, the first session may encounter a license notification dialog. The server auto-dismisses license/evaluation/trial dialogs during session initialization. If auto-dismiss fails, update the BC license manually before connecting.

### Session modal state persistence (BC bug)

If the MCP server crashes without closing forms, BC retains modal dialog state server-side, blocking new sessions for the same user with `LogicalModalityViolationException`. The server handles this automatically with retry/backoff during reconnection. Manual intervention is not normally needed.

### FactBox data on card pages opened without context
FactBox data loads automatically on list pages (via SetCurrentRow) and card/document pages (via LoadForm with openForm). However, some factboxes may return empty values if BC's server-side data binding requires additional context that isn't provided during the initial page open.

### Async message timing
The invoke quiescence window (150ms) is a best-effort wait for trailing async notifications. In rare cases, late-arriving messages may be missed.

### Viewport size
BC's initial viewport loads approximately 49 rows. The ScrollRepeater protocol can request additional rows, but the exact behavior depends on BC's `ViewportPagingMode` configuration for each page.

## License

ISC
