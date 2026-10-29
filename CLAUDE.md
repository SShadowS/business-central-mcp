# BC MCP Server v2

## Development Philosophy

This project is released and in active development:
- Always choose the best solution, not the quickest compromise
- Refactor aggressively when architecture is flawed
- Fix problems properly, not with workarounds
- No stubs, mocks, or skeleton implementations -- everything must be fully functional
- No backwards compatibility concerns -- make breaking changes freely

## Quick Start

### Project Location
- **Decompiled BC28**: `U:/git/bc-mcp/reference/bc28/decompiled/`
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
npm run typecheck                    # Type check src (tsconfig.json) AND src+tests (tsconfig.test.json)
npx vitest run                       # Unit + protocol tests
npx vitest run --config vitest.integration.config.ts  # Integration tests against real BC28
npm start                            # HTTP server on port 3000
npm run start:stdio-direct           # Direct stdio for Claude Desktop
```

### Rules
- Use Windows paths with forward slashes in bash
- Always run `npm run typecheck` after changes. Plain `npx tsc --noEmit` checks only `src/`, and vitest strips types without checking them, so test fakes drift silently without it.
- Build test `BCConfig` objects with `makeTestBCConfig(overrides)` (`tests/helpers/test-config.ts`), never a hand-written literal.
- Run integration tests after any protocol-level change
- ESM project -- use `.js` extensions in all imports

## Protocol Verification Procedure

**CRITICAL: Always verify protocol behavior against decompiled BC source.**

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

### Event-Driven Protocol
BC sends handler arrays as responses. The EventDecoder transforms these into typed `BCEvent[]`. State is derived from events via `FormProjection` into per-form `FormState`, coordinated by `PageContext`.

`PageContextRepository` (`src/protocol/page-context-repo.ts`) is a thin facade over a CQRS trio:
- `PageContextStore` (`src/protocol/page-context-store.ts`) -- pure storage, no business logic.
- `PageEventRouter` (`src/protocol/page-event-router.ts`) -- pure routing decisions, returns a `RoutingDecision` union without mutating state.
- `FormStateReducer` (`src/protocol/form-state-reducer.ts`) -- applies routed events to produce the next `FormState`.

The public API of `PageContextRepository` is unchanged; callers do not need to know about the split.

### Invoke Queue
All invokes are serialized via a promise queue in `BCSession` (`src/session/bc-session.ts`). BC's protocol is stateful -- concurrent sends corrupt sequence numbers. The queue, drain-on-death, quiescence window, and modal retry logic all remain in `BCSession`. Two pure helpers were extracted: `isFatalRpcError` (`src/session/rpc-error-classifier.ts`) classifies fatal vs. retriable RPC errors; `findLicenseDialog` (`src/session/license-dialog.ts`) locates license/evaluation dialog events for auto-dismissal during session init.

### Session Lifecycle
`SessionManager` (`src/session/session-manager.ts`) owns lazy session creation and dead-session recovery with exponential backoff (1s, 2s, 4s, 8s). Server entry points (`server.ts`, `stdio-server.ts`) use it instead of managing sessions directly. When a dead session is detected, all page contexts are cleared and `SessionLostError` is thrown. `LogicalModalityViolationException` (stale modal state from crashed sessions) is handled with the same retry logic. Mid-session, `BCSession.reconcileModalStack` sends `CloseForm` to each stale dialog (top first) and retries once. Not `InvokeAction(Abort=320)`: confirms, messages and request pages have no Abort button, so `InvokeActionInteraction` finds nothing to run and the dialog stays open (verified live on cronus29 with the report 6 request page: Abort answers `InvokeCompleted` only, no `State: 0`, next OpenForm still violates modality; CloseForm reports `State: 0`). A closed confirm keeps its preset `DialogResult` (`MessageForm.CreateMessageDialogCore`; close never sets it, `RevertClose` only nulls it), which reads as No: an AL `Confirm` (`ServiceClientCallback.OnConfirm` -> `MessageHelper.ShowConfirm` -> `ShowMessageForm`, preset Ok, `== Yes` check) and platform confirms (`MessageForm.Show`, preset `defaultResult`, callers check `== Yes`). Verified live on cronus29 with a real Yes/No confirm that writes nothing either way (`tests/integration/modal-recovery.test.ts`: an invalid "Maximum rows" on the report 6 request page, then Refresh asks `Message_DiscardChanges` via `NavRefreshAction.DoConfirm`; after CloseForm the next Refresh asks again, after Yes it does not). A request page with validation errors: closing it asks `Message_DiscardChanges` itself (`LogicalFormClosingHandler.HandleFormClosingWhenErrors`, in the FormClosing phase, before `NavFormCloseHandler.ExecuteCloseCore` runs any AL), and No cancels the close. `BCSession` tracks forms whose own `ValidationResults` (on `server:`, not a hosted part's) hold a `Severity: 'Error'`; an empty array clears it (BC observes the form's validation holder like a control's; live cronus29 sends both). When reconcile's CloseForm on such a `RequestPage` raises a `ConfirmDialog`, it answers that first confirm Yes (`InvokeAction` Yes=380): `LogicalForm.Cancel()` + `RequestForceClose`, then `NavRequestPage.OnFormClosing` sets `DialogResult` Cancel, so the report never runs, the same outcome as a close without errors (live: both forms report `State: 0` in one response). Yes is answered once per form per reconcile; any later confirm on that form could be AL's (`OnQueryClosePage`) and is closed as No. Not `ForceClose`: it skips `Cancel()`, so `ExecuteCloseForm` would save a dirty form. Only dialogs whose `MappingHint` (kept on `ModalStack`) is `ConfirmDialog`/`InfoDialog`/`ErrorDialog` (MessageForm) or `RequestPage` (live cronus29; `NavRequestPage` closes with CancelClose, null result -> Cancel) are closed; any other modal (`Page.RunModal` page, lookup, StrMenu) fails the reconcile, so the session resets and BC rolls the pending work back. Closing one would accept it: `NavFormCloseHandler.ExecuteCloseCore` sets `DialogResult ??= FindExitActionFormResult` (OK with no action bar or one OK exit action, LookupOK on a lookup; also under `ForceClose`) and saves a dirty form. A dialog BC answers with `FormNotFoundException` is dropped locally; a CloseForm that reports no close fails the reconcile (session reset). Each closed dialog's `FormClosed` (only that, never the CloseForm's other events, which would read as the retried call's outcome) goes to `BCSession.onReconciledClose`, which `SessionManager` wires to `PageContextRepository.applyEvents`, so the dialog leaves its page context even when the triggering caller drops its invoke result (run_report, search). License/evaluation dialogs are auto-dismissed during session init (via `findLicenseDialog`).

Configurable via env vars: `BC_INVOKE_TIMEOUT` (default 30s; OpenSession and modal-reconcile sub-invokes only), `BC_ISEXECUTING_POLL_INTERVAL` (default 10s), `BC_INVOKE_MAX_DURATION` (default 600s), `BC_RECONNECT_MAX_RETRIES` (default 4), `BC_RECONNECT_BASE_DELAY` (default 1s), `BC_PROFILE` (BC profile id e.g. `BUSINESS MANAGER`; empty = server default — see Tell Me Search section).

## BC Protocol Patterns (Verified from Decompiled Source)

### OpenSession Handshake (Required)
Every session starts with an `OpenSession` RPC that returns `ServerSessionId`, `SessionKey`, `CompanyName`. All subsequent `Invoke` calls must include these fields plus `tenantId`, `navigationContext`, `features`, `supportedExtensions`.

Reference: `BCSessionManager.ts` (v1), `NsServiceJsonRpcHostFactory.cs` (decompiled)

### WebSocket `/csh` Upgrade Requires an `Origin` Header (BC 28.3+)
The `/csh` upgrade MUST carry an `Origin` header of the form `<scheme>://<host>[:port]` (no path). BC 28.3's web server (`Prod.Client.WebCoreApp`) runs `RequestOriginValidationMiddleware`, which 403s any WebSocket upgrade whose Origin is empty or cross-origin (`DisableWebSocketOriginValidation` defaults to false). The `ws` npm client sends no Origin unless told to, so `ConnectionFactory.create()` sets `headers['Origin']` from `auth.prepare().origin` (on-prem: `new URL(baseUrl).origin`; SaaS: `https://businesscentral.dynamics.com` — a cluster Origin is HTTP 500). Same-origin is always allowed; the header is a no-op on BC 28.0, which does not gate on origin. Do NOT put Origin in `getWebSocketHeaders()` — the HTTP report-download path reuses those headers and must not send it.

