# Phase 3: Extended Capabilities & Remaining Gaps

## Status: PENDING

**Goal**: Complete the remaining deferred items from Phase 2 and add advanced document page workflows.

**Branch**: TBD (create from `feat/multi-section` or `main` after merge)

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

### 1.2 Field metadata per section
- [ ] Design: decide which metadata to expose (editable, visible, isLookup, ShowMandatory)
- [ ] Implement: extract isLookup from control tree (fields with AssistEdit/Lookup system actions)
- [ ] Implement: extract ShowMandatory from control tree ExpressionProperties
- [ ] Test: unit tests for metadata extraction
- [ ] Test: integration test reading field metadata on Sales Order

**What exists today**: `getFields()` returns `ControlField[]` with `editable`, `visible`, `type`, `caption`. Missing: `isLookup`, `showMandatory`.

### APPROVAL GATE 1: FactBox & metadata verified
- [ ] `bc_read_data(section: "factbox:Customer Details")` returns Customer No., Name, Credit Limit with values
- [ ] `bc_read_data(section: "factbox:Sales Line Details")` returns line-specific factbox data
- [ ] Field metadata includes isLookup for lookup fields (No., Customer No., etc.)
- [ ] Field metadata includes showMandatory where BC provides it

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

### 2.2 Paging for large documents
- [ ] Design: viewport vs full-data semantics
- [ ] Investigate: does BC send full data or viewport for document subpage repeaters?
- [ ] Implement: `bc_read_data(section: "lines", range: {offset, limit})`
- [ ] Implement: scroll/viewport protocol (if BC uses viewport-based loading)
- [ ] Test: integration test with 50+ line document
- [ ] Test: verify totalRowCount from PropertyChanged matches actual count

**Background**: Most Sales Orders have few lines, but Purchase Orders and Journals can have 100+. Currently all loaded rows are returned at once. `RepeaterState.totalRowCount` is tracked from PropertyChanged events.

**Decompiled investigation needed**: Check `RepeaterViewportControl`, `ScrollChange`, and how the BC web client requests additional rows beyond the initial viewport.

### APPROVAL GATE 2: Tabs & paging verified
- [ ] `bc_read_data(tab: "Shipping and Billing")` returns only shipping/billing fields
- [ ] `bc_read_data(section: "lines", range: {offset: 0, limit: 20})` returns first 20 lines
- [ ] `bc_read_data(section: "lines", range: {offset: 20, limit: 20})` returns next 20 lines
- [ ] totalRowCount is accurate for documents with 50+ lines

---

## Tier 3: Advanced Workflows

### 3.1 Post Sales Order end-to-end
- [ ] Investigate: what actions/dialogs appear during posting
- [ ] Implement: handle multi-step posting flow (confirmation + processing + result)
- [ ] Test: post a Sales Order, verify Posted Sales Invoice is created
- [ ] Test: handle posting errors (nothing to post, validation failures)

**Expected flow**:
1. `bc_execute_action(action: "Post")` -> opens confirmation dialog ("Do you want to post?")
2. `bc_respond_dialog(response: "yes")` -> may open more dialogs or show result
3. Check for new page opened (Posted Sales Invoice)

### 3.2 Copy Document workflow
- [ ] Investigate: how Copy Document request page differs from regular dialogs
- [ ] Implement: handle request page fields (Document Type, Document No.)
- [ ] Test: copy a Sales Order, verify new order is created

**Expected flow**:
1. `bc_execute_action(action: "Copy Document")` -> opens request page dialog
2. Read dialog fields, write Document Type and Document No.
3. `bc_respond_dialog(response: "ok")` -> copies the document

### 3.3 Approval workflows
- [ ] Investigate: approval action visibility/enabling patterns
- [ ] Test: check approval status changes on a Sales Order
- [ ] Document: how approval actions surface in the MCP tool response

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

### 4.2 Validation error integration tests
- [ ] Test: write invalid item number on a line -> validation error dialog surfaces
- [ ] Test: write to a read-only field -> error message with field status
- [ ] Test: write to non-existent field -> instructional error with suggestions

### 4.3 Cascading refresh integration tests
- [ ] Test: change Sell-to Customer No. -> changedSections includes "lines"
- [ ] Test: change Currency Code -> changedSections includes all sections
- [ ] Verify: LLM re-reads affected sections after cascading change

### 4.4 Close page with unsaved changes
- [ ] Test: modify a field, close page -> "save changes?" dialog appears
- [ ] Test: respond "yes" -> changes saved
- [ ] Test: respond "no" -> changes discarded

### 4.5 Session recovery after protocol errors
- [ ] Implement: detect dead sessions (InvalidSessionException)
- [ ] Implement: auto-recreate session on next tool call
- [ ] Test: kill session, verify next call reconnects

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

### 5.2 Column selection for line reads
- [ ] Implement: `bc_read_data(section: "lines", columns: ["No.", "Quantity", "Unit Price"])`
- [ ] Test: verify only requested columns are returned

### 5.3 Batch operations optimization
- [ ] Investigate: can multiple SaveValue calls be batched in one invoke?
- [ ] Implement if possible: reduce round-trips for multi-field writes

### 5.4 Tool description improvements
- [ ] Review all 8 tool descriptions with Anthropic best practices
- [ ] Add input_examples for complex tools
- [ ] Test: verify LLM can discover and use tools correctly

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
