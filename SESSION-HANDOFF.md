# Session Handoff — 2026-04-03

## What Was Built

Ground-up rebuild of the BC MCP Server (v2) from scratch. The v1 codebase at `C:\bc4ubuntu\Decompiled\bc-poc\` is deprecated.

### Project Stats
- **42 source files**, **18 test files**, **38 commits**
- **55 unit/protocol tests + 55 integration tests = 110 tests**
- **Tested against both BC27 (Cronus27) and BC28 (Cronus28)**
- All 7 MCP tools working in Claude Desktop

### Architecture
```
src/core/           -- Result monad, errors, config, logger, abort signals
src/connection/     -- NTLM auth (2-step HTTP login), BCWebSocket, ConnectionFactory
src/protocol/       -- EventDecoder, InteractionEncoder, StateProjection, PageContextRepository,
                       control tree parser, decompression, wire types, handler types
src/session/        -- BCSession (invoke queue, form tracking, OpenSession handshake), SessionFactory
src/services/       -- PageService, DataService, ActionService, FilterService, NavigationService, SearchService
src/operations/     -- 7 thin orchestrators (OpenPage, ReadData, WriteData, ExecuteAction, ClosePage, SearchPages, Navigate)
src/mcp/            -- MCPHandler, tool registry (7 bc_* tools), Zod schemas
src/api/            -- REST routes, middleware
src/server.ts       -- HTTP server composition root
src/stdio-server.ts -- Direct stdio for Claude Desktop
src/stdio-adapter.ts -- HTTP proxy stdio adapter
```

### MCP Tools Exposed
`bc_open_page`, `bc_read_data`, `bc_write_data`, `bc_execute_action`, `bc_close_page`, `bc_search_pages`, `bc_navigate`

## BC Test Environments

### BC27
- **URL**: http://cronus27/BC/?tenant=default
- **Username**: sshadows
- **Password**: 1234
- **Auth**: NavUserPassword
- **License popup**: Yes (auto-dismissed, appears as DialogToShow event)

### BC28
- **URL**: http://cronus28/BC/?tenant=default
- **Username**: sshadows
- **Password**: 1234
- **Auth**: NavUserPassword
- **License popup**: Yes
- **Protocol**: Wire-identical to BC27 (compatibility version 15041)

### Decompiled Reference Code
- **BC28 decompiled**: `U:/git/bc-mcp/reference/bc28/decompiled/` (14 assemblies decompiled with ilspycmd)
- **BC27 decompiled**: `C:\bc4ubuntu\Decompiled\` (various Microsoft.Dynamics.* directories)
- **BC28 native MCP server** found at `Microsoft.Dynamics.Nav.Service.Mcp` -- OData API proxy, preview-gated, does NOT replace our WebSocket approach

## All Protocol Bugs Found and Fixed

### 1. OpenSession Handshake Missing
- **Symptom**: BC silently dropped all Invoke calls
- **Root cause**: BC requires `OpenSession` RPC before any `Invoke`. Returns `ServerSessionId`, `SessionKey`, `CompanyName` that must be in every subsequent request.
- **Fix**: Added `BCSession.initialize()` that sends OpenSession, extracts credentials recursively from handler response
- **Files**: `src/session/bc-session.ts`, `src/protocol/interaction-encoder.ts` (added `encodeOpenSession`)

### 2. Per-Page Connection Was Unnecessary
- **Symptom**: v1 created a new WebSocket per page open
- **Root cause**: BC supports multiple forms on one connection via `formId` in each interaction and `openFormIds` in each request. v1's "form caching" bug was actually an `openFormIds` tracking bug.
- **Verified**: Decompiled `UISession.openedForms` is a `Dictionary<string, LogicalForm>`. `CachedFormChangeInterceptor` is client-side metadata optimization only.
- **Fix**: v2 uses single connection per session from the start

### 3. Drill-Down ArgumentOutOfRangeException
- **Symptom**: `SetCurrentRow` + `InvokeAction(Edit=40)` crashed BC
- **Root cause**: InvokeAction controlPath pointed to action button (`state.actions[].controlPath`). These paths are fragile — they shift when BC rearranges actions after row selection.
- **Verified**: Decompiled `InvokeActionInteraction.GetContextActionToExecute` calls `DefaultAction` on the resolved control, traversing up to find the Edit action. `RepeaterControl.ResolvePathName("cr")` returns `CurrentRowViewport`.
- **Fix**: Use `{repeaterPath}/cr/c[0]` (first cell in current row) for all row-targeting system actions
- **Files**: `src/services/navigation-service.ts`, `src/services/action-service.ts`

### 4. SetCurrentRow Missing Selection Parameters
- **Symptom**: SetCurrentRow interaction had incomplete parameters
- **Root cause**: v2 only sent `{ key }`. BC expects `{ key, selectAll, rowsToSelect, unselectAll, rowsToUnselect }`.
- **Verified**: Decompiled `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.Initialize()` reads all 5 parameters. Case-insensitive matching confirmed from `InteractionParameterHelper.TryGetValueIgnoreCase`.
- **Fix**: Added all selection parameters to encoder
- **Files**: `src/protocol/interaction-encoder.ts`

### 5. InvokeAction Missing Parameters
- **Symptom**: InvokeAction only sent `{ systemAction }`. BC expected more.
- **Root cause**: Missing `key: null` and `repeaterControlTarget: null`
- **Fix**: Added to encoder
- **Files**: `src/protocol/interaction-encoder.ts`

### 6. Filter NullReferenceException
- **Symptom**: Filter(AddLine) + SaveValue crashed BC
- **Root cause**: SaveValue path was `{filcPath}/c[2]/c[1]` — wrong index
- **Verified**: Decompiled `FilterLineControl` constructor: `c[0]` = SelectionControl (column), `c[1]` = FilterValueControl (value). First filter line is at `{filcPath}/c[0]`.
- **Fix**: Changed to single-step Filter(AddLine) with `FilterValue` in namedParameters (no SaveValue needed). Also fixed path to `c[0]/c[1]` for two-step fallback.
- **Files**: `src/services/filter-service.ts`, `src/protocol/types.ts`, `src/protocol/interaction-encoder.ts`

### 7. Card Fields Empty After Drill-Down
- **Symptom**: Drill-down to Customer Card showed 276 fields but all values empty
- **Root cause**: FormToShow event carries control tree structure but not data. Field values require `LoadForm(loadData:true)` to trigger `BindingManager.Fill()`.
- **Verified**: Decompiled `EditLogicalControl.ObjectValue` reads from `ColumnBinder[RowEntry]` — empty until data loaded.
- **Fix**: Send `LoadForm(loadData:true)` after drill-down FormCreated event
- **Files**: `src/services/navigation-service.ts`

### 8. Search InteractionParameterException
- **Symptom**: Tell Me search crashed with InteractionParameterException
- **Root cause**: Sent `{ sessionAction: "InvokeTellMe" }` but BC expects `{ SystemAction: 220 }` (PageSearch)
- **Verified**: Decompiled `InvokeSessionActionExecutionStrategy.cs` reads `SystemAction` enum from namedParameters. PageSearch=220 in `SystemAction.cs`.
- **Fix**: Changed namedParameters to `{ SystemAction: 220 }`
- **Files**: `src/services/search-service.ts`, `src/protocol/types.ts` (added `PageSearch = 220`)

### 9. Control Tree Path Prefix Wrong
- **Symptom**: BC28 filters failed, BC28 field captions empty, path mismatches
- **Root cause**: Control tree parser used `server:c[0]` as root, producing `server:c[0]/c[3]`. BC wire protocol uses `server:c[3]` — the `lf` node is implicit.
- **Fix**: Changed root parentPath from `'server:c[0]'` to `'server'`
- **Files**: `src/protocol/control-tree-parser.ts`

### 10. Session Death Detection
- **Symptom**: After a protocol error, session was dead but `isAlive` returned true
- **Root cause**: Only detected `InvalidSessionException` string. Needed to also detect JSON-RPC error code 1.
- **Fix**: Check both error message and JSON-RPC error code
- **Files**: `src/session/bc-session.ts`

### 11. SaveValue Echo (Non-Bug)
- **v1 assumption**: BC doesn't echo written values. Implemented `FieldValueWritten` client-intent events.
- **Reality**: BC DOES echo validated/formatted values as `PropertyChanged` events.
- **Verified**: Decompiled `LogicalControlObserver.BeforeGetChanges` registers changed StringValue/ObjectValue.
- **Fix**: Removed client-intent patches. Pure event projection works.

### 12. BC27 vs BC28 Wire Identical (Non-Bug)
- **v1 assumption**: Might need separate encoders/decoders per version
- **Reality**: Same handler types, type abbreviations, wire format, compatibility version (15041)
- **Verified**: All `TypeAlias` attributes, `ResponseManager.cs`, `VersionCompatibility.cs` compared
- **Fix**: Single codec, no version branching needed

## Known Remaining Issues

### Document Page Multi-Repeater
Document pages (Sales Order=42/43, Purchase Order=50/51) have header AND lines repeaters. `PageState` only tracks one repeater. Page 43 loads line data first, so drill-down uses line bookmarks with the header repeater context, causing `InvalidBookmarkException`.

**To fix**: Track multiple repeaters in PageState, distinguish header vs subpage repeaters. The DataLoaded event's `controlPath` identifies which repeater the data belongs to.

### Search Returns 0 Results on BC28
`bc_search_pages` works on BC27 but returns empty results on BC28. The Tell Me form opens, SaveValue is sent, but no DataLoaded events arrive. May need different timing or the search form's control structure differs on BC28.

### Async Message Timing
The quiescence window (150ms) is best-effort. Late-arriving async Messages may be missed. Could be tuned per operation type.

### NTLM Slot Holding
After a session-killing error, BC holds the NTLM auth slot for ~15 seconds. Session recovery during this window fails. The stdio-server.ts handles this with lazy reconnection on next request.

### MCP Endpoint Test — Stale Server
The MCP endpoint integration test spawns an HTTP server on port 3456. If it doesn't shut down, subsequent runs connect to the stale server with old code. Kill manually:
```bash
netstat -ano | grep 3456 | grep LISTEN
taskkill //F //PID <pid>
```

### tsx stdout pollution
Claude Desktop config must use `node node_modules/tsx/dist/cli.mjs` instead of `npx tsx` to avoid `npx` printing `◇ injecting...` to stdout which breaks JSON-RPC.

## Next Steps (Priority Order)

1. **Document page multi-repeater support** -- Track header vs lines repeaters, fix Sales Order drill-down
2. **BC28 search debugging** -- Capture the Tell Me form structure on BC28, compare with BC27
3. **Write field round-trip verification** -- The write succeeds but read-back may not reflect the change in StateProjection (PropertyChanged events may need better merging)
4. **Build with tsc** -- Currently running via tsx. Add proper build step for production use
5. **Remaining services tests** -- More edge cases on filters, actions, navigation
6. **HTTP server hardening** -- Proper error handling, request logging, graceful shutdown
7. **MCP Streamable HTTP transport** -- The spec supports it, BC28's native MCP uses it

## Key Files for Continuing Work

| Purpose | File |
|---------|------|
| Architecture spec | `C:\bc4ubuntu\Decompiled\bc-poc\docs\superpowers\specs\2026-04-03-bc-mcp-v2-design.md` |
| Implementation plans | `C:\bc4ubuntu\Decompiled\bc-poc\docs\superpowers\plans\2026-04-03-v2-plan*.md` |
| Protocol core | `src/session/bc-session.ts`, `src/protocol/event-decoder.ts`, `src/protocol/interaction-encoder.ts` |
| Control tree parser | `src/protocol/control-tree-parser.ts` |
| State projection | `src/protocol/state-projection.ts` |
| Services | `src/services/*.ts` |
| Tool definitions | `src/mcp/tool-registry.ts` |
| Recorded control trees | `tests/recordings/page21-control-tree.json`, `tests/recordings/page22-control-tree.json` |
| Workflow tests | `tests/integration/workflow-smoke.test.ts`, `tests/integration/advanced-workflows.test.ts`, `tests/integration/edge-cases.test.ts` |
