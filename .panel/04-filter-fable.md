# Adversarial Review: Filter Pane Spec

## 1. Codebase claims — verified

- **`filter-service.ts:52-64` resolves via repeater columns** — accurate. Column lookup is `currentResolved.repeater.columns.find(caption match)` → `column.columnBinder?.path` at exactly those lines. Confidence: certain.
- The "we reconstruct from the repeater, a subset" framing is fair: `filterControlPath()` in `form-views.ts:86-91` only returns the `filc` path; nothing reads its properties today.
- One thing the spec doesn't note: `FilterService.applyFilters` **hard-requires a repeater** (`filter-service.ts:34`, "Page has no repeater -- cannot filter"). If the resolver moves to the filc's published lists, that repeater requirement should be revisited/removed — the spec's "Files touched" edits filter-service but doesn't call this out.

## 2. Protocol claims — verified against decompiled source

- **(a) Flowfilter fallback in `AddFilterLine`** — accurate. `FilterInteraction.cs` (`AddFilterLine`, lines ~46-53): miss on `AvailableColumnBinders()` retries `AvailableFlowFilterColumnBinders()` with `FilterLineType.UserFlowFilter` and targets `bindingManager.UserFlowFilter`. The headline "one column-resolution fix away" is correct. Confidence: certain.
- **(b) `Id` is the ColumnBinder path; `AddLine` matches on it** — accurate. `FilterLogicalControlSerializer.WriteColumnDescription` writes `Id = columnDescription.ColumnBinder.Path`; `FindColumnBinder` compares `columnBinder.Path == path` (ordinal). Confidence: certain.
- **(c) Two Execute shapes** — accurate as far as server dispatch: `ExecuteFilter` branches on whether the target control is `FilterLogicalControl` (quick filter) or `LogicalForm` (parse OData into `UserFilter`, `Refill=true`). Confidence: certain.
- **BUT — likely wire-parameter error in the design (§5):** the spec says the encoder emits `QuickFilterColumnId` / `QuickFilterValue`. Those are the names the **server-to-client serializer** writes as control state (`FilterLogicalControlSerializer.cs:20-21`). The interaction **input** reads `logicalInteractionInput.FilterColumnPath` and `FilterValue` — the same fields the existing AddLine encoder already populates (`interaction-encoder.ts` Filter case sends `filterColumnId`/`FilterValue`). The quick-filter Execute should almost certainly reuse the AddLine parameter names with `filterOperation: 0`, not invent `QuickFilterColumnId`. I did not read `FilterInteractionInput.cs` (not in the material list), so confidence: medium-high, but the spec presents an unverified name as settled encoder design.
- Cited line numbers are approximately right throughout (48-53, 94-97, 100-110, 124-134 all land on the claimed code).

## 3. Ordering claim (expression first)

Directionally sound but overstated. `UserFilter.Clear()` in the form-branch of `ExecuteFilter` (FilterInteraction.cs, LogicalForm branch) does clear the user filter, so expression-after-filters would indeed discard the column filters *from `UserFilter`*. However:

- **Filter line controls survive.** AddLine creates `FilterLineControl` children; `Clear()` clears the filter object, not the lines. Any subsequent `ExecuteFilter(ApplyFilterLines=true)` (e.g. a later quick filter — `ExecuteQuickFilterCore` → `ExecuteFilter(refill:true)` which re-appends every line via `AppendLineToFilter`) may **re-append the "discarded" filters**. So the claimed failure mode ("silently discard") and the fix ("run expression first") both interact with line re-application in ways the spec hasn't traced. What happens to the parsed expression when the next AddLine/quickFilter triggers an execute with `ApplyFilterLines`? Does the expression persist in `UserFilter` or get merged/duplicated? Unverified.
- **Flowfilters are unaffected either way**: `Clear()` touches `UserFilter`, not `UserFlowFilter`. The ordering constraint is real only for `filters`, not `flowFilters`. Spec treats it as one global constraint.

Confidence: high that the order chosen is safe; medium that the *rationale as stated* is the full story.

