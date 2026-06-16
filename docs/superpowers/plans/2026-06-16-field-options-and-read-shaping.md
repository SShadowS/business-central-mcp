# Field Options + Read-Shaping (sort / clearFilters) — Implementation Plan

> Execute with superpowers:subagent-driven-development. Spec basis: the 2026-06-16 tool-feasibility spike (verified against decompiled BC + live BC28).

**Goal:** Make BC option/enum choices visible to the agent inline, and let `bc_read_data` clear filters and sort — closing the real, spike-verified gaps. NO new tools; additive DTO field + two `bc_read_data` params.

**Target version:** 1.2.0 (additive, non-breaking).

**Spike-verified facts:**
- Option/enum + boolean controls (`sec`/`bc` wire nodes) carry `Items: [{Text, Value}]` + `CurrentIndex` in every `FormCreated` — we receive them but never surface them. (decompiled `SelectionControlSerializer`; live page 30 "Type" → Inventory/Service/Non-Inventory.)
- Clear-all-filters = `Filter` interaction `FilterOperation.Reset` (value `3`) against the `filc` control path. `FilterOperation.Reset` already exists in `src/protocol/types.ts`.
- Sort = `InvokeAction` `SystemAction=470` against an `rcc` (repeater column header) node, with sort direction `SortOrder: 1` (asc) / `2` (desc). (decompiled `SortColumnAction` / `ClientSortOrder`.)

---

## Current-state anchors (read before editing)
- `src/protocol/form-node.ts`: `NodeProperties` (line ~23), `FieldNode` (~73), `RepeaterColumnNode` (`rcc`, has inherited `properties.caption` + `columnBinder`), `RepeaterNode.columns`.
- `src/protocol/form-tree-builder.ts`: `extractProps` (populates `properties` from wire — currently Caption/StringValue/ShowCaption/etc).
- `src/protocol/mcp-adapters.ts`: `fieldNodeToControlField` (FieldNode → `ControlField` DTO).
- `src/protocol/types.ts`: `ControlField` (~325), `FilterInteraction` (~219), `FilterOperation` (~265, has `Reset:3`, `RemoveLine:2`), the interaction union.
- `src/protocol/interaction-encoder.ts`: `Filter` case (~160), `InvokeAction` case (~144, spreads `namedParameters`).
- `src/services/filter-service.ts`: `applyFilters` (resolves `filc` path via `filterControlPath`, matches column by `properties.caption`, sends `Filter` interactions through `session.invoke`).
- `src/operations/read-data.ts`: `ReadDataInput` (filters/columns/tab/range), the read flow (applyFilters → scroll range → buildSection → stateVersion).
- `src/operations/read-data.tool.ts` + `src/mcp/schemas.ts`: the `bc_read_data` zod schema + description.

---

## Task 1 — Surface option Items/CurrentIndex on the field DTO

**Files:** `src/protocol/form-node.ts`, `src/protocol/form-tree-builder.ts`, `src/protocol/mcp-adapters.ts`, `src/protocol/types.ts`; tests `tests/protocol/form-tree-builder.test.ts` (or new), `tests/protocol/section-dto.test.ts` / adapter test; integration `tests/integration/field-options.test.ts`.

