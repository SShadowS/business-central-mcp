# Phase 2: Multi-Section Document Page Architecture

## Status: COMPLETE (core items) -- deferred items moved to [PHASE3.md](PHASE3.md)

**Goal**: Enable full LLM interaction with BC document pages (Sales Order, Purchase Order, etc.) that have multiple repeaters, subpages, and section-scoped actions.

**Guiding principle**: Best solution, not fastest. Break freely. No stubs.

**Branch**: `feat/multi-section` (23 commits, 0 type errors, 73 unit tests, 11 integration tests, 8 MCP tools)

---

## Tier 1: Foundation -- COMPLETE

### APPROVAL GATE 1: Foundation design approved
- [x] Design spec written and reviewed
- [x] Implementation plan approved

### 1.1 Per-form state tracking [CRITICAL]
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

Internal state is `Map<formId, FormState>`. Each FormState owns controlTree, repeaters (Map), actions, filterControlPath. `FormProjection` handles per-form events. `StateProjection` deleted.

### 1.2 Section abstraction layer
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

Flat `Map<sectionId, SectionDescriptor>` derived from per-form state. IDs: `header`, `lines`, `factbox:{caption}`, `subpage:{caption}`. `SectionResolver` derives sections, `resolveSection()` helper used by all services.

### 1.3 Section discovery
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

**Key protocol discovery**: BC does NOT send separate `FormCreated` events for subpages. Instead, child forms are embedded in the root form's control tree as `fhc` (FormHostControl) nodes containing `lf` (LogicalForm) children with `ServerId`, `IsSubForm`, `IsPart` properties.

Discovery strategy:
- Parse root form control tree for `fhc` -> `lf` nodes
- `lf.IsSubForm=true` + has repeater -> `lines` section
- `lf.IsPart=true` only -> `factbox:{caption}` section
- Collision handling via ordinal suffix (`lines#2`)

### 1.4 Current row per repeater
- [x] Design
- [x] Implement
- [x] Test

`RepeaterState.currentBookmark` tracks per-repeater. `BookmarkChanged` events routed by controlPath.

### 1.5 RepeaterColumn binder name mapping
- [x] Design
- [x] Implement
- [x] Test

`columnBinderName` extracted from `ColumnBinder.Name` on each repeater column. Maps `row.cells` keys to captions. Verified: Sales Order lines have 38 columns with binder names.

### APPROVAL GATE 2: Foundation verified against BC27 + BC28
- [x] Open Sales Order page 42 -- 12 sections (header + lines + 10 factboxes)
- [x] Child form events are captured and routed correctly
- [x] Section discovery identifies header vs lines vs factboxes
- [x] Column binder mapping produces readable line data
- [x] All existing tests still pass (73 unit + 11 integration)
- Note: Purchase Order page 50 not yet tested -- moved to [PHASE3](PHASE3.md) Tier 4.2

---

## Tier 2: Core Tool Changes -- COMPLETE

### APPROVAL GATE 3: Tool interface design approved
- [x] bc_read_data schema reviewed (added `section` param)
- [x] bc_write_data schema reviewed (added `section`, `rowIndex`, `bookmark`)
- [x] bc_execute_action schema reviewed (added `section`, `rowIndex`, `bookmark`)
- [x] bc_navigate schema reviewed (added `section`, `field`, `lookup` action)

### 2.1 Unified bc_read_data with sections
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

`bc_read_data(section: "lines")` returns line items. `bc_open_page` returns sections list. Default section is `header`.

### 2.2 Section-targeted bc_write_data
- [x] Design
- [x] Implement
- [x] Verified against real BC (Line Discount % write on Sales Order, BC27 + BC28)

`bc_write_data(section: "lines", rowIndex: 0, fields: {...})` implemented. SelectRow(childFormId) + SaveValue on `{repeater}/cr/c[N]`.

### 2.3 Line cell write protocol
- [x] Verify controlPath format (decompiled + real BC: `{repeater}/cr/c[N]`, NOT `cr/co[N]`)
- [x] Implement: SelectRow(childFormId) + SaveValue
- [x] Verified against real BC (Line Discount % round-trip)
- [x] Document verified wire format

### 2.4 Section-scoped bc_execute_action
- [x] Design
- [x] Implement
- [x] Verified against real BC (New + Delete on lines section)

Action resolution: well-known names (New, Delete, Refresh, Edit, View) mapped to SystemAction codes. Section's form searched first, then root form for line-scoped actions.

### 2.5 Navigation from line cells
- [x] Design
- [x] Implement
- [x] Verified against real BC (DrillDown on No. field opens dialog)

