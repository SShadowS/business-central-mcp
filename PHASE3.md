# Phase 3: Extended Capabilities & Remaining Gaps

## Status: PENDING

**Goal**: Complete the remaining deferred items from Phase 2 and add advanced document page workflows.

**Branch**: TBD (create from `feat/multi-section` or `main` after merge)

---

## Investigation Summary (2026-04-03)

All items verified against decompiled BC28 source at `U:/git/bc-mcp/reference/bc28/decompiled/`.

| Item | Verdict | Notes |
|---|---|---|
| 1.1 FactBox data | BLOCKED | No trigger protocol found in decompiled source |
| 1.2 Field metadata | READY (~1h) | `ShowMandatory`, `AssistEditAction` confirmed in control tree JSON and decompiled `ClientEditLogicalControl.cs` |
| 2.1 Tab groups | READY (~3d) | `gc` nodes with captions already parsed but flattened; no protocol changes needed |
| 2.2 Paging MVP | READY (~1d) | `totalRowCount` tracked; slice already-loaded rows |
| 2.2 Paging full | UNCLEAR | `RepeaterViewportControl.cs` has Offset/PageSize but client trigger unknown |
| 3.1 Post Sales Order | READY TO TEST | Multi-step flow already implemented; `InvokeActionInteraction.cs` confirms standard invoke chain |
| 3.2 Copy Document | NEEDS WORK (~4-6h) | Dialog controlTree stored raw, not parsed into fields |
| 3.3 Approval workflows | READY TO TEST | Standard action visibility; no special protocol |
| 4.1 Stale section recovery | NEEDS IMPL (~4-6h) | No staleness detection exists |
| 4.2 Validation error tests | NEEDS TESTS (~6-8h) | Error structures exist, no integration tests |
| 4.3 Cascading refresh tests | NEEDS TESTS (~2h) | `detectChangedSections()` already cascades; unit-tested |
| 4.4 Close with unsaved | NEEDS TESTS (~2h) | `close-page.ts` detects dialog; untested against real BC |
| 4.5 Session recovery | PARTIAL (~8-12h) | `markDead()` exists, auto-recreation not wired |
| 5.1 Selective loading | MOSTLY DONE (~1h) | Factboxes skipped, lines auto-loaded; needs config |
| 5.2 Column selection | COMPLETE | Already implemented in `ReadDataSchema` + `read-data.ts` |
| 5.3 Batch SaveValue | NOT FEASIBLE | BC protocol requires serialized invokes; no `BatchSaveValue` in decompiled source |
| 5.4 Tool descriptions | NEEDS POLISH (~2-3h) | Missing `input_examples` and inter-tool docs |

---

## Tier 1: FactBox Data & Field Metadata

### 1.1 FactBox data population
- [ ] Investigate BC protocol for factbox data loading (decompiled source)
- [ ] Identify what interaction triggers PropertyChanged events with factbox field values
- [ ] Implement lazy loading when `bc_read_data(section: "factbox:...")` is called
- [ ] Test against real BC
- [ ] Verified: `bc_read_data(section: "factbox:Customer Details")` returns field values

**Background**: FactBox sections are discovered and have field metadata (names, types), but values are empty. BC populates factbox data lazily in the browser -- the server-side protocol for triggering this is unknown.

**Decompiled investigation needed**: Check `FactBoxAreaControl`, `FormHostControl` observer patterns, and whether a specific interaction (e.g., row selection on the parent page) triggers factbox data refresh.

**Investigation findings (2026-04-03)**:
- `FactBoxAreaControl.cs` not found in decompiled source (no dedicated factbox control class)
- `FormHostControl.cs` is generic -- handles all child forms, not factbox-specific
- `UIPartPageTypeHandler.cs` has `IsFactBox()` method -- factboxes are regular forms marked with `IsPart: true`
- Current code explicitly skips factbox loading: `if (section.kind === 'factbox') continue;` in `page-service.ts:105`
- **BLOCKER**: No evidence in decompiled source of what interaction triggers factbox data refresh. Likely needs live BC traffic capture (browser DevTools on WebSocket) to observe what the BC web client sends when a row is selected.

### 1.2 Field metadata per section
- [ ] Design: decide which metadata to expose (editable, visible, isLookup, ShowMandatory)
- [ ] Implement: extract isLookup from control tree (fields with AssistEdit/Lookup system actions)
- [ ] Implement: extract ShowMandatory from control tree ExpressionProperties
- [ ] Test: unit tests for metadata extraction
- [ ] Test: integration test reading field metadata on Sales Order

**What exists today**: `getFields()` returns `ControlField[]` with `editable`, `visible`, `type`, `caption`. Missing: `isLookup`, `showMandatory`.

