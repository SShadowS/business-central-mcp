# Phase 2: Multi-Section Document Page Architecture

## Status: DESIGN IN PROGRESS

**Goal**: Enable full LLM interaction with BC document pages (Sales Order, Purchase Order, etc.) that have multiple repeaters, subpages, and section-scoped actions.

**Guiding principle**: Best solution, not fastest. Break freely. No stubs.

---

## Tier 1: Foundation (Must land first -- everything else depends on this)

### APPROVAL GATE 1: Foundation design approved
- [ ] Design spec written and reviewed
- [ ] Implementation plan approved

### 1.1 Per-form state tracking [CRITICAL]
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

Internal state becomes `Map<formId, FormState>` instead of one flat PageState. Each FormState owns its own controlTree, repeaters, actions, dialogs. The "sections" layer is a derived view on top.

**Root cause**: `StateProjection.applyEvent` filters `event.formId === state.formId`, dropping all child form events. `control-tree-parser` stops at first `rc` node.

### 1.2 Section abstraction layer
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

Flat `Map<sectionId, SectionState>` derived from per-form state. Simple IDs: `header`, `lines`, `factbox:customerStats`. Each section maps to `(formId, rootControlPath, kind, caption)`.

### 1.3 Section discovery heuristics
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

When BC sends `FormCreated(parentFormId=X)`, determine what kind of section it is: lines subpage, FactBox, or other. Strategy: repeater presence, caption matching, control tree metadata, PageType.

### 1.4 Current row per repeater
- [ ] Design
- [ ] Implement
- [ ] Test

Each repeater tracks its own current row/bookmark. `SetCurrentRow` targets the correct repeater's formId + controlPath.

### 1.5 RepeaterColumn binder name mapping [BLOCKER for reads]
- [ ] Design
- [ ] Implement
- [ ] Test

Extract column binder names from repeater columns so `row.cells` keys can be mapped to human-readable column captions. Without this, `bc_read_data` can't produce `{"No.": "1000", "Quantity": "5"}` for lines.

### APPROVAL GATE 2: Foundation verified against BC27 + BC28
- [ ] Open Sales Order page 42 -- see header + lines as separate sections
- [ ] Open Purchase Order page 50 -- same
- [ ] Child form events are captured and routed correctly
- [ ] Section discovery identifies header vs lines vs factboxes
- [ ] Column binder mapping produces readable line data
- [ ] All existing tests still pass (no regressions)

---

## Tier 2: Core Tool Changes (Section-aware tools)

### APPROVAL GATE 3: Tool interface design approved
- [ ] bc_read_data schema reviewed
- [ ] bc_write_data schema reviewed
- [ ] bc_execute_action schema reviewed
- [ ] bc_navigate schema reviewed

### 2.1 Unified bc_read_data with sections
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

Default returns: header fields + lines (first N rows) + `totalRowCount` + section list. Optional params: `section`, `range: {offset, limit}`, `includeSections: [...]`.

### 2.2 Section-targeted bc_write_data
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

Accepts `section` + `rowIndex` or `bookmark` for line writes. Header writes need no section param (default). Bookmark is the stable primitive; rowIndex is a convenience alias.

### 2.3 Line cell write protocol [CRITICAL -- verify from decompiled]
- [ ] Verify controlPath format for SaveValue on repeater cells (decompiled source)
- [ ] Implement: SelectRow on lines form + SaveValue to cell controlPath
- [ ] Test against real BC
- [ ] Document verified wire format

Key question: exact `SaveValue.controlPath` for a repeater cell. Likely `{repeaterPath}/cr/co[N]` but must verify from decompiled `RepeaterControl.ResolvePathName`.

### 2.4 Section-scoped bc_execute_action
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

`section` param disambiguates "Delete" on header vs lines. Row-targeting actions on lines use the lines form's repeater controlPath. Per-section action namespaces.

### 2.5 Navigation from line cells
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

Drill-down/lookup from specific cell in specific line row. Requires targeting the lines form's formId + correct cell controlPath.

### 2.6 Bookmark-based row targeting
- [ ] Design
- [ ] Implement
- [ ] Test

All row-targeting operations accept `bookmark` (preferred, stable) or `rowIndex` (convenience). Reads always include bookmark per row.

### APPROVAL GATE 4: Core tools verified end-to-end
- [ ] "Set sell-to customer to 40000" works (header write)
- [ ] "Change line 1 discount to 10%" works (line write by index)
- [ ] "Delete the last line" works (section-scoped action)
- [ ] "Drill down on Item No. in line 2" works (line cell navigation)
- [ ] "Look up Location Code on line 3" works (line cell lookup)
- [ ] Cross-version: all above work on BC27 AND BC28

---

## Tier 3: Robustness & Error Handling

### 3.1 Unified invoke result envelope
- [ ] Design
- [ ] Implement
- [ ] Test

Every mutating tool returns: `{ updatedSections[], openedPages[], dialogsOpened[], errors[], requiresResponse }`. Consistent shape across all tools.

### 3.2 Validation error surfacing on writes
- [ ] Implement
- [ ] Test