- [ ] **Step 1 (failing test):** in a builder test, feed a synthetic `sec` node with `Items:[{Text:'Inventory',Value:'0'},{Text:'Service',Value:'1'}]` + `CurrentIndex:1`; assert the built `FieldNode.properties.options` equals `[{text:'Inventory',value:'0'},{text:'Service',value:'1'}]` and `properties.optionIndex === 1`. Run → fails (not extracted).
- [ ] **Step 2:** add to `NodeProperties`: `readonly options?: ReadonlyArray<{ readonly text: string; readonly value: string }>;` and `readonly optionIndex?: number;`. In `extractProps` (form-tree-builder), add: if `Array.isArray(obj.Items)`, map each `{Text,Value}` → `{text:String(i.Text??''), value:String(i.Value??'')}` into `p.options`; if `typeof obj.CurrentIndex === 'number'`, set `p.optionIndex = obj.CurrentIndex`. (Applies to `sec` and `bc` nodes since both carry Items.)
- [ ] **Step 2b (REPEATER CELLS — Gemini review gap):** options matter MOST in list/line cells (e.g. Sales Line "Type" = Item/G/L Account). In the wire tree an `rcc` repeater column wraps an inner bound `sec`/`bc` control that carries the `Items`. Ensure `extractProps` populates `options` on those inner cell controls AND that they propagate into the per-column/row-cell schema that `read-data.ts` materializes (`materialized.fields`, read-data.ts:~112). Add a builder test with a synthetic `rc`→`rcc`→`sec(Items)` subtree asserting the cell's `options` survive into the repeater column/field definitions. If `Items` sits on the `rcc` vs the inner control varies, handle both defensively.
- [ ] **Step 3:** add to `ControlField` DTO (types.ts): `readonly options?: ReadonlyArray<{ text: string; value: string }>;` and `readonly selectedOption?: { text?: string; value?: string };`. In `fieldNodeToControlField`: when `f.properties.options` present, set `options`; derive `selectedOption` as the item at `optionIndex` WHEN `optionIndex >= 0`, ELSE fall back to matching `f.properties.stringValue` against the options' `text` (Gemini: `CurrentIndex` may not arrive on every incremental `PropertyChanged` echo, but `StringValue` does — so the StringValue match keeps `selectedOption` correct after edits; `optionIndex === -1` means unset → no `selectedOption`).
- [ ] **Step 4:** run builder + adapter unit tests green; `npx tsc --noEmit`.
- [ ] **Step 5 (integration):** `tests/integration/field-options.test.ts` — (a) open Item Card (30), assert the "Type" field's `options` contain `Inventory`/`Service`/`Non-Inventory` and `selectedOption` is coherent. (b) open a LIST with an option column and a row (e.g. a Sales Order 42 lines subpage "Type", or any list whose column is an enum) and assert the row-cell/column schema exposes that column's `options`. Use the pool.
- [ ] **Step 6:** update the `bc_read_data`/`bc_open_page` tool descriptions to note that option/enum fields AND list option-columns now include `options` (allowed values) + `selectedOption` — so the agent picks a valid value instead of guessing. Commit.

## Task 2 — `bc_read_data` clearFilters

**Files:** `src/services/filter-service.ts`, `src/operations/read-data.ts`, `read-data.tool.ts`, `src/mcp/schemas.ts`; unit `tests/unit/...`, integration extend `tests/integration/...` (a filter test).

**NOTE (Gemini review):** `FilterService.clearFilters(pageContextId, sectionId?)` ALREADY EXISTS (`src/services/filter-service.ts:91`, fires `FilterOperation.Reset`). Do NOT recreate it. This task is purely: test it + wire it into `read_data` + schema/description.

- [ ] **Step 1 (test the existing method):** unit test asserting `FilterService.clearFilters` sends a `Filter` interaction with `filterOperation === FilterOperation.Reset (3)` against the resolved `filc` path (mock session). If the method already has coverage, skip; otherwise add it.
- [ ] **Step 2:** `ReadDataInput` gains `clearFilters?: boolean`. In `ReadDataOperation.execute`, BEFORE applying `filters`/reading: if `clearFilters` is true, call the EXISTING `filterService.clearFilters(...)` first. Order: clearFilters → applyFilters → sort → scroll range → build.
- [ ] **Step 3:** add `clearFilters: z.boolean().optional()` to the `bc_read_data` schema. Description MUST state the accurate semantic (Gemini): "Clears agent-applied filters and restores the page to its DEFAULT/native filtered state (page-defined SourceTableView filters remain) — not a guaranteed blank filter." Do not promise an empty filter set.
- [ ] **Step 4:** unit green; `tsc` clean.
- [ ] **Step 5 (integration):** open page 22, apply a filter (rows narrow to 1), then `read_data({clearFilters:true})` and assert rows return to the full baseline count. Commit.