**Investigation findings (2026-04-03)**:
- `ShowMandatory` already present in control tree JSON (confirmed in `page21-control-tree.json`: Name field has `"ShowMandatory": true`)
- `AssistEditAction` already present in control tree JSON (No. field has `"SystemAction": 100`)
- Decompiled `ClientEditLogicalControl.cs:60` confirms `ShowMandatory { get; set; }`
- Decompiled `EditLogicalControl.cs:278` confirms `HasAssistEdit => AssistEditAction != null`
- Implementation: extend `ControlField` interface (+2 fields), extend `extractField()` (~15 lines)
- **READY**: ~1 hour implementation

### APPROVAL GATE 1: FactBox & metadata verified
- [ ] `bc_read_data(section: "factbox:Customer Details")` returns Customer No., Name, Credit Limit with values
- [ ] `bc_read_data(section: "factbox:Sales Line Details")` returns line-specific factbox data
- [x] Field metadata includes isLookup for lookup fields (No., Customer No., etc.) -- **READY, data confirmed in control tree**
- [x] Field metadata includes showMandatory where BC provides it -- **READY, data confirmed in control tree**

---

## Tier 2: Tab Groups & Paging

### 2.1 Tab groups within header
- [ ] Design: how to represent tabs (group by container gc nodes with captions)
- [ ] Implement: parseControlTree preserves top-level gc group structure
- [ ] Implement: `bc_read_data` returns fields grouped by tab
- [ ] Implement: optional `tab` parameter on bc_read_data
- [ ] Test: unit test for tab group parsing
- [ ] Test: integration test reading "Invoice Details" tab fields on Sales Order

**Background**: Sales Order header has tabs: General, Invoice Details, Shipping and Billing, Foreign Trade, Prepayment. Currently all fields are returned flat. The LLM asking "show me the shipping details" needs tab-scoped reads.

**Implementation hint**: Root form Children include `gc` (GroupControl) nodes with captions matching tab names. Fields inside each gc belong to that tab. Index 1 = "General", 3 = "Invoice Details", etc.

**Investigation findings (2026-04-03)**:
- `gc` nodes are already parsed by `parseControlTree()` via generic recursion but captions are discarded
- Test data confirms tab structure: Children[1-5] are gc nodes with captions "General" (28 fields), "Invoice Details" (18), "Shipping and Billing" (10), "Foreign Trade" (7), "Prepayment" (6)
- Control paths preserve hierarchy (e.g., `server:c[3]/c[0]` = General tab, first field)
- No protocol changes needed -- purely a parser/service layer change
- Need: `TabGroup` interface, tab detection in parser, `tab` param on `ReadDataSchema`, filtering in `DataService`
- **READY**: ~3 days implementation

### 2.2 Paging for large documents
- [ ] Design: viewport vs full-data semantics
- [ ] Investigate: does BC send full data or viewport for document subpage repeaters?
- [ ] Implement: `bc_read_data(section: "lines", range: {offset, limit})`
- [ ] Implement: scroll/viewport protocol (if BC uses viewport-based loading)
- [ ] Test: integration test with 50+ line document
- [ ] Test: verify totalRowCount from PropertyChanged matches actual count

**Background**: Most Sales Orders have few lines, but Purchase Orders and Journals can have 100+. Currently all loaded rows are returned at once. `RepeaterState.totalRowCount` is tracked from PropertyChanged events.

**Investigation findings (2026-04-03)**:
- `RepeaterState` already tracks `totalRowCount` from PropertyChanged events (`form-state.ts:84-92`)
- Decompiled `RepeaterViewportControl.cs` confirms BC has Offset/PageSize/ViewportPagingMode (ContinuousScrolling, AlwaysOnPageBoundary, etc.)
- **MVP feasible now**: add `range: {offset, limit}` param, slice `repeater.rows` in `DataService.readRows()`. ~1 day.
- **Full paging unclear**: decompiled source shows Offset is `internal set` -- no client interaction found for requesting additional rows beyond initial viewport. Likely needs SetCurrentRow to a row outside viewport, but unconfirmed.
- Recommended: ship MVP (slice loaded rows), defer full viewport loading to later investigation

### APPROVAL GATE 2: Tabs & paging verified
- [ ] `bc_read_data(tab: "Shipping and Billing")` returns only shipping/billing fields
- [ ] `bc_read_data(section: "lines", range: {offset: 0, limit: 20})` returns first 20 lines
- [ ] `bc_read_data(section: "lines", range: {offset: 20, limit: 20})` returns next 20 lines
- [ ] totalRowCount is accurate for documents with 50+ lines

---

## Tier 3: Advanced Workflows

### 3.1 Post Sales Order end-to-end
- [ ] ~~Investigate: what actions/dialogs appear during posting~~ -- infrastructure exists
- [ ] Test: post a Sales Order, verify Posted Sales Invoice is created
- [ ] Test: handle posting errors (nothing to post, validation failures)