DrillDown (SystemAction 120) on line cell opens dialog (Item Card as modal). Closed via `bc_respond_dialog(close)`.

### 2.6 Bookmark-based row targeting
- [x] Design
- [x] Implement
- [x] Test

All row-targeting operations accept `bookmark` (preferred) or `rowIndex` (convenience). Reads include bookmark per row.

### APPROVAL GATE 4: Core tools verified end-to-end
- [x] Header write works (External Document No. on Sales Order)
- [x] Line write by index works (Line Discount % = 5, restore to 0)
- [x] Section-scoped action works (New + Delete on lines section)
- [x] DrillDown from line cell works (No. field opens Item Card dialog)
- [x] Lookup from line cell works (Location Code -- PropertyChanged, no form for empty field)
- [x] Cross-version: line read + line write verified on BC27 AND BC28

---

## Tier 3: Robustness & Error Handling -- COMPLETE

### 3.1 Unified invoke result envelope
- [x] Design
- [x] Implement
- [x] Test (7 unit tests)

All mutating operations return: `changedSections[]`, `dialogsOpened[]`, `requiresDialogResponse`. Implemented via `detectChangedSections()` and `detectDialogs()` in `src/protocol/mutation-result.ts`.

### 3.2 Validation error surfacing on writes
- [x] Implement
- [x] Test

`DataService.writeField/writeFields` now return raw events. `WriteDataOperation` uses `detectDialogs()` to surface any validation dialogs BC opened during the write.

### 3.3 Instructional error messages
- [x] Implement
- [x] Test

Cross-section suggestions for both fields (DataService) and actions (ActionService). "Action 'X' not found in section 'header'. It exists in section 'lines'."

### 3.4 Cascading refresh semantics
- [x] Design (Pattern A)
- [x] Implement
- [x] Test

`detectChangedSections()` maps event formIds to sectionIds. Root form events cascade to all sections. LLM checks `changedSections` and re-reads as needed.

### 3.5 Close page dialog handling
- [x] Implement
- [x] Test

`PageService.closePage` returns collected events. `ClosePageOperation` runs `detectDialogs()` on them and surfaces in the result.

### 3.6 Stale section recovery
- Deferred to [PHASE3](PHASE3.md) Tier 4.1. Current `resolveSection()` already returns errors when a section's form is missing.

### APPROVAL GATE 5: Robustness verified
- [x] All tools return consistent result envelope (changedSections, dialogsOpened, requiresDialogResponse)
- [x] Wrong-section field write returns instructional error
- [x] Wrong-section action returns instructional error with suggestion
- Remaining integration tests moved to [PHASE3](PHASE3.md) Tier 4.2-4.4

---

## Tier 4: Extended Capabilities -- CORE ITEMS COMPLETE

### 4.1 Dialog response tool
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

New tool: `bc_respond_dialog(pageContextId, dialogFormId, response)`. Supports ok, cancel, yes, no, abort, close. Wired through server.ts, stdio-server.ts. Tested: close drill-down dialog.

### 4.2 FactBoxes as readable sections
- [x] Design (sections are created, kind=factbox)
- [x] Implement (sections discovered, 10 factboxes on Sales Order, field metadata available)
- Data values deferred to [PHASE3](PHASE3.md) Tier 1.1 (BC lazy loading)

### 4.3-4.5 Deferred to [PHASE3](PHASE3.md)
- 4.3 Field metadata (isLookup, ShowMandatory) -> PHASE3 Tier 1.2
- 4.4 Tab groups -> PHASE3 Tier 2.1
- 4.5 Paging -> PHASE3 Tier 2.2

### 4.6 Adding new lines (composable)
- [x] Design
- [x] Implement
- [x] Test
- [x] Verified against real BC

`bc_execute_action(action: "New", section: "lines")` creates a new line via SystemAction.New. Well-known action names (New, Delete, Refresh, Edit, View) mapped to system action codes. LLM writes fields via `bc_write_data(section: "lines", rowIndex)`.

### APPROVAL GATE 6: Extended capabilities verified
- [x] Add a new Sales Order line with item + quantity (New + Type write + Delete)
- [x] Close dialog via bc_respond_dialog (DrillDown Item Card)
- Remaining items moved to [PHASE3](PHASE3.md) Tier 3

---

## Deferred / Out of Scope

These were considered and intentionally deferred:

