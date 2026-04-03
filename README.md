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
Dead sessions (InvalidSessionException, WebSocket disconnect) are automatically detected. The next tool call creates a fresh session and returns a clear error so the LLM can re-open pages.

### Paging
Large lists support range-based reads with `range: { offset, limit }`. The server auto-scrolls via BC's `ScrollRepeater` protocol when the requested range exceeds the loaded viewport.

## Testing

```bash
npm run typecheck              # Type check
npm test                       # Unit + protocol tests
npm run test:integration       # Integration tests against real BC
```

Unit tests (109) run without BC. Integration tests (99+) require a running BC instance configured via `.env`.

## Known limitations

### License popup on fresh databases
After restoring a BC database, the first session may encounter a license notification dialog. This is a special system-level dialog that the MCP server cannot dismiss programmatically. **Update the BC license before connecting the MCP server** to prevent this from blocking all subsequent operations.

### Session modal state persistence (BC bug)

If the MCP server disconnects without properly closing open forms (e.g., process crash, kill signal), BC retains modal dialog state server-side. This blocks new sessions for the same user with `LogicalModalityViolationException`.

**Root cause (verified from decompiled source):** BC's `LogicalDispatcher` is stored in a `[ThreadStatic]` field and reused across sessions on the same thread. When `DisposeCurrentDispatcher()` is called during session cleanup, it sets the thread-static reference to null but does NOT clear the `Frames` stack (`LogicalDispatcher.cs:90-93`). When a new session gets assigned to the same server thread, the old dispatcher's modal frames leak through, causing `LogicalModalityVerifier.VerifyAnyModalFormOpen()` to throw (`LogicalModalityVerifier.cs:69-74`).

**Our workaround:** `BCSession.closeGracefully()` sends `CloseForm` for all open forms and auto-dismisses any save-changes dialogs before closing the WebSocket. `PageService.closePage()` accepts a `discardChanges` option to handle save-changes dialogs during the close flow. Together, these ensure no modal state remains when the session ends normally. Abrupt termination (kill -9, power loss) can still leave stale state -- restart the BC service instance to recover.

### FactBox data on card pages opened without context
FactBox data loads automatically on list pages (via SetCurrentRow) and card/document pages (via LoadForm with openForm). However, some factboxes may return empty values if BC's server-side data binding requires additional context that isn't provided during the initial page open.

### Async message timing
The invoke quiescence window (150ms) is a best-effort wait for trailing async notifications. In rare cases, late-arriving messages may be missed.

### Viewport size
BC's initial viewport loads approximately 49 rows. The ScrollRepeater protocol can request additional rows, but the exact behavior depends on BC's `ViewportPagingMode` configuration for each page.

## License

ISC
