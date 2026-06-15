# BC MCP Server v2

## Development Philosophy

This project is NOT released and in active development:
- Always choose the best solution, not the quickest compromise
- Refactor aggressively when architecture is flawed
- Fix problems properly, not with workarounds
- No stubs, mocks, or skeleton implementations -- everything must be fully functional
- No backwards compatibility concerns -- make breaking changes freely

## Quick Start

### Project Location
- **v2 source**: `U:/git/bc-mcp/`
- **v1 reference** (deprecated): `C:\bc4ubuntu\Decompiled\bc-poc\`
- **Decompiled BC28**: `U:/git/bc-mcp/reference/bc28/decompiled/`
- **Decompiled BC27**: `C:\bc4ubuntu\Decompiled\` (various Microsoft.Dynamics.* directories)
- **Architecture spec**: `C:\bc4ubuntu\Decompiled\bc-poc\docs\superpowers\specs\2026-04-03-bc-mcp-v2-design.md`

### BC Test Environments

| | BC28 |
|---|---|
| URL | http://cronus28/BC/?tenant=default |
| Username | sshadows |
| Password | 1234 |
| Auth | NavUserPassword |
| License popup | Auto-dismissed |
| Protocol version | 15041 |

Uses NavUserPassword authentication (not Windows/NTLM).

### Essential Commands
```bash
cd U:/git/bc-mcp
npx tsc --noEmit                    # Type check
npx vitest run                       # Unit + protocol tests (292 tests)
npx vitest run --config vitest.integration.config.ts  # Integration tests against real BC28 (111 tests)
npm start                            # HTTP server on port 3000
npm run start:stdio-direct           # Direct stdio for Claude Desktop
```

### Rules
- Use Windows paths with forward slashes in bash
- NEVER use `2>nul` (creates undeletable files on Windows)
- NEVER use emojis -- Windows rendering issues
- Always run `npx tsc --noEmit` after changes
- Run integration tests after any protocol-level change
- ESM project -- use `.js` extensions in all imports

## Protocol Verification Procedure

**CRITICAL: Always verify protocol behavior against decompiled BC source, not v1 code.**

V1 had several incorrect assumptions (per-page connections, SaveValue not echoing, etc.). When implementing or debugging any BC protocol interaction:

1. **Check the decompiled BC source first** at `U:/git/bc-mcp/reference/bc28/decompiled/`
2. Use v1 (`C:\bc4ubuntu\Decompiled\bc-poc\src\`) as a secondary reference only
3. If v1 and decompiled code disagree, trust the decompiled code
4. Document which decompiled file/class confirmed the behavior

Key decompiled assemblies:
- `Microsoft.Dynamics.Framework.UI/` -- Core UI framework (controls, forms, interactions, observers)
- `Microsoft.Dynamics.Framework.UI.Web/` -- Web serialization (ResponseManager, handler types, change serializers)
- `Microsoft.Dynamics.Nav.Service.ClientService/` -- WebSocket server-side handler
- `Microsoft.Dynamics.Nav.Types/` -- BC type system, VersionCompatibility

## Architecture Overview

```
connection/ -> protocol/ -> session/ -> services/ -> operations/ -> mcp/ + api/
```

### Single Connection Per Session
BC supports multiple forms on one WebSocket connection, tracked by `formId` in each interaction and `openFormIds` in each request. Verified from decompiled `UISession.openedForms` dictionary.

The v1 "per-page connection" was a workaround for an `openFormIds` tracking bug, not a BC requirement.

### Event-Driven Protocol
BC sends handler arrays as responses. The EventDecoder transforms these into typed `BCEvent[]`. State is derived from events via `FormProjection` into per-form `FormState`, coordinated by `PageContext`.

### Invoke Queue
All invokes are serialized via a promise queue in `BCSession`. BC's protocol is stateful -- concurrent sends corrupt sequence numbers.

### Session Lifecycle
`SessionManager` (`src/session/session-manager.ts`) owns lazy session creation and dead-session recovery with exponential backoff (1s, 2s, 4s, 8s). Server entry points (`server.ts`, `stdio-server.ts`) use it instead of managing sessions directly. When a dead session is detected, all page contexts are cleared and `SessionLostError` is thrown. `LogicalModalityViolationException` (stale modal state from crashed sessions) is handled with the same retry logic. License/evaluation dialogs are auto-dismissed during session init.

Configurable via env vars: `BC_INVOKE_TIMEOUT` (default 30s), `BC_RECONNECT_MAX_RETRIES` (default 4), `BC_RECONNECT_BASE_DELAY` (default 1s), `BC_PROFILE` (BC profile id e.g. `BUSINESS MANAGER`; empty = server default — see Tell Me Search section).

## BC Protocol Patterns (Verified from Decompiled Source)

### OpenSession Handshake (Required)
Every session starts with an `OpenSession` RPC that returns `ServerSessionId`, `SessionKey`, `CompanyName`. All subsequent `Invoke` calls must include these fields plus `tenantId`, `navigationContext`, `features`, `supportedExtensions`.

Reference: `BCSessionManager.ts` (v1), `NsServiceJsonRpcHostFactory.cs` (decompiled)

### Parameter Case Sensitivity
BC uses case-INSENSITIVE parameter matching. Verified from decompiled `InteractionParameterHelper.TryGetValueIgnoreCase` which uses `StringComparison.OrdinalIgnoreCase`. Both camelCase and PascalCase work.

### Control Paths
Control paths use the format `server:c[N]/c[M]/...` where `c` is the standard child collection accessor. Special segments:
- `cr` -- RepeaterControl's CurrentRowViewport (for addressing the selected row)
- `co[N]` -- RepeaterControl's column at index N
- `ha[N]` -- RepeaterControl's header actions
- `filc` -- NOT a path segment (only a TypeAlias for serialization)

Reference: `LogicalControl.ResolvePathName` (decompiled)

### Row-Targeting Actions (Drill-Down, Delete, etc.)
For system actions that operate on list rows (Edit=40, Delete=20, View=60, DrillDown=120, New=10), the `controlPath` must point to a cell in the current repeater row via `cr` segment:
```
{repeaterPath}/cr/c[0]
```
Do NOT use action button paths from `state.actions` -- they are structurally fragile and shift when BC rearranges actions.

Reference: `InvokeActionInteraction.GetContextActionToExecute` uses `DefaultAction` on the resolved control, which traverses up to find the row action. `RepeaterControl.ResolvePathName("cr")` returns `CurrentRowViewport`.

### Tell Me Search
Uses `InvokeSessionAction` with `SystemAction: 220` (PageSearch). NOT `sessionAction: "InvokeTellMe"`.

The form opens as a regular `FormCreated` (not `DialogToShow` — Tell Me is non-modal on BC28). The search input is at `server:c[0]/c[0]` (the sc inside a gc container at `server:c[0]`); SaveValue against the gc container alone returns no DataLoaded events. Two result repeaters at `server:c[1]` (pages/lists) and `server:c[2]` (reports/extras) emit DataLoaded streams with NAMED cells (`Name`, `Source`, `DepartmentPath`, `DepartmentCategory`, `SearchScore`). `cells.Source.stringValue` is JSON-encoded `[{"page": "<AL name>"}]` or `[{"report": "<AL name>"}]` — BC identifies pages by AL name, not numeric id.

Tell Me is profile-scoped on the BC server. `BC_PROFILE` env var (e.g. `BUSINESS MANAGER`) is plumbed into OpenSession's `profile` field to select an indexed profile. Server uppercases/trims; unknown ids silently fall back to user default.

Reference: `InvokeSessionActionExecutionStrategy.cs`, `SystemAction.cs` (PageSearch=220), `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs` (Profile field), `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`. Live wire fixture: `src/protocol/captures/tell-me-result-2026-04-28.json`.

### Cuegroups (Role-Center cue tiles)

Cuegroups are AL `cuegroup` containers that compile to a `stackgc` wire type (NOT a generic `gc` with a mapping hint, despite older docs). Children are `stackc` cue tiles inside an inner `gc { MappingHint: 'STACKGROUP' }`. Cue values (`StringValue`) arrive via `PropertyChanged` events AFTER `LoadForm(loadData:true)` — not in the initial FormCreated. `PageService.discoverAndLoadChildForms` sends `LoadForm { openForm:true }` plus `InvokeAction(Refresh=30)` for Role Center hosted CardParts to trigger cue computation.

`StackGroupNode` and `CueFieldNode` are first-class FormNode variants. `cues(root)` is a memoised view; `Section.cues` is the MCP DTO field. `bc_execute_action { section, cue }` sends `SystemAction.DrillDown=120` against the cue's controlPath; the resulting ownerless FormCreated is registered as a fresh `session:page:cue:*` pcId returned in `openedPages`.

Role Center hosted CardParts arrive on the wire as `IsSubForm=false / IsPart=true`, which `SectionResolver.deriveFactboxSection` classifies as `kind: 'factbox'` (not `'subpage'`). The auto-load path treats both as Role Center children when `pageType === 'RoleCenter'`.

CardParts opened standalone may return a placeholder shell on some envs (Continia/CDO is a known case; default BC28 returns full content). `OpenPageOperation` detects this — pageType=CardPart with zero captioned fields AND zero cues — and returns `CardPartStubError` (code `CARDPART_STUB`) with a `hostHint` telling the caller to reach the part via its host page.

Reference: `src/protocol/captures/cuegroup-rolecenter-2026-04-28.json` (619 KB, 16 hosted CardParts, 50 cue tiles); `src/protocol/cue-detection.ts`; `src/protocol/form-node.ts` (StackGroupNode, CueFieldNode); decompiled `Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs` for the wire-property names.

### Filter Protocol
Single-step: `Filter(AddLine)` with `FilterValue` in namedParameters. Two-step (AddLine + SaveValue) also works but is unnecessary.

After AddLine, the filter line control structure is:
```
{filcPath}/c[0]     -- FilterLineControl
  c[0]              -- SelectionControl (column selector)
  c[1]              -- FilterValueControl (value input)