`DataService.writeField` must detect and return `DialogOpened` events (validation errors, confirmations) just like `ActionService` does.

### 3.3 Instructional error messages
- [ ] Implement
- [ ] Test

When LLM targets wrong section/field/action, errors include: available sections, whether the target exists in another section, candidates with hints. Example: "Field 'Line Discount %' not found in section 'header'. It exists in section 'lines'."

### 3.4 Cascading refresh semantics
- [ ] Design
- [ ] Implement
- [ ] Test

Pattern A: mutating tools return `changedSections[]` when header writes affect lines (currency, customer, posting date). LLM calls `bc_read_data` to refresh. No hidden auto-refresh.

### 3.5 Close page dialog handling
- [ ] Implement
- [ ] Test

`bc_close_page` can trigger "save changes?" dialogs. Must detect and return them in the unified result envelope.

### 3.6 Stale section recovery
- [ ] Design
- [ ] Implement
- [ ] Test

When a child form is closed or formId becomes invalid, detect and return actionable error: "Section 'lines' is no longer valid. Call bc_read_data to refresh sections."

### APPROVAL GATE 5: Robustness verified
- [ ] Validation error on invalid item number surfaces correctly
- [ ] Header currency change returns changedSections including lines
- [ ] Close page with unsaved changes returns dialog
- [ ] Wrong-section field write returns instructional error
- [ ] All tools return consistent result envelope

---

## Tier 4: Extended Capabilities

### 4.1 Dialog response tool
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

New tool: `bc_respond_dialog(pageContextId, dialogFormId, choice, fields?)`. Supports confirmation dialogs, request pages (Copy Document), posting prompts.

### 4.2 FactBoxes as readable sections
- [ ] Design
- [ ] Implement
- [ ] Test

FactBox child forms exposed as sections with kind `factbox`. Read-only by default. Opted-in via `includeSections` on bc_read_data.

### 4.3 Field metadata per section
- [ ] Design
- [ ] Implement
- [ ] Test

Expose per-field: editable, visible, isLookup (has Lookup/DrillDown system action), type. Optionally: ShowMandatory if present in control tree.

### 4.4 Tab groups within header
- [ ] Design
- [ ] Implement
- [ ] Test

Group header fields by tab (General, Invoice Details, Shipping). Default read returns current/first tab. Optional `includeAllHeaderTabs: true`.

### 4.5 Paging for large documents
- [ ] Design
- [ ] Implement
- [ ] Test

`bc_read_data(section: "lines", range: {offset, limit})` with accurate `totalRowCount`. Investigate what BC actually sends in `DataLoaded` payload for viewport/total metadata.

### 4.6 Adding new lines (composable)
- [ ] Design
- [ ] Implement
- [ ] Test
- [ ] Verified against real BC

`bc_execute_action(section: "lines", action: "New")` creates a new line. Tool returns the new row's bookmark and suggests required fields based on metadata. LLM then writes fields via `bc_write_data`.

### APPROVAL GATE 6: Extended capabilities verified
- [ ] Post a Sales Order end-to-end (action + dialog response)
- [ ] Read FactBox data (Customer Statistics)
- [ ] Add a new Sales Order line with item + quantity
- [ ] Read 100+ line document with paging
- [ ] Copy Document workflow (request page dialog)

---

## Deferred / Out of Scope

These were considered and intentionally deferred:

| Item | Reason |
|---|---|
| Deep section nesting (section tree with path IDs) | BC subpages are one level deep. Dimensions from a line opens a new page context, not a nested section. Flat map suffices. |
| ShowMandatory extraction | BC's ShowMandatory is inconsistent. LLM learns required fields from validation errors. Nice-to-have in Tier 4.3. |
| Accurate totalRowCount from BC payload | Needs investigation. Most document subpages send full data. Deferred to Tier 4.5. |
| Batch write operations | LLM composes sequential writes naturally. No need for a batch primitive. |
| Server-side filtering on lines | LLM reads + reasons. BC line subpages are typically small enough. |

---

## Key Verification Points (Decompiled Source)

These must be verified from `U:/git/bc-mcp/reference/bc28/decompiled/` before implementation:

- [ ] **Line cell SaveValue controlPath format**: Check `RepeaterControl.ResolvePathName` for how to address a cell in the current row. Likely `{repeater}/cr/co[N]`.
- [ ] **FormHostControl child form identification**: How to distinguish lines subpage from FactBox from other children. Check `FormHostControl`, `PartControl`, `FactBoxAreaControl`.
- [ ] **DataLoaded total row count**: Check if `DataRefreshChange` payload includes total count beyond the rows array.
- [ ] **Request page form type**: How posting/copy-document request pages differ from regular dialogs in the control tree.

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
| 2026-04-03 | Action parentage from control tree structure | ac nodes inside rc nodes = line-scoped. Needs wire traffic verification. |
| 2026-04-03 | openFormIds at session level | Invoke calls need union across all page contexts |
| 2026-04-03 | totalRowCount: null for unknown | Never infer from rows.length; only from PropertyChanged events |
| 2026-04-03 | Unknown subpages are kind: 'subpage' (read-only) | Safer than defaulting to 'lines'; block writes until classified |