## 4. Missed failure modes — the big ones

1. **`FindEmptyFilterLinesForColumn` silent no-op (asked about; genuinely missed).** `AddFilterLine`: if an *empty* filter line for that column already exists, the entire block is skipped — **including setting the value**. The interaction succeeds, no filter is applied, no error. Trigger paths: `Reset`/`ApplySessionFilters` restoring line skeletons, pages that open with pre-seeded empty lines (Date Filter lines are commonly pre-present on lists with flowfilters!). For flowfilters specifically this is likely, not exotic. The spec's own headline feature can silently no-op and nothing in the design or tests detects it. This is the single worst omission.
2. **Duplicate-line accumulation.** Applying a filter on a column that already has a *non-empty* line adds a **second** line (the empty-line check only matches empty ones). Repeated `bc_read_data` calls with the same filter AND-stack lines. Current code has this bug too; the spec should at least name it.
3. **`clearFilters` semantics unverified.** Reset → `ApplySessionFilters(applyOriginal: true)`, which in base `FilterLogicalControl` is a **virtual empty method** (`FilterLogicalControl.cs`). Whether it clears an expression (`UserFilter`) or the quick filter depends on the web-client subclass, which I have not seen. The spec's application order starts with `clearFilters` and its out-of-scope note ("clearFilters plus re-apply covers RemoveLine") both lean on Reset doing what its name suggests — unproven.
4. **`AddFilterLine` silently returns** when the filc is disabled, or when the column isn't found server-side (`filter == null || columnBinder == null → return`). The resolver reduces but does not eliminate this (stale column lists, disabled control).
5. **Subpage/factbox filtering.** The expression shape targets "the form root" — which form for `section: 'lines'`? Do part-form filcs publish `FilterColumns`? Spec is silent; `applyFilters` accepts `sectionId` today, so the question is live.
6. **Flowfilter value formats** (date ranges, dimension codes) go through `ValueControl.StringValue` same as normal filters, so probably fine — but only integration test 12 touches it, with a single Date Filter. No coverage of e.g. Global Dimension filters or invalid flowfilter values.

## 5. Test plan holes

Good TDD structure, but missing exactly the failure modes above: no test for (a) empty-line-exists no-op, (b) same-column reapply accumulation, (c) clearFilters actually removing an expression/quick filter, (d) expression → later quickFilter interaction (line re-append), (e) invalid `filterExpression` producing a classified error (claimed in "Expression syntax" but untested), (f) any subpage-section filter. Test 9 (spy on call order) tests the code's ordering, not BC's behavior — fine as a unit test but it enshrines a rationale that integration never validates (a "expression then filters then read both applied" integration test is the missing proof).

## 6. Scope

- Right-sized overall; the resolver extraction and DTO exposure are the correct core.
- **Wrongly deferred:** `RemoveLine`. The justification depends on Reset semantics that are unverified (see 4.3); if Reset is a no-op or restores session filters rather than clearing, RemoveLine becomes necessary.
- **Should be added, tiny:** detect the silent no-op — after AddLine, diff the filc's `ExpressionNode`/children state and error if nothing changed. Without it the tool returns success on a filter that never applied.
- Descriptor omits the serialized `source` property (`WriteColumnDescription` writes it); probably fine to drop, worth a note.
- Not examined: I did not read the gap-analysis doc, CLAUDE.md, or `FilterInteractionInput.cs` (the last is not in the provided decompiled set; its property names are the crux of concern #2 below).

## Top 3 concerns

1. **Silent no-op via `FindEmptyFilterLinesForColumn`** — likely to bite flowfilters specifically (pre-seeded empty Date Filter lines), undetected by design or tests.
2. **Quick-filter wire parameter names are probably wrong in the spec** (`QuickFilterColumnId`/`QuickFilterValue` are serializer *output* names; the interaction input reads `FilterColumnPath`/`FilterValue`). Would fail on first wire probe.
3. **`clearFilters`/Reset semantics unverified** for expressions and quick filters — the whole deterministic application order and the RemoveLine deferral rest on it.