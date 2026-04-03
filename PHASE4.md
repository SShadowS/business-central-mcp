# Phase 4: Remaining Gaps & Final Polish

## Status: MOSTLY COMPLETE

**Goal**: Complete the remaining deferred items from Phase 3 -- FactBox data, full paging, destructive workflow tests, and performance measurement.

**Branch**: `feat/multi-section`

---

## Investigation Summary (2026-04-03)

Protocol investigation performed via:
1. Decompiled BC28 source at `U:/git/bc-mcp/reference/bc28/decompiled/`
2. Live WebSocket capture via Playwright MCP against real BC27

| Finding | Source | Detail |
|---|---|---|
| FactBox trigger | WebLogicalFormObserver.cs + Playwright | `SetCurrentRow` on parent repeater triggers server-side Query property change on factbox forms; no separate client call needed |
| FactBox data routing | Decompiled + live testing | PropertyChanged events arrive on ROOT formId, not factbox formId; need cross-form routing by controlPath |
| ScrollRepeater | ScrollRepeaterInteraction.cs + Playwright | `ScrollRepeater` interaction with `delta` parameter (positive=forward, negative=backward) |
| LoadForm.OpenForm | LoadFormInteraction.cs | `openForm` param resets form state; needed to re-load factbox data after initial load |
| PendingUpdates | LogicalFormSerializer.cs | Counter of pending inbound messages, not a list of formIds |

---

## Tier 1: FactBox Data Population

### 1.1 Discover FactBox data loading protocol
- [x] Captured live BC WebSocket traffic via Playwright when selecting rows
- [x] Identified: `SetCurrentRowAndRowsSelection` triggers server-side factbox Query change
- [x] Documented: data arrives as PropertyChanged on ROOT formId, not factbox formId

### 1.2 Implement FactBox data loading
- [x] Added `factbox` to `DEFAULT_AUTO_LOAD_SECTIONS` in page-service.ts
- [x] Added `openForm` parameter to `LoadFormInteraction` (decompiled LoadFormInteraction.cs)
- [x] `triggerFactboxRefresh()`: sends SetCurrentRow on parent repeater + LoadForm(openForm+loadData) for each factbox
- [x] `findFactboxFormByFieldPath()`: routes PropertyChanged events from root formId to matching factbox form by controlPath

### 1.3 Integration tests
- [x] Customer List (page 22): `factbox:Customer Statistics` returns 14 fields, 11 with values
- [x] Customer List (page 22): `factbox:Dynamics 365 Sales Statistics` returns 3 fields, 3 with values
- [ ] Sales Order (page 42): factbox values empty -- card/document pages have no root repeater for SetCurrentRow

**Known limitation**: FactBox data only populates on list pages (where a root repeater with rows exists). Document/card pages opened by bookmark don't have a root repeater to trigger factbox refresh. This needs further investigation -- possibly sending SetCurrentRow on the lines subpage repeater, or using a different mechanism for document-type pages.

### APPROVAL GATE 1: FactBox data working
- [x] `bc_read_data(section: "factbox:Customer Statistics")` returns Balance, Outstanding Orders, etc. with values -- **VERIFIED on page 22**
- [ ] `bc_read_data(section: "factbox:Customer Details")` on Sales Order -- **BLOCKED** (document page, no root repeater)
- [x] Changing selected row updates factbox data (verified via SetCurrentRow protocol)

---

## Tier 2: Full Paging (Viewport Scrolling)

### 2.1 Discover viewport scroll protocol
- [x] Captured live WebSocket traffic when scrolling long list
- [x] Identified: `ScrollRepeater` interaction with `delta` parameter
- [x] Decompiled: `ContinuousScrollingStrategy` calls `FillNextBlock(delta)` / `FillPreviousBlock`

### 2.2 Implement viewport row loading
- [x] Added `ScrollRepeaterInteraction` type in types.ts
- [x] Added `ScrollRepeater` encoder in interaction-encoder.ts
- [x] Added `scrollRepeater()` method in data-service.ts
- [x] ReadDataOperation auto-scrolls when range requests rows beyond loaded viewport

### 2.3 Integration tests
- [x] ScrollRepeater sends correctly and returns events
- [ ] Test with 50+ line document -- **DEFERRED** (CRONUS Customer List only has 5 rows; need larger dataset)

### APPROVAL GATE 2: Full paging working
- [x] `ScrollRepeater` interaction sends and receives correctly
- [x] Auto-scroll in ReadDataOperation triggers when range exceeds loaded rows
- [ ] Document with 50+ lines verified -- **DEFERRED**

---

## Tier 3: Destructive Workflow Tests
- [ ] Post Sales Order -- **DEFERRED** (would modify CRONUS data)
- [ ] Copy Document -- **DEFERRED** (would modify CRONUS data)

---

## Tier 4: Performance Measurement

### 4.1 Timing
- [x] Sales Order page 42 opens in 2126ms (with factbox loading) -- within 5s limit
- [x] Lines read returns in <1ms (cached from page open) -- within 500ms limit
- [x] Integration test verifies timing constraints

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-03 | FactBox data routes through root formId | Verified from decompiled WebLogicalFormObserver.cs + live capture; controlPath-based cross-form routing implemented |
| 2026-04-03 | ScrollRepeater uses delta parameter | Verified from decompiled ScrollRepeaterInteraction.cs + live Playwright capture |
| 2026-04-03 | Card page factbox deferred | No root repeater on document/card pages; needs different trigger mechanism |
| 2026-04-03 | Large dataset paging deferred | CRONUS has only 5 customers; functional correctness verified with available data |
| 2026-04-03 | Destructive tests deferred | Would modify CRONUS demo data |