```

Reference: `FilterLogicalControl.AddFilterLine`, `FilterLineControl` constructor

### Card Page Data Loading
After drill-down opens a card page (FormCreated event), field values are empty. Must send `LoadForm(loadData:true)` to populate StringValue properties. Data arrives as `PropertyChanged` events.

Reference: `EditLogicalControl.ObjectValue` reads from `ColumnBinder[RowEntry]` -- empty until `LoadData()` fills the BindingManager.

### SaveValue Echo Behavior
BC DOES echo back validated/formatted field values as `PropertyChanged` events after `SaveValue`. No client-intent patches needed.

Reference: `LogicalControlObserver.BeforeGetChanges` registers changed StringValue/ObjectValue.

### Report Execution Protocol
Reports are opened via `OpenForm` with `query: "report=<id>&tenant=<tenantId>"`. NOT a standalone `RunReport` RPC method or `InvokeSessionAction`. BC opens the report's request page as a `DialogOpened` event with `MappingHint: "RequestPage"`. Fill parameters with `SaveValue`, execute with `InvokeAction(OK)`.

Reference: `NavRunReportPropertyBagInvokedAction.cs`, `RunReportAction.cs` (decompiled). Verified against live BC28: report 6 (Trial Balance) returns request page dialog.

### Company Switching
Uses `InvokeSessionAction` with `SystemAction: 500` (ChangeCompany). All server-side page state is reset. The `SessionSettingsChangedHandler` response carries the new company info.

Reference: `ChangeCompanyAction.cs`, `NavSystemCodeunitSystemActionTriggers.cs` (decompiled). Wire format needs further protocol investigation -- the exact namedParameters may differ from the initial implementation.

### BC27 vs BC28 Wire Compatibility
Wire format is identical: same handler types, type abbreviations (~50 aliases), compatibility version (15041). Only addition in BC28: `CopilotSettingsChanged` event (ignorable). A single codec handles both.

Reference: `ResponseManager.cs`, `VersionCompatibility.cs`, `BrowserLogicalChangeTypeIds.cs` compared between versions.

### Reactive control tree (FormState shape)

`FormState.root` is the canonical tree representation of a BC form, built once
from the `lf` JSON via `buildFormTree` and mutated in place by `PropertyChanged`
events via `applyPropertyChange` (`src/protocol/form-tree-mutator.ts`). Off-path
nodes are reused by reference (structural sharing); on-path nodes get a fresh
copy with merged properties.

Repeater rows live separately in `FormState.rows: Map<repeaterPath, RepeaterRow[]>`
because `DataLoaded` events don't fit the publish-then-mutate model.

Derived views (`fields`, `actions`, `tabs`, `repeaters`, `groupVisibility`,
`filterControlPath`) are memoised pure functions over the root via WeakMap
(`src/protocol/form-views.ts`). Same root reference returns the same array
reference; tree mutation produces a new root and invalidates the cache
automatically.

`ControlField` and `ActionInfo` (`src/protocol/types.ts`) are now MCP output
DTOs only -- internal code reads `FieldNode`/`ActionNode` from `form-node.ts`
via the views. Adapters (`fieldNodeToControlField`) translate at the MCP
boundary for output JSON stability.

Reference: `Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs`
for wire-format property names; `Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs`
for the PageType enum.

## SystemAction Enum (Complete)

```
None=0, New=10, Delete=20, Refresh=30, Edit=40,
EditList=50, View=60, ViewList=70, OpenFullList=80,
AssistEdit=100, Lookup=110, DrillDown=120,
Ok=300, Cancel=310, Abort=320,
LookupOk=330, LookupCancel=340, CloseOk=350,
Yes=380, No=390,
PageSearch=220, RunReport=210, ChangeCompany=500
```

Reference: `SystemAction.cs` (decompiled, identical BC27/BC28)

## Handler Types (Complete)

12 handler type strings used in BC protocol:
```
DN.LogicalClientChangeHandler       -- Form data/property changes (most common)
DN.LogicalClientEventRaisingHandler -- Session events (FormToShow, DialogToShow, etc.)
DN.CallbackResponseProperties       -- Invoke metadata (sequenceNumber, completedInteractions)
DN.CachedSessionInitHandler         -- Session credentials (ServerSessionId, SessionKey, CompanyName)
DN.SessionInitHandler               -- Session init data
DN.LogicalClientInitHandler         -- Logical client state
DN.LogicalSessionChangeHandler      -- Session property changes
DN.SessionSettingsChangedHandler    -- Company/timezone/locale changes
DN.NavigationServiceInitHandler     -- Navigation tree init
DN.NavigationServiceChangeHandler   -- Navigation tree updates
DN.EmptyPageStackHandler            -- No pages open signal
DN.IsExecutingHandler               -- Server busy polling
DN.ExtensionObjectChangeHandler     -- Control add-in changes
```

## Testing Strategy

### Integration-First
Verify against real BC first. Codify verified behavior as unit tests second. Never mock what you don't understand.

### Test Tiers
1. **Unit tests** (`tests/unit/`, `tests/protocol/`): Pure logic, no BC needed. Run with `npx vitest run` (37 files, 292 tests).
2. **Integration tests** (`tests/integration/`): Against real BC28 (Cronus28). Run with `npx vitest run --config vitest.integration.config.ts` (18 files, 111 tests).
3. **Workflow smoke tests**: Exercises all 11 MCP tools in realistic multi-step workflows.
4. **Edge case tests**: Protocol edge cases, error handling, cross-version compatibility.

### Stale Server Process
The MCP endpoint test spawns an HTTP server on port 3456. If it doesn't shut down properly, subsequent test runs fail because they connect to the stale server (with old code). Kill it:
```bash
netstat -ano | grep 3456 | grep LISTEN
taskkill //F //PID <pid>
```

### Session Death Cascading (Resolved)
Integration tests run single-process serial via `vitest.integration.config.ts` (`fileParallelism: false`, pool: `forks`, `isolate: false`) against Cronus28 only. All integration test files obtain sessions via `tests/integration/helpers/session-pool.ts` (`IntegrationSessionPool`), which rotates three SUPER users (`sshadows`, `bcmcp_test1`, `bcmcp_test2`) and enforces a 16-second post-poison cooldown before reusing a slot, so a single poisoned NTLM auth slot can never cascade into the next test file.

Run `pwsh ./scripts/provision-test-users.ps1` once to create the pool users on Cronus28 (idempotent; skips already-present users).

`BCSession` now drains all queued invokes immediately on session death (fast-fail), so a crashed session no longer causes every pending call to eat a full 30-second timeout before the next test file can proceed.

## Tool Descriptions (2026 Best Practices)

Following Anthropic's official guidance:
- Minimum 3-4 sentences per tool description
- Include when to use / when NOT to use
- Document inter-tool relationships (pageContextId flow)
- `bc_` namespace prefix for Tool Search discovery
- Keyword-rich for MCP Tool Search matching
- Consider `input_examples` for complex tools

Source: https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools

## Known Limitations

### Document Pages (Multi-Repeater)
Document pages (Sales Order=42/43, Purchase Order=50/51) have both a header repeater and a lines subpage repeater. The current PageState only tracks one repeater. Drilling down from document list pages may use the wrong repeater's bookmarks. This is a known architectural limitation to be addressed.

### Session Recovery
After a session-killing error, BC holds the NTLM slot for ~15 seconds. The SessionManager handles this with exponential backoff (up to 4 retries). If an invoke hangs indefinitely (confirmed BC bug), the session-level timeout (default 30s) kills the connection and triggers auto-recovery on the next request.

### Report Output Capture (Phase 6)
`bc_run_report` can execute reports and fill request pages, but cannot capture the rendered output (PDF/Excel/Word). After execution, BC delivers the report binary via `FileActionDialog` / `BrowserDownloadFileRequest` over a separate streaming channel (WCF `StreamTransfer`), not inline in the WebSocket response. Phase 6 will investigate intercepting this stream.

Reference: `ReportResultSetDownloadDecorator.SendReportStreamToClient()`, `NSClientCallback.DownloadFileAction()`, `Connection.DownloadStream` (decompiled)

### Async Message Timing
The invoke quiescence window (150ms) is a best-effort wait for trailing async `Message` notifications. In rare cases, late-arriving messages may be missed.

## Claude Desktop Configuration

```json
{
  "mcpServers": {
    "business-central": {
      "command": "node",
      "args": ["U:/git/bc-mcp/node_modules/tsx/dist/cli.mjs", "U:/git/bc-mcp/src/stdio-server.ts"],
      "cwd": "U:/git/bc-mcp",
      "env": {
        "BC_BASE_URL": "http://Cronus27/BC",
        "BC_USERNAME": "sshadows",
        "BC_PASSWORD": "1234",
        "BC_TENANT_ID": "default",
        "LOG_LEVEL": "info",
        "LOG_DIR": "U:/git/bc-mcp/logs"
      }
    }
  }
}
```

Note: `tsx` via `npx` pollutes stdout with `◇ injecting...` which breaks JSON-RPC. Use the direct path `node_modules/tsx/dist/cli.mjs` instead.

## AI Assistant Guidelines

- When dispatching parallel worktree agents, group by file overlap (not by feature). Files like `types.ts`, `schemas.ts`, `page-context-repo.ts` are touched by many features -- put them in one agent to avoid merge conflicts.
- If stuck on a protocol issue, use the decompiled BC source (`bc-decompiled-analyzer` agent)
- Use `gpt5 high` or `zen` for second opinions on complex issues
- Use `Gemini 2.5 pro` for large file analysis
- Read files before writing them
- Check all protocol assumptions against decompiled source, not v1