**Expected flow**:
1. `bc_execute_action(action: "Post")` -> opens confirmation dialog ("Do you want to post?")
2. `bc_respond_dialog(response: "yes")` -> may open more dialogs or show result
3. Check for new page opened (Posted Sales Invoice)

**Investigation findings (2026-04-03)**:
- Multi-step flow **already implemented**: `respond-dialog.ts:84-93` detects FormCreated events after dialog response and returns `openedPages` array
- Decompiled `InvokeActionInteraction.cs` confirms standard invoke chain (no special posting handler)
- `detectDialogs()` in `mutation-result.ts` extracts dialog formId and message from events
- **READY TO TEST**: zero additional code needed, just integration tests

### 3.2 Copy Document workflow
- [ ] Investigate: how Copy Document request page differs from regular dialogs
- [ ] Implement: parse dialog controlTree into ControlField[] for field discovery
- [ ] Implement: handle request page fields (Document Type, Document No.)
- [ ] Test: copy a Sales Order, verify new order is created

**Expected flow**:
1. `bc_execute_action(action: "Copy Document")` -> opens request page dialog
2. Read dialog fields, write Document Type and Document No.
3. `bc_respond_dialog(response: "ok")` -> copies the document

**Investigation findings (2026-04-03)**:
- Dialog opening and response handling work (tested with confirmation dialogs)
- **Gap**: dialog controlTree is stored raw (not parsed into `ControlField[]`), so LLM cannot discover dialog fields programmatically
- Need: parse dialog controlTree using `control-tree-parser`, expose fields in action result or new `bc_read_dialog` mechanism
- Alternative: LLM works blind with known field order (fragile)
- **NEEDS WORK**: ~4-6 hours for dialog form parsing + field exposure

### 3.3 Approval workflows
- [ ] ~~Investigate: approval action visibility/enabling patterns~~ -- standard action model
- [ ] Test: check approval status changes on a Sales Order
- [ ] Document: how approval actions surface in the MCP tool response

**Investigation findings (2026-04-03)**:
- Approval actions are regular BC actions with visibility/enabled state tracked in `ActionInfo`
- `bc_execute_action(action: "Approve")` handled by existing code
- Status changes reflected in `changedSections` detection
- **READY TO TEST**: no special implementation needed

### APPROVAL GATE 3: Advanced workflows verified
- [ ] Post a Sales Order -> Posted Sales Invoice created
- [ ] Copy Document -> new Sales Order created from existing
- [ ] Approval actions visible and executable when applicable

---

## Tier 4: Robustness Gaps

### 4.1 Stale section recovery
- [ ] Design: detect when a child form is closed or becomes invalid
- [ ] Implement: return actionable error on stale section access
- [ ] Implement: auto-refresh sections when staleness detected
- [ ] Test: simulate stale section, verify error + recovery guidance

**Investigation findings (2026-04-03)**:
- `resolveSection()` in `section-resolver.ts` returns helpful errors with `availableSections` list
- No staleness detection exists -- `SectionDescriptor` has no `valid` flag
- No FormClosed event handling to mark sections invalid
- **NEEDS IMPL**: add `valid` flag, detect FormClosed events, auto-refresh on stale access. ~4-6 hours.

### 4.2 Validation error integration tests
- [ ] Test: write invalid item number on a line -> validation error dialog surfaces
- [ ] Test: write to a read-only field -> error message with field status
- [ ] Test: write to non-existent field -> instructional error with suggestions

**Investigation findings (2026-04-03)**:
- `FieldWriteResult` includes success/error fields; non-existent field errors already include `availableFields` suggestions
- BC validation errors arrive as DialogOpened events -- `detectDialogs()` extracts Caption/Message
- **NEEDS TESTS**: error structures exist, just need integration test coverage. ~6-8 hours.

### 4.3 Cascading refresh integration tests
- [ ] Test: change Sell-to Customer No. -> changedSections includes "lines"
- [ ] Test: change Currency Code -> changedSections includes all sections
- [ ] Verify: LLM re-reads affected sections after cascading change

**Investigation findings (2026-04-03)**:
- `detectChangedSections()` in `mutation-result.ts:24-51` **already implements cascade logic** -- returns all sections when root formId appears in events
- Unit test passes: "includes all sections when root formId is in events (cascade)"
- `changedSections` returned by all mutation operations
- **NEEDS TESTS ONLY**: feature complete, just needs integration test against real BC. ~2 hours.

### 4.4 Close page with unsaved changes
- [ ] Test: modify a field, close page -> "save changes?" dialog appears
- [ ] Test: respond "yes" -> changes saved
- [ ] Test: respond "no" -> changes discarded