Reference: decompiled `RequestOriginValidationMiddleware.IsSameOrigin` / `IsOriginAllowedForWebSocket` (28.3 `Prod.Client.WebCoreApp.dll`); `docs/investigations/2026-07-24-bc283-csh-403.md`; live cronus28 (403 without Origin -> 101 with it).

### SaaS / BC Online web-client session (`SaasWeb`)

A `businesscentral.dynamics.com/{aadTenant}/{env}` URL selects `authMode: 'SaasWeb'`. UI tools use `SaasWebSessionProvider` (ESTS cookie session, no `BC_PASSWORD`). `bc_query` uses a separate `OAuthAuthProvider` (device-code) and requires `BC_CLIENT_ID`: a publisher-owned multi-tenant public Entra app with delegated `user_impersonation` — customers register nothing and consent per user. Missing sign-in fails fast with `DEVICE_LOGIN_REQUIRED` carrying the devicelogin URL + user code (pending sign-in persisted in `{stateDir}/oauth-pending.json`; retry polls once and resumes); without `BC_CLIENT_ID` it returns `OAUTH_NOT_CONFIGURED`; it never sends Basic. Do not borrow Microsoft first-party clients (Azure PowerShell `1950a258…` etc.): hardened tenants reject them at browser sign-in with `AADSTS65002` (tenant-dependent, verified live 2026-08-16), invisible to the tool — the code just stays pending.

- First UI tool opens a loopback window (`127.0.0.1` + `xdg-open` / `open` / `start`). Password and MFA stay there. Optional `npx business-central-mcp login` (or `npx tsx src/stdio-server.ts login`).
- Portal cookies: `{cwd}/.state/saas-web-cookies.json` (or `STATE_DIR` if set), mode 0600. Per-repo; sessions in the same repo share the file. `isAuthenticated()` = a portal-host `*.auth` cookie OR `.AspNetCore.Cookies` present, or the provider's in-memory authenticated flag (BC names the auth cookie by the RESOLVED AAD GUID, so it is matched by suffix — a domain-form tenant id never appears in the cookie name). `invalidate()` drops the tab only.
- `/csh` is `wss://{cluster}/tenant/{runtimeId}/tab/{tabId}/csh` from `prepare()` (`ConnectionBinding.wsUrl`). `Origin` is `https://businesscentral.dynamics.com` (cluster Origin → HTTP 500). New tab every WebSocket.
- OpenSession `tenantId` is the cluster runtime id (`msft1…`) from `/api/deployment`, via `ConnectionFactory.sessionTenantId` after `prepare()`. Config `bc.tenantId` stays the AAD GUID.
- Downloads use the tab HTTPS base (`ConnectionBinding.httpBaseUrl` on the last `prepare()`), same-session cookies.
- `SessionManager` does not retry `SIGN_IN_REQUIRED` / `URL_ELICITATION_REQUIRED`.
- Do not import `scripts/proto-saas-*` or `ensure-chromium.ts` from `src/`.

Reference: `docs/superpowers/specs/2026-08-15-saas-web-session-design.md`.

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

#### Multi-Row Selection (`bc_execute_action { bookmarks: [...] }`)