| Item | Reason |
|---|---|
| Deep section nesting (section tree with path IDs) | BC subpages are one level deep. Dimensions from a line opens a new page context, not a nested section. Flat map suffices. |
| ShowMandatory extraction | BC's ShowMandatory is inconsistent. LLM learns required fields from validation errors. Nice-to-have in Tier 4.3. |
| Accurate totalRowCount from BC payload | TotalRowCount arrives as separate PropertyChanged event on repeater. Implemented in FormProjection but needs more testing. |
| Batch write operations | LLM composes sequential writes naturally. No need for a batch primitive. |
| Server-side filtering on lines | LLM reads + reasons. BC line subpages are typically small enough. |

---

## Key Verification Points (Decompiled Source)

- [x] **Line cell SaveValue controlPath format**: Verified `{repeater}/cr/c[N]` (NOT `cr/co[N]`). `cr` = current row, `c[N]` = row's Children[N].
- [x] **FormHostControl child form identification**: Child forms are `fhc` -> `lf` nodes. `lf.IsSubForm=true` = lines, `lf.IsPart=true` = factbox. No separate PartControl class.
- [x] **DataLoaded total row count**: NOT in DataRefreshChange. Arrives as separate PropertyChanged event with `TotalRowCount` property on repeater controlPath.
- Deferred: **Request page form type** -> [PHASE3](PHASE3.md) Tier 3.2

---

## Protocol Discoveries (from implementation)

### Child form embedding (fhc -> lf pattern)
BC serializes document page subpages as `fhc` (FormHostControl, TypeAlias="fhc") nodes in the root form's control tree. Each `fhc` contains one `lf` (LogicalForm) child with:
- `ServerId`: used as formId for interactions
- `IsSubForm`: true for lines subpages
- `IsPart`: true for factboxes
- `Caption`, `PageType`, `FormStyle`, `Children` (the child form's control tree)

No separate `FormCreated` events are sent for these. They must be parsed from the root form's tree.

### Cross-form DataLoaded routing
BC sends lines repeater data as `DataLoaded` events with the **ROOT form's formId** but the **child form's repeater controlPath** (`server:c[1]`). The PageContextRepository detects when a DataLoaded doesn't match any repeater on the target form and routes it to the child form whose repeater matches the controlPath.

### Lines data loading sequence
1. `OpenForm` -> root form's FormCreated + DataLoaded (header data only)
2. Parse root control tree -> discover `fhc` -> `lf` child forms
3. `LoadForm(childFormId, loadData=true)` -> initializes child form, returns PropertyChanged but NOT DataLoaded
4. `InvokeAction(childFormId, repeaterPath, SystemAction.Refresh=30)` -> triggers DataLoaded with actual line rows

### Sales Order page 42 structure
- 1 root form (header: 118 fields with captions, 359 total controls)
- 1 lines subpage (38 repeater columns: Type, No., Description, Quantity, Unit Price, etc.)
- 10 factboxes (Document Check, Customer Details, Sales Line Details, Item Invoicing, etc.)
- 12 forms total, 12 sections

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-03 | Sections are flat map, not tree | BC children are one level; deeper nav creates new page contexts |
| 2026-04-03 | Bookmark is primary row identifier | rowIndex is fragile after sorts/inserts; bookmark is stable |
| 2026-04-03 | Pattern A for cascading refresh | Return changedSections[], LLM re-reads. Simpler, predictable. |
| 2026-04-03 | No batch write tool | LLM composes sequential writes naturally |
| 2026-04-03 | Approach B: Form-First with Section View | Clean separation: FormState mirrors BC forms, sections are derived view for LLM |
| 2026-04-03 | repeaters: Map per FormState (not single) | Correctness over convenience; primaryRepeater() helper for common case |
| 2026-04-03 | Action parentage from control tree structure | ac nodes inside rc nodes = line-scoped. Verified in parser. |
| 2026-04-03 | openFormIds at session level | Invoke calls need union across all page contexts |
| 2026-04-03 | totalRowCount: null for unknown | Never infer from rows.length; only from PropertyChanged events |
| 2026-04-03 | Unknown subpages are kind: 'subpage' (read-only) | Safer than defaulting to 'lines'; block writes until classified |
| 2026-04-03 | Child forms from fhc/lf, not FormCreated events | BC embeds subpages in root control tree, doesn't send separate events |
| 2026-04-03 | Cross-form DataLoaded routing | BC sends lines data on root formId; route by controlPath match to child |
| 2026-04-03 | Refresh after LoadForm for lines data | LoadForm initializes but doesn't populate; Refresh triggers DataLoaded |
| 2026-04-03 | Skip factbox data loading by default | Loading all 10 factboxes would slow page open. Opt-in later. |