**Investigation findings (2026-04-03)**:
- `close-page.ts` invokes CloseForm on all owned forms and detects dialogs that appear
- `bc_respond_dialog` supports 'yes'/'no' responses
- **NEEDS TESTS ONLY**: feature complete, just needs integration test. ~2 hours.

### 4.5 Session recovery after protocol errors
- [ ] Implement: detect dead sessions (InvalidSessionException)
- [ ] Implement: auto-recreate session on next tool call
- [ ] Test: kill session, verify next call reconnects

**Investigation findings (2026-04-03)**:
- Dead session detection exists: `bc-session.ts:155-160` detects `InvalidSessionException` and JSON-RPC error code 1, calls `markDead()`
- `session.isAlive` property returns `!this.dead && this.ws.isConnected`
- **Gap**: no auto-recreation -- SessionFactory not threaded through to operation handlers
- Needs: middleware in MCP handler to detect dead session, recreate, and retry
- **PARTIAL**: ~8-12 hours for full auto-recreation + retry

### APPROVAL GATE 4: All robustness gaps closed
- [ ] Invalid item number shows validation error with field name
- [ ] Header change cascades to lines in changedSections
- [ ] Close with unsaved changes shows dialog
- [ ] Session recovery works after protocol error
- [ ] Stale section access returns recovery guidance

---

## Tier 5: Performance & Polish

### 5.1 Selective section loading on page open
- [ ] Design: which sections to auto-load vs lazy-load
- [ ] Implement: configuration for auto-load sections (default: header + lines)
- [ ] Test: page open time with all factboxes vs header+lines only

**Investigation findings (2026-04-03)**:
- `PageService.openPage()` already implements selective loading: auto-loads lines, skips factboxes
- Hard-coded: `if (section.kind === 'factbox') continue;` in `page-service.ts:105`
- **MOSTLY DONE**: just needs config option for `autoLoadSections`. ~1 hour.

### 5.2 Column selection for line reads
- [x] ~~Implement: `bc_read_data(section: "lines", columns: ["No.", "Quantity", "Unit Price"])`~~ -- **COMPLETE**
- [x] ~~Test: verify only requested columns are returned~~ -- **COMPLETE**

**Investigation findings (2026-04-03)**:
- Already implemented in `read-data.ts:37-46` with case-insensitive column matching
- Schema includes `columns?: string[]` in `ReadDataSchema`
- Tool description documents the feature

### ~~5.3 Batch operations optimization~~
- [x] ~~Investigate: can multiple SaveValue calls be batched in one invoke?~~ -- **NOT FEASIBLE**

**Investigation findings (2026-04-03)**:
- No `BatchSaveValue` interaction type exists in decompiled BC28 source
- `SaveValueInteraction.cs` handles one field per interaction
- BC's stateful sequence protocol requires serialized invokes -- concurrent sends corrupt state
- Each field write triggers validation cascades (e.g., changing Customer recalculates lines)
- **SKIP**: BC protocol architectural limitation, not solvable client-side

### 5.4 Tool description improvements
- [ ] Review all 8 tool descriptions with Anthropic best practices
- [ ] Add input_examples for complex tools
- [ ] Test: verify LLM can discover and use tools correctly

**Investigation findings (2026-04-03)**:
- Current descriptions are 200+ words each, meet minimum 3-4 sentence requirement
- Missing: `input_examples` for WriteData, ExecuteAction, Navigate
- Missing: explicit inter-tool relationship docs (pageContextId flow)
- Missing: "when NOT to use" guidance on some tools
- **NEEDS POLISH**: ~2-3 hours editorial work

### APPROVAL GATE 5: Performance acceptable
- [ ] Sales Order page 42 opens in < 2 seconds
- [ ] Line data read returns in < 500ms
- [ ] Multi-field write completes in < 1 second per field

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-03 | FactBox data loading deferred | BC loads lazily; protocol investigation needed |
| 2026-04-03 | Tab groups deferred | Flat field list works; tab parsing needs hierarchy preservation |
| 2026-04-03 | Paging deferred | Most documents have < 50 lines; totalRowCount tracking is in place |
| 2026-04-03 | Posting workflow deferred | Needs multi-step dialog handling investigation |
| 2026-04-03 | Batch SaveValue ruled out | No BatchSaveValue in decompiled BC28; protocol requires serialized invokes |
| 2026-04-03 | Column selection already complete | Implemented in read-data.ts during Phase 2 |
| 2026-04-03 | Post/Approve workflows ready to test | Multi-step dialog flow already implemented in respond-dialog.ts |
| 2026-04-03 | Cascading refresh / close-page ready to test | Features implemented, only integration tests missing |
| 2026-04-03 | Full paging protocol unclear | RepeaterViewportControl.cs has Offset/PageSize but client trigger not found in decompiled source |