`bookmarks: string[]` selects N rows before invoking the action: it sends `SetCurrentRowAndRowsSelection` with the full set (anchor = `bookmarks[0]`, which MUST be a member so selection-consuming actions like Delete see the current row in `SelectedRows`), then the action, atomically via `BCSession.invokeSequence` (one queue entry). Only selection-consuming actions (Delete) act on all rows; Edit/View/DrillDown/New use the anchor only and are rejected with `bookmarks[]` (`isCurrentRowOnlyAction`). A stale anchor (not in BC's loaded rows) returns `INVALID_BOOKMARK`; non-anchor bookmarks not loaded are silently skipped by BC. `BC_MAX_SELECTION` (default 100) caps the set. `selectAll` is not supported.

**Multi-row action availability is page-specific and detected, not assumed.** BC computes action enablement server-side (decompiled `ActionControl.Enabled` = `Action.CanInvoke`; `DeleteAction.CanInvoke` requires `bindingManager.Deletable` and `ActionContext.CanInvokeOnRepeaterMultipleItems`) and pushes an `Enabled=false` PropertyChanged once `SelectedRows.Count > 1` on pages that forbid the multi-record action. Invoking a server-DISABLED action is a silent no-op (`CanInvoke=false` -> `DeleteAction.InvokeCore` never runs), which previously returned success with nothing deleted. `ActionService` now reads the target action's post-selection `Enabled` (the `SetCurrentRow` echo rides in on the same `invokeSequence` response) and returns `MultiRowActionUnavailableError` (code `MULTI_ROW_ACTION_UNAVAILABLE`) instead. Where the action stays enabled, `DeleteAction.InvokeCore` loops `SelectedRows` and the same frames delete all selected rows for real.

Verified live (`scripts/probe-action-enabled.ts`, cronus28): the Customer list (page 22) keeps Delete enabled for a single row but flips it to `Enabled=false` at 2+ rows, so a 3-row Delete returns `MULTI_ROW_ACTION_UNAVAILABLE`; setup lists Payment Terms (4) and Countries/Regions (10) keep Delete enabled under a 3-row selection. The encoder needed no change — its `key:null`/`repeaterControlTarget:null` match the live web-client Delete frame exactly (captured via Playwright `page.on('websocket')`); the web client's optional `expectedForm` cache-key and selection `force:false` are not required.

Reference: decompiled `ActionControl.cs` (`Enabled` getter), `DeleteAction.cs` (`CanInvoke` + `InvokeCore` loops `SelectedRows`), `RowEntrySelectionHandler.cs` (`AllowMultipleSelection`), `SetCurrentRowAndRowsSelectionInteraction.cs`. Tests: `tests/unit/execute-action-branches.test.ts` (gate cases), `tests/integration/multi-row-selection.test.ts` (MRS1 disabled + MRS4 enabled, live).

### Tell Me Search
Uses `InvokeSessionAction` with `SystemAction: 220` (PageSearch). NOT `sessionAction: "InvokeTellMe"`.

The form opens as a regular `FormCreated` (not `DialogToShow` — Tell Me is non-modal on BC28). The search input is at `server:c[0]/c[0]` (the sc inside a gc container at `server:c[0]`); SaveValue against the gc container alone returns no DataLoaded events. Two result repeaters at `server:c[1]` (pages/lists) and `server:c[2]` (reports/extras) emit DataLoaded streams with NAMED cells (`Name`, `Source`, `DepartmentPath`, `DepartmentCategory`, `SearchScore`). `cells.Source.stringValue` is JSON-encoded `[{"page": "<AL name>"}]` or `[{"report": "<AL name>"}]` — BC identifies pages by AL name, not numeric id.

Tell Me is profile-scoped on the BC server. `BC_PROFILE` env var (e.g. `BUSINESS MANAGER`) is plumbed into OpenSession's `profile` field to select an indexed profile. Server uppercases/trims; unknown ids silently fall back to user default.

Reference: `InvokeSessionActionExecutionStrategy.cs`, `SystemAction.cs` (PageSearch=220), `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs` (Profile field), `Microsoft.Dynamics.Nav.Service/NSService.cs:OpenConnection`. Live wire fixture: `src/protocol/captures/tell-me-result-2026-04-28.json`.

### Cuegroups (Role-Center cue tiles)

Cuegroups are AL `cuegroup` containers that compile to a `stackgc` wire type (NOT a generic `gc` with a mapping hint, despite older docs). Children are `stackc` cue tiles inside an inner `gc { MappingHint: 'STACKGROUP' }`. Cue values (`StringValue`) arrive via `PropertyChanged` events AFTER `LoadForm(loadData:true)` — not in the initial FormCreated. `PageService.discoverAndLoadChildForms` sends `LoadForm { openForm:true }` plus `InvokeAction(Refresh=30)` for Role Center hosted CardParts to trigger cue computation. The Role Center and factbox hydration sequences have been extracted from `PageService` into dedicated strategy classes: `FactboxHydrationStrategy` (`src/services/strategies/factbox-hydration.ts`) and `RoleCenterHydrationStrategy` (`src/services/strategies/role-center-hydration.ts`).

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

### Company Switching (verified live cronus28)

A company switch is a **re-`OpenSession` bound to the target company on the same WebSocket** — NOT `SystemAction: 500`. BC binds a session to a company ONLY via the top-level `company` parameter of `OpenSession`. Two things that look right but are NO-OPs on an already-open session (both verified live: customer-list row identities unchanged after each):
- `InvokeSessionAction` with `SystemAction: 500` (ChangeCompany) — `ChangeCompanyAction.InvokeCore` calls `InvokeCodeUnit(2000000006, "ChangeCompany", args=[""])` with an EMPTY company arg and ignores `namedParameters.company` entirely. It returns `InvokeCompleted` (looks successful) while the session stays in the old company. This was the old bug: the switch never stuck.
- The per-request envelope `company` field — the web-server host keys the ClientSession by company at connect time (`SegmentNameWithFallbackSessionIdGenerator`), so changing it per-request does not rebind.

`BCSession.changeCompany(name)` (`src/session/bc-session.ts`) re-runs `OpenSession` with `company: name` as ONE queued task (no interleave with in-flight invokes), then drops stale form/modal tracking. On success `this.company` reflects BC's echoed name and all previously open forms are gone (server-side state reset to the new company); `SwitchCompanyOperation` then `repo.clearAll()`s the page contexts. Company names are **case-SENSITIVE** — a wrong-case or unknown name throws `NavWebFailedOpenCompanyException` ("The company ... does not exist."), which `SwitchCompanyOperation` maps to `CompanyNotFoundError` (code `COMPANY_NOT_FOUND`); the session is left untouched on the current company (no page-context loss).

Verified live (cronus28, two companies "CRONUS Danmark A/S" populated + "My Company" empty): switch CRONUS→My Company drops the customer list to 0 rows, round-trips back to 5; invalid and wrong-case names return `COMPANY_NOT_FOUND` with the session still on CRONUS.

Reference: decompiled `ChangeCompanyAction.cs` (empty-arg codeunit call), `NavSystemCodeunitSystemActionTriggers.InvokeChangeCompany` (ByRef return, no input name), `CallbackRequestData.Company` + `SessionIdProviderFactory`/`SegmentNameWithFallbackSessionIdGenerator` (company is part of session identity, set at connect). Encoder: `InteractionEncoder.encodeOpenSession(tenantId, spa, profile?, company?)`.

### Dimensions Read/Write Workflow (No New Tool Required)

Reading and writing dimensions on any document or card uses only existing tools. Verified live against Cronus28.

1. Open the host document/card: `bc_open_page`.
2. Invoke the dimensions editor: `bc_execute_action(pageContextId, "Dimensions")`. This opens the "Default Dimensions" or "Dimensions" list page as a non-modal form; its `pageContextId` is returned in `openedPages`. The action often sits under a "Related" section — pass `section` if the host page has multiple action sections.
3. Read current dimensions: `bc_read_data(dimPcId)`. The repeater exposes columns: "Dimension Code", "Dimension Value Code", "Dimension Value Name", "Value Posting", "Allowed Values Filter".
4. Set a value: `bc_write_data` targeting the "Dimension Value Code" column on the relevant row (by bookmark). BC validates the code against the Dimension Value table — an invalid code returns `VALIDATION_ERROR`. New rows use synthetic `DraftRecord{N}` bookmarks and are writable immediately. Use `bc_lookup` on the "Dimension Value Code" field to browse valid values before writing.
5. Commit: `bc_execute_action(dimPcId, "OK")` or `bc_close_page`.

Notes:
- "Value Posting" is an option field (blank / "Code Mandatory" / "Same Code" / "No Code") — values are exposed in the `options` array on read.
- The dimensions page is list-style; all standard `bc_read_data` / `bc_write_data` row-targeting patterns apply.

### BC Native MCP Server: Data Query Tools (`bc_data_*`, BC 29+, verified live on BC 29.1)
BC 29 hosts its own MCP server on the OData port: `McpHostFactory` registers an HttpSys host named `mcp` when `ODataServicesEnabled` and `McpServicesEnabled` (default true) are on, so the endpoint is `{odataUrl}/mcp` (`config.bc.mcpUrl`, `BC_MCP_URL` overrides), with OData's auth (Basic on-prem). Transport is stateful Streamable HTTP (`Stateless = false`, 2h idle), protocol `2025-11-25`; POST answers are SSE and `Accept: application/json` alone is refused (406). An unknown session id answers 404 `{"code":-32001,"message":"Session not found"}`. `BCMcpClient` (`src/bcmcp/bc-mcp-client.ts`) uses the official `@modelcontextprotocol/sdk` client, reconnects once on that 404, and maps connect 404 / 412 (`McpFeatureGate`: "MCP Server" Copilot capability off) / a missing tool to `DATA_QUERY_UNAVAILABLE` (`reason`: `endpoint-missing` / `mcp-disabled` / `tools-disabled`).

The four tools exist only when the MCP Configuration row (system table 2000000292) has `EnableAlQueryTools` (field 9) on ("Data Query Tools (Preview)"); `McpConfiguration.GetToolCatalogAsync` adds `AlQueryToolCatalog`. On Cronus291 it was set via SQL (`[MCP Configuration].[EnableAlQueryTools] = 1`) and only took effect after a container restart. `bc_data_query` parses `queryText` with `SyntaxTree.ParseObjectText`, compiles it with `NavDynamicObjectCompiler` (exactly one `query` object), forces `ReadOnly = true` and runs it with `SecurityFiltering.Filtered`; `top` 1-50 (default 10), `skip` <= 100000, `totalCount` only when skip = 0; another company runs in a child session. Without a `Company` header the session is unpinned: every tool requires a `company` argument and `list_companies` (`[{Name, DisplayName, isDefault}]`) is added, so `DataQueryOperation` passes company per call (input, then the /csh session company, then `BC_ODATA_COMPANY`, then BC's `isDefault`). Semantic `bc_data_find_tables` returned `[]` on the on-prem container; keyword works.

Host network caveat (2026-10-29): from this dev host, HTTP/1.1 responses from the Hyper-V NAT BC containers stall (OData `$metadata` stops at ~64 KB, MCP SSE streams never close and >8 KB bodies truncate), while the same requests from inside the container finish in ms. Not a BC limit (checked `ClientServicesMaxConcurrentConnections`, `MaxConcurrentCalls`, `ODataMaxBodySize`, HttpSys options); disabling vSwitch RSC and Defender HTTP parsing did not help. Live verification ran inside Cronus291 via `C:\ProgramData\BcContainerHelper` (mounted in every container): `node.exe` + an esbuild bundle of `src/stdio-server.ts`, and the repo for `tests/integration/data-query.test.ts` (runs only when `BC_MCP_TEST_URL` is set).

Reference: decompiled BC 29.1 `reference/bc29.1/decompiled/Microsoft.Dynamics.Nav.Service.Mcp/` (`AlQueryToolCatalog.cs`, `McpConfiguration.cs`, `NavMcpPlatformServer.cs`, `NavMcpPlatformSession.cs`, `McpStartup.cs`). Tests: `tests/unit/data-query-operation.test.ts` (real SDK server in-process, `tests/helpers/fake-bc-mcp-server.ts`).

### BC27 vs BC28 Wire Compatibility
Wire format is identical: same handler types, type abbreviations (~50 aliases), compatibility version (15041). Only addition in BC28: `CopilotSettingsChanged` event (ignorable). A single codec handles both.

Reference: `ResponseManager.cs`, `VersionCompatibility.cs`, `BrowserLogicalChangeTypeIds.cs` compared between versions.

### AL Test Runner (`bc_run_tests`, #43, verified live on cronus28)
`RunTestsOperation` (`src/operations/run-tests.ts`) drives page 130455 "Command Line Test Tool" from Microsoft's Test Runner app (source ships inside the .app: `C:\Applications\TestFramework\TestRunner\Microsoft_Test Runner.app` in a container). Every selection field's OnValidate deletes the suite's lines and reselects, so fields are written in a fixed order: Suite Name, Test Runner Codeunit ID, Extension ID, Required Test Isolation, Test Type, Test Codeunit Range, Test Procedure Range. Suite Name is written TWICE: for a new suite, `ChangeTestSuite` creates it but leaves `GlobalALTestSuite` unloaded, so the next selection lands in a nameless suite and "Run Next Test" answers "All tests executed." at once; the second validate loads it. Each "Run Next Test" runs one codeunit (~250ms for the probe app) and leaves `TestResultsToJSON` output in "Test Result JSON" (`result`: 0 not run, 1 Failure, 2 Success, 3 Skipped). An unknown page 130455 is `NavPageBuildErrorException` "...was not found" -> `TEST_RUNNER_NOT_INSTALLED`. Tests: `tests/unit/run-tests-operation.test.ts`.

### BC26: `/csh` is a SignalR hub (#42, verified live on Cronus26)
BC26 maps `/csh` to the SignalR hub `ClientServiceHub` (JSON hub protocol, records end in `0x1E`). Its one client method is `InvokeRequest(JsonRpcRequest)` (OpenSession and Invoke), answered by a type-3 completion `{compressed:true, result:'<base64>'}`; the server pushes `Message(ClientMessage)` (`{compressed:true, data:'<base64>'}` or an uncompressed `data` array) and `Session("Close")`. BC26 never answers a raw JSON-RPC frame; BC28 closes the socket on a SignalR handshake. `BCWebSocket.connect` probes with the handshake once per server (cached by host + first path segment) and `routeSignalR` normalizes to the BC28 raw shapes (`compressedResult` / `compressedData`), so nothing above the socket knows the framing. The hub runs one invocation per connection (SignalR default `MaximumParallelInvocationsPerClient=1`), so on SignalR `probeIsExecuting` returns `'true'` and liveness is socket close + `BC_INVOKE_MAX_DURATION`. The client pings (`{type:6}`) every 15s; the server drops a client silent for 30s.

The `csrftoken` query param is the antiforgery REQUEST token from `POST {baseUrl}/csrf?tenant=` (`{csrfToken}`), on every version. BC28 also accepted the antiforgery cookie value; BC26's `QueryBasedAntiforgeryProtectionMiddleware` answers it with 401 (+ an NTLM challenge header, which is misleading). A BC26 container is multi-tenant: a sign-in without `?tenant=` fails with `NavTenantNotFoundException`.

Reference: decompiled BC26 `Prod.Client.WebCoreApp` (`ClientServiceHub.cs`, `SignalRHubMiddleware.cs`, `Startup.cs`) in `reference/bc26/webcoreapp/`. Test: `tests/unit/signalr-framing.test.ts`.

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

## Handler Types

The 12 BC protocol handler type strings and their meanings are defined in `src/protocol/handler-types.ts`.

## Testing Strategy

### Integration-First
Verify against real BC first. Codify verified behavior as unit tests second. Never mock what you don't understand.

### Test Tiers
1. **Unit tests** (`tests/unit/`, `tests/protocol/`): Pure logic, no BC needed. Run with `npx vitest run`.
   - `tests/helpers/fake-bc-socket.ts` fakes the raw socket behind a REAL `BCWebSocket`: a script per request can `reply`, push async `message` handlers (e.g. `invokeCompleted(callbackId)`), or `drop` the socket. Use it for transport-level paths such as commit-then-drop (`tests/unit/commit-then-drop.test.ts`: InvokeCompleted then close -> ledger `unknown`, retry not re-sent).
2. **Integration tests** (`tests/integration/`): Against real BC28 (Cronus28). Run with `npx vitest run --config vitest.integration.config.ts`. This tier must never modify an existing record: no writes, posts or deletes that could land.
   - **Destructive tier**: every case that writes, posts or deletes a real record lives in a `tests/integration/**/*-destructive.test.ts` file. `vitest.destructive.config.ts` includes exactly that glob and the integration config excludes it, so the file name is the tier. Run it only with the maintainer's permission. A write-and-restore case restores in `finally` and asserts the restore landed (`expectRestored` / `restoreField` in `tests/integration/helpers/restore.ts`: BC echoed it, or the control already holds the original). Read an original from the FIELD (`readField`), never from the form: `root.properties.caption` is the page caption ("Customer Card"), and `staleness.test.ts` once wrote it into customer 10000's Name ("Kontorcentralen A/S"). A card saves the dirty record on CloseForm (decompiled `SaveOnNavigationPattern.FormClosing` -> `Save(SaveDraftAction.SaveDirty)`), so `discardChanges` does not undo a landed write.
3. **Workflow smoke tests**: Exercises the MCP tools in realistic multi-step workflows.
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

Residual risk: `connection.test.ts` and `mcp-endpoint.test.ts` do not build an in-process `BCSession` (they test the raw connection layer and the HTTP server respectively) and still authenticate as `sshadows` outside the pool. If either crashes a session, a pool checkout landing on the `sshadows` slot within the ~15s NTLM hold could fail. Low-probability in practice; a future change could move them to a dedicated non-pool user.

## Tool Descriptions (2026 Best Practices)

Each MCP tool's definition (description, schema, input_examples) is colocated with its operation as a sibling `src/operations/<name>.tool.ts` module that exports `createToolDefinition(ops): ToolDefinition`. `src/mcp/tool-registry.ts` is a thin aggregator that imports all sibling modules and wires them together; it contains no per-tool description text.

Following Anthropic's official guidance:
- Minimum 3-4 sentences per tool description
- Include when to use / when NOT to use
- Document inter-tool relationships (pageContextId flow)
- `bc_` namespace prefix for Tool Search discovery
- Keyword-rich for MCP Tool Search matching
- Consider `input_examples` for complex tools

Source: https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools

## Known Limitations

### Document Pages (Multi-Repeater) — RESOLVED
Document pages (Sales Order=42/43, Purchase Order=50/51) carry a header form and a lines subpage form. `FormState.rows` is keyed per repeater controlPath and each section (header/lines/factbox) resolves to its own formId + repeaterControlPath, so header and lines rows never collide. Child-form discovery + load is a shared `ChildFormHydrationStrategy` (`src/services/strategies/child-form-hydration.ts`) run not only by `bc_open_page` but also by `bc_navigate(drill_down)` (`NavigationService.drillDown`) and action-opened pages (`ActionService.invokeAction`), so a document reached via drill-down or an action exposes its `lines` section just like a directly-opened page — earlier it had a `header` section only. Verified: `tests/integration/drilldown-lines.test.ts`, `tests/integration/multi-section-destructive.test.ts`.

### Session Recovery
After a session-killing error, BC holds the NTLM slot for ~15 seconds. The SessionManager handles this with exponential backoff (up to 4 retries). Invoke liveness is decided by BC itself, not a wall clock. While an invoke is in flight, `BCSession.withLiveness` runs an `IsExecuting` watchdog (`src/session/isexecuting-poller.ts`): every `BC_ISEXECUTING_POLL_INTERVAL` it sends an out-of-band `IsExecuting` interaction via `BCWebSocket.sendOutOfBand` (the only RPC that bypasses the send queue). BC answers it before `EnterProcessing` even while another interaction is blocked (decompiled `CallbackHandler.cs`), so:
- `true` -> still working, keep waiting (a long post or report no longer dies at 30s).
- `false` twice, 2s apart -> wedged (the confirmed BC hung-invoke bug); kill + reconnect. One `false` is not enough: BC flips it before a large response frame is flushed.
- probe error/timeout -> transport dead; kill + reconnect.
- `BC_INVOKE_MAX_DURATION` elapsed -> kill even while `true`. An explicit per-call timeout (report flow, >=120s) can only raise this ceiling, never lower it.

Each verdict has its own error message; wedged/ceiling warn that the operation may have committed server-side. Verified live (Gate A on BC28.0, and `tests/integration/isexecuting-liveness.test.ts` on BC29): in-flight probes answer in ms, idle answers `false`, no sequence corruption. Design: `docs/superpowers/specs/2026-07-24-long-running-ops-design.md`.

### Replay Gate (`operationId`, epic #17)

`MCPHandler` gates every tool with `readOnlyHint: false`: it advertises an optional `operationId` in tools/list, strips it before zod validation, and records the call in `OperationLedger` (`src/mcp/operation-ledger.ts`, one file per sha256(id) under `{STATE_DIR}/operations/`, claimed atomically by writing a temp file then `link()`-ing it into place, so a concurrent claimer or a post-crash retry never reads a partial entry). Same id + same input digest -> stored result replayed, BC untouched; different input -> `OPERATION_ID_REUSED`; status `sent`/`unknown` -> `OPERATION_IN_DOUBT` with structured state. Ambiguous failures (`TIMEOUT_ERROR`, `SESSION_LOST`, `CONNECTION_ERROR`, `PROTOCOL_ERROR`, `ABORTED_ERROR`, untyped throws) settle as `unknown`; definite BC answers release the id. The gate itself is transport-neutral: `IdempotencyGate` (`src/mcp/idempotency-gate.ts`, owns `isAmbiguousFailure`) does describe -> claim -> replay/reused/in-doubt -> run -> settle/release, and the ledger stores the operation's raw output value (each transport renders it). `MCPHandler` and the REST routes (`src/api/routes.ts`) share ONE gate instance built in `server.ts`. REST takes the key from the `Idempotency-Key` header on the three mutating routes and records it under the MCP tool name (`pages/write`=`bc_write_data`, `pages/action`=`bc_execute_action`, `pages/close`=`bc_close_page`); HTTP mapping: replay 200 + `Idempotent-Replayed: true`, reused 422, in doubt 409, definite 400, auth 401, `TIMEOUT_ERROR` 504, other ambiguous 503, untyped 500; ambiguous failures on mutating routes carry `replaySafe: false`. Tests: `tests/unit/api-routes.test.ts`.

Ledger retention (#29): `OperationLedger.prune()` deletes `completed` entries whose `updatedAt` is older than `BC_OPERATION_TTL` (default 24h, so replay is time-limited), `sent`/`unknown` entries older than `BC_OPERATION_INDOUBT_TTL` (default 30 days; a young `sent` entry may be an in-flight call, so `loadConfig` rejects an in-doubt TTL below max(24h, 2x `BC_INVOKE_MAX_DURATION`) and a `BC_OPERATION_TTL` <= 0), and `*.tmp` files older than 5 minutes (left by a process killed mid-write). All deletes are `rm({force:true})`, so processes sharing one `STATE_DIR` can prune concurrently. Both entry points call `ledger.startPruning(logger)` right after constructing the ledger (prune at start, then hourly on an `unref()`'d timer). `settle()` strips `bytes` from `result.downloads[]` before writing, so a replay returns download metadata only, each stripped entry marked `error.code: 'NOT_REPLAYED'` (keeps the `Download` contract: bytes on success, error otherwise). Tests: `tests/unit/operation-ledger-prune.test.ts`.

Entry format version (#37): every entry carries `v` (`LEDGER_FORMAT_VERSION`, 2 = raw output value). `get()` and `prune()` read entries through `upgradeEntry`, which never releases or re-runs an old entry (it may have reached BC). Unversioned `completed` entries come from two eras: pre-#30 ones stored the MCP envelope `{content:[{type:'text',text:JSON.stringify(value,null,2)}]}` (the only shape the pre-#30 handler ever settled as `completed`), so the raw value is recovered by parsing that text; #30-to-#37 ones already store the raw value (never that single-key shape, since every mutating output carries `replaySafe`) and are kept as-is. Download bytes are stripped in both cases. An exact envelope whose text is not JSON, or an unknown `v`, becomes `unknown` with `error.code: 'LEDGER_FORMAT'`: a retry returns `OPERATION_IN_DOUBT`, `bc_get_operation` reads the record back, and prune keeps it for the in-doubt TTL. Unversioned `sent`/`unknown` entries just gain `v`. Tests: `tests/unit/operation-ledger-format.test.ts`.

Read-back descriptor (#23): before claiming, the handler calls `describeTarget(input)` (`src/operations/target-descriptor.ts`, one describer shared by all mutating tools, wired in both server entry points over the live `PageContextRepository` + session company) and stores the result as `target` on the ledger entry, so it survives `clearAll()` on session loss. It holds company, the input args (minus `base64`/`expectedStateVersion`), page identity (pageContextId, pageId from the root `lf` node's wire `Metadata.id`, so action/drill-down pages are identified too, the root form's record `bookmark`, caption, pageType), section, the targeted rows (bookmark/bookmarks/rowIndex, else the repeater's current-row bookmark from `BookmarkChanged`, since row actions without a bookmark hit `{repeater}/cr`) with captioned cells, for a card-shape target the record's primary key as `keyFields: [{ fieldNo, caption, value }]` (#33: the `lf` `Metadata.primaryKeyIds` joined to the controls' `TableFieldNo`, looked up in the whole form tree outside repeater templates; live cronus29: Customer Card 21 `[1]`, Sales Order 42 `[1, 3]` where "Document Type" has no control and "No." is hidden; #34: a key field with no control is decoded from the root form's record bookmark and marked `source: 'bookmark'`, so Sales Order captures field 1 = `'1'` too; its caption comes from the form's filter control, whose wire `FilterColumns` list every filterable table field with `Id` = `ColumnBinder.Path` = `<sourceTableId>_<table name>.<fieldNo>` (decompiled `FilterLogicalControlSerializer`, `NavBindingManager.MakeBindingManagerName`, `NavFilterLogicalControl.GetFilterableColumnDescriptions`; live page 42: `36_Sales Header.1` = "Document Type"; '' when the form has no filc). An Option value stays its ordinal (`'1'`, not "Order"): option captions ride only on a control's `Items`, and a control-less key field has none -- nothing else we receive names it (live probe of page 42: no `Items`/option list anywhere for table 36 field 1). `KEY_MISMATCH` compares the ordinal; the first 5 non-empty card fields are the fallback only for an unbound form or when no key field has a control, and are then stored alongside the bookmark-only key, which proves nothing beyond `bc_get_operation`'s landed-bookmark check), and the dialog caption. Best-effort: a describer throw is logged, never blocks the call. `OPERATION_IN_DOUBT` returns it as `target`.

Record bookmark encoding (#34, `src/protocol/record-bookmark.ts`): a record bookmark is the record's serialized RecordId (decompiled `NsDataAccess.Bookmark` / `NavForm.Bookmark` = `Record.ALRecordId.GetBytes()`), sent as `ByteArrayHelper.ToUrlSafeString`: `<byte length hex>_<url-safe base64, trailing zero bytes trimmed>`. Bytes (`NavRecordId.CreateByteArrayFromValues` / `CreateNavValuesFromBytes`): int32 LE table no, then per key field a uint16 LE `NavType` tag + value (Code = alpha-index byte + UTF-16LE + `00 00`; Text = UTF-16LE + `00 00`; Integer/Option/Boolean 4 bytes; BigInteger 8; GUID 16), uint16 0 terminator. `decodeBookmark` handles those types and returns undefined for others (Date, Decimal, ...); `readKeyFields` only uses it when the table no equals the form's `sourceTableId` and the value count equals `primaryKeyIds`. Verified live cronus29: Customer `15_EgAAAAJ7BTEAMAAwADAAMA` = table 18 ["10000"], Sales Header `1D_JAAAAACLAQAAAAJ7BjEAMAAxADAAMAA5` = table 36 [1, "101009"], Sales Line = table 37 [1, "101009", 10000]. Synthetic `DraftRecord{N}` bookmarks do not decode. Tests: `tests/unit/record-bookmark.test.ts`.

bc_get_operation (#25, `src/operations/get-operation(.tool).ts`, readOnlyHint): returns the ledger entry; unless it is `completed` + `replaySafe`, it re-opens `target.page.pageId` in the CURRENT session on the root record bookmark (a list target re-opens on the targeted row's bookmark), reads the key fields back by `TableFieldNo`, `source: 'bookmark'` ones from the landed record bookmark (`readBack.keyFields`; a differing non-null value returns `readBackError: KEY_MISMATCH` with the `readBack` but no `evidenceHash`) and the identified card fields (`args.fields` names, plus the leading-field fallback identity, looked up in the whole form tree since a fresh view-mode card can hide them from `Section.fields`) or the targeted row (`null` when gone), plus `lines` (the loaded rows of the page's `lines` section) for a header target -- the key fields only identify the record, while a posting changes line state ("Quantity Shipped"), so `lines` is what makes the hash attest the outcome (live cronus29: page 42 read-back carries "Quantity Shipped"), closes the page, and returns `readBack` + `evidenceHash` (`digestInput(readBack)`, sha256 of sorted-key JSON). Field names resolve like `bc_write_data` (`findField`: caption case-insensitive, or controlPath). `readBackError`: `NO_TARGET` (no page id, or no record bookmark -- never opens unkeyed, BC would land on an arbitrary record; a non-header target never falls back to a line bookmark), `MODAL_OPEN` (a dialog is on the session's modal stack: OpenForm runs `LogicalModalityVerifier.VerifyAnyModalFormOpen` and `BCSession` would close every open dialog to recover), `COMPANY_MISMATCH` (never switches company), `SECTION_NOT_FOUND`, `RECORD_NOT_OPENED` (BC answers an unopenable bookmark with an ownerless error dialog, so `ctx.isModal`; a bookmark of a DELETED record opens the nearest record without an error, e.g. a fully posted Sales Order lands on the next order, so the root form's landed `Bookmark` is compared to the requested one). The ledger instance is shared between `MCPHandler` and the operation in both server entry points. Live finding: a card in edit mode keeps a SaveValue'd value until the page closes (`SaveOnNavigate`), so a read-back while the original card is open shows the stored (old) value. Tests: `tests/unit/get-operation.test.ts`, `tests/integration/get-operation.test.ts`.

Hosted-part PropertyChanged (found while building #25, verified live cronus29): BC sends one `LogicalClientChange` per observed ROOT form (`parameters[0]`, `ResponseManager.RegisterObservedEvents`), and a hosted factbox/subpage's own form-level properties (`Bookmark`, `SystemId`, `ServerFormHandle`, `State`, ...) ride in the host's set on `server:`. Only `ControlReference.formId` names the part (the control's `ParentForm`; a LogicalForm is its own, decompiled `ClientLogicalControlReferenceSerializer` + `LogicalControl.ParentForm`). The decoder keeps it as `PropertyChangedEvent.refFormId`, and `isHostedPartChange` (`form-state.ts`) is `server:` + `refFormId !== formId`. Live (Customer Card 21): every factbox change arrived as formId=host, refFormId=factbox; the card's own changes as refFormId=formId. Without the guard the Dimensions factbox overwrote the card's `Bookmark` with a Default Dimension record. A part's CONTROL changes (any path but `server:`) carry the same refFormId with a part-relative path, so `PageEventRouter` applies them to the refFormId form when the page holds it (live cronus28: Edit on Sales Order 42 sends formId=root refFormId=lines `server:c[1]/co[N] {Editable:true}`; before, they hit the header form and the lines columns stayed read-only). A part embedded in the root `lf` (fhc -> lf) is registered only in `ChildFormHydrationStrategy.hydrate`, after the caller applied the open events, so hydrate replays the open response's PropertyChanged events whose refFormId is a discovered child (live: page 42 opened without a bookmark sends "Line Discount %" `co[33] {Enabled:true}` in the OpenForm response; dropped, the column read as disabled). A ServerFormHandle/bookmark-table heuristic used earlier could not catch a part's close: on `Closed`, `LogicalFormObserver.GetChangesCore` sends `State` ALONE.

replaySafe (#24): every output of the nine mutating operations carries `replaySafe: boolean`, and `runIdempotent` copies it onto the ledger entry (`unknown` entries and `OPERATION_IN_DOUBT` are always false). `MCPHandler.runTool` also stamps `replaySafe: false` into `structuredContent` on the first response to an ambiguous failure (`isAmbiguousFailure`) of any non-read-only tool, gated or not. Meaning: BC's response proved that re-running the same call cannot double-apply. Rules live in `src/protocol/replay-safety.ts`; only two proofs exist, both verified live on cronus29 (2026-10-13):
- **Value echo** (write_data): `PropertyChanged` `StringValue`/`ObjectValue` on the written controlPath. BC echoes only a value that CHANGED (decompiled `LogicalControlObserver.BeforeGetChanges` compares to its cache), so rewriting the current value is unproven (false). A SaveValue on a control that is not Editable, Enabled AND Visible is a silent no-op (`SaveValueInteraction.InvokeCore` returns early), e.g. a card opened in view mode: no echo, false. `DataService.writeField` therefore refuses, sending nothing, a field/column whose published flag is false, and a line cell whose row cell (`DataLoaded`) says `editable:false`/`enabled:false`. The published flags are the effective values (`LogicalControl` computes each from the control, template column, ColumnBinder, row and parent chain; `LogicalControlSerializer` writes them only when false), except Visible inside an active wizard step, which BC leaves stale, so Visible uses `isEffectivelyVisible`. A line-cell echo arrives under the page ROOT formId with the subpage-relative `{repeater}/cr/c[N]` path, so `DataService` matches either formId and sets `FieldWriteResult.echoed`.
- **Form closed** (execute_action, respond_dialog, wizard_navigate): BC reports a closed form as `PropertyChanged { State: 0 }` on the form's `server:` path (`LogicalFormObserver`, `ClientLogicalFormState.Closed`), NOT as `ClosePendingForm` (that is the ghost-form cache key, ignored by the decoder). `BCSession.updateFormTracking` turns that `State: 0` (`isFormClosedChange`) into a derived `FormClosed` event inserted after it in the invoke result, excluding a hosted part's `State: 0` on its host's formId (`isHostedPartChange`, the same guard `FormProjection` and `formClosed` use); that one event drops the form from `openFormIds`/modal stack and drives `PageContextRepository.markFormClosed` (routed by the closed form's own index, not the caller's page hint). Verified live (cronus29, `tests/integration/form-close-tracking.test.ts`): report request page Cancel empties the modal stack, CloseForm on a card yields its `FormClosed`, a card with factboxes and Role Center 9022 yield no false closes. Any interaction on a closed formId throws `FormNotFoundException` (`InteractionParameterHelper.GetLogicalControl`; live: re-Cancel on a closed request page), so a re-run cannot re-apply. Refresh is also true (`RefreshAction` aborts the transaction and refills). `ActionResult` carries the invoked `formId` + `systemAction` for this.
- close_page: true when no dialog blocked the close (CloseForm on an already-closed form is a live-verified no-op). switch_company: true when the session ends on the requested company; a switch to the current company short-circuits (no re-OpenSession, page contexts kept), because a real re-open drops every form, dialog and draft row. run_report / upload_file: always false.

Tests: `tests/unit/replay-safety.test.ts`, `tests/integration/replay-safety.test.ts`.

End-to-end on a real posting (#27, destructive tier only, `vitest.destructive.config.ts`): `tests/integration/replay-post-destructive.test.ts` posts half of a 2-unit Sales Order line (so the order survives and "Quantity Shipped" counts commits) twice with one operationId (second call replays with zero invokes, shipped once), then kills the socket when the committing respond_dialog's response frame arrives and checks `unknown` -> `OPERATION_IN_DOUBT` -> `bc_get_operation` from a new session and ledger instance returns a read-back + evidence hash, shipped once. A fully posted document cannot be the read-back target: its record is deleted and any page opened on a missing bookmark closes with `InvalidBookmark` (decompiled `NavRunPagePropertyBagInvokedAction.ShouldShowForm`), i.e. `RECORD_NOT_OPENED`.

### File Download Capture — IMPLEMENTED

Downloads are captured generically on `bc_execute_action`, `bc_respond_dialog`, `bc_wizard_navigate`, and `bc_run_report` via a shared `DownloadService` (`src/services/download-service.ts`), which uses the same-origin `collectDownloads` guard (`src/protocol/download-collector.ts`) and the streaming `BCHttpClient` (`src/connection/bc-http.ts`). All four tools return a `downloads: Download[]` field (always present, may be empty) where `Download = { fileName, contentType, sizeBytes, style, bytes? (base64), savedPath?, error? {code, message} }`, plus `externalUris: Array<{uri, style}>`. `bc_run_report`'s old singular `download` field is replaced by `downloads[]`.

**Security model:** ONLY same-origin URLs under an allowlisted BC file path (`DynamicFileHandler.axd` or `client/uploadDownload/download`) are fetched, with `redirect: 'manual'`. External and `mailto:` URIs are returned in `externalUris[]` and NEVER dereferenced (SSRF/credential-leak guard). `sessionid` and `fid` parameters are redacted in logs and error messages.

**Limits (configurable via env vars):** `BC_MAX_DOWNLOAD_BYTES` (per-file, default 5 MB), `BC_MAX_DOWNLOAD_TOTAL_BYTES` (aggregate, default 10 MB), `BC_MAX_DOWNLOADS` (count, default 5). `BC_DOWNLOAD_DIR` (falls back to `BC_REPORT_DIR` if unset) writes bytes to disk and sets `savedPath`, IN ADDITION to returning `bytes` inline. An oversized or failed fetch is a per-entry `error` object, never a whole-operation failure.

**UriToShowStyle ordinals** (from decompiled `UriToShowStyle.cs`): `View=0, Download=1, Print=2, Preview=3, PreviewWithoutDownload=4, Mailto=5`.

**CRITICAL protocol finding (verified live 2026-07-24):** The `DynamicFileHandler.axd` download URL is bound to the EXACT authenticated server session that generated it — fetching it from a different session (e.g. a fresh NTLM re-login for the same user) returns HTTP 404. The download MUST be fetched using the same session's auth headers and cookies. This is why the integration session pool now returns the leased session's auth provider to callers.

**Live-verified example:** "Open in Excel" on Customer List (page 22) uses `SystemAction 165` (SendToExcelServer) and emits a `UriToShow` with style `Download=1` containing xlsx bytes fetched from `DynamicFileHandler.axd`.

Reference: `ResponseManager.RegisterUriToShowEvents` (`Microsoft.Dynamics.Framework.UI.Web/`), `FileUrlAddressProvider.cs` (`Microsoft.Dynamics.Framework.UI.Web/`), `UriToShowStyle.cs` (decompiled).

### Async Message Timing
The invoke quiescence window (150ms) is a best-effort wait for trailing async `Message` notifications. In rare cases, late-arriving messages may be missed. Long operations do NOT rely on BC volunteering frames (`CallbackHandler` awaits the whole interaction before responding, so a long AL phase is silent) -- liveness comes from polling `IsExecuting`, see Session Recovery. An earlier claim that IsExecuting is unavailable on `/csh` came from grepping the wrong assembly (`ClientService` serves `/ws/connect`, not `/csh`) and is retracted.

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

- When dispatching parallel worktree agents, group by file overlap (not by feature). Files like `types.ts`, `schemas.ts`, `page-context-repo.ts`, `page-context-store.ts`, and `form-state-reducer.ts` are touched by many features -- put them in one agent to avoid merge conflicts.
- If stuck on a protocol issue, use the decompiled BC source (`bc-decompiled-analyzer` agent)
- Read files before writing them
- Check all protocol assumptions against decompiled source, not v1