## Task 3 — `bc_read_data` sort

**Files:** `src/protocol/types.ts` (new interaction or reuse InvokeAction), `src/protocol/interaction-encoder.ts` (if a dedicated interaction), `src/services/data-service.ts` or `filter-service.ts` (a `sortColumn` method), `src/operations/read-data.ts`, `read-data.tool.ts`, `schemas.ts`; unit + integration.

- [ ] **Step 1 (LIVE wire check first — this is a new interaction):** write a throwaway probe (`scripts/tmp-sort-probe.ts`, delete after) that opens page 22, locates the `rcc` header node for column "Name" (match `properties.caption`), and sends an `InvokeAction` `systemAction:470` against that `rcc` controlPath with namedParameters `{ SortOrder: 1 }`. Dump the response + re-read rows; confirm the row order changes (ascending by Name). Try `{SortOrder:2}` for descending. Determine the EXACT param placement BC accepts (namedParameters `SortOrder` vs a `Data` sub-object) — adjust and reconfirm until sorting demonstrably works. Record the working shape. DELETE the probe.
- [ ] **Step 2 (failing unit test):** assert a `sortColumn` service method (or the read-data sort path) sends `InvokeAction systemAction:470` against the matched `rcc` path with the verified `SortOrder` param for asc/desc.
- [ ] **Step 3:** implement: resolve the `rcc` node by column caption (mirror `applyFilters`' caption match, but over `repeater.columns` which are `rcc` nodes — confirm `rcc` nodes carry `properties.caption`; if columns lack captions, match via `columnBinder` against the field caption). Send the SortColumn InvokeAction (verified shape from Step 1). Apply events. **(Gemini) Inspect the response:** if the sort produced an error overlay / business-error / no row reordering (e.g. a non-sortable FlowField or BLOB column), bubble a `ProtocolError` rather than silently returning unsorted rows to the agent. Also error clearly if the named column isn't found (list `availableColumns`, mirroring `applyFilters`).
- [ ] **Step 4:** `ReadDataInput` gains `sort?: { column: string; direction: 'asc' | 'desc' }`. In `ReadDataOperation.execute`, apply sort AFTER clearFilters/filters but BEFORE the scroll-range materialization (so the range reads the sorted order). Map direction → SortOrder 1/2.
- [ ] **Step 5:** schema: `sort: z.object({ column: z.string(), direction: z.enum(['asc','desc']) }).optional()`; update description.
- [ ] **Step 6:** unit green; `tsc` clean.
- [ ] **Step 7 (integration):** open page 22, `read_data({sort:{column:'Name',direction:'asc'}})` then `'desc'`; assert the first row's Name differs between asc/desc and matches sorted expectation. Commit.

## Wrap-up
- [ ] Full unit suite + `tsc --noEmit` green.
- [ ] Full integration gate green (kill stale 3456 first).
- [ ] CHANGELOG `[1.2.0]` section (Added: option values on field output; `bc_read_data` `sort` + `clearFilters`). Bump via `npm version minor` → publish flow (separate, gated).
- [ ] Note: `RemoveLine` (single-line filter remove) and open-to-filter `query` param are explicitly OUT of scope (deferred — open-to-filter has the `No.`-field tokenizer caveat; single-line remove is low value vs Reset).

## Risks / watch-items
- Task 3 is the only protocol unknown (param placement for SystemAction 470) — Step 1 live probe de-risks it BEFORE implementation; if sorting can't be driven, Task 3 is dropped and reported, Tasks 1+2 still ship.
- `rcc` column caption availability: filters match `repeater.columns` by `properties.caption` and that works today, so the same lookup should resolve sort columns; confirm in Step 3.
- Option surfacing must not bloat every field DTO: only populate `options` when `Items` present (option/enum/bool controls), so plain text/decimal fields are unaffected.
