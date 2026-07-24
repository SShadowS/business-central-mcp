# Filter Pane: Flowfilters, Quick Filter, Expressions — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/04-filter-*.md`)
**Size:** M
**Build order:** 4 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/filter-pane`

## Problem

`FilterService.applyFilters` resolves a filter column by matching a caption against **repeater
columns** and taking `columnBinder.path` (`src/services/filter-service.ts:52-64`), and refuses to
run at all without a repeater (`:33-38`). So BC's filter pane is only partly reachable:

1. **Flowfilters** ("Filter totals by": Date Filter, Global Dimension filters). Without them every
   aggregate we read is the unfiltered total.
2. **Quick filter** — the list search box.
3. **Filter expressions** — BC parses a filter string covering ranges and `or` across columns.

And the column paths come from the wrong source: BC publishes the authoritative list on the filter
control itself; we reconstruct a subset from the repeater.

## Evidence

| Claim | Source | Status |
|---|---|---|
| BC serializes both column lists on the filter control | `FilterLogicalControlSerializer.cs:22-36` — `FilterColumns` and `FlowFilterColumns` | Verified |
| Each entry is `{Id, Caption, Submenu, source}` where **`Id` is the ColumnBinder path** | Same file, `WriteColumnDescription` `:39-47`; `ClientFilterColumnDescription.cs` | Verified (the first draft omitted `source`) |
| `AddLine` matches that exact path | `FilterInteraction.cs:124-134` — ordinal `columnBinder.Path == path` | Verified |
| **Flowfilters need no new interaction** | `FilterInteraction.cs:44-56` — on a miss in `AvailableColumnBinders()` it retries `AvailableFlowFilterColumnBinders()` with `FilterLineType.UserFlowFilter` | Verified |
| Two `FilterOperation.Execute` shapes (quick filter on the control, OData expression on the form) | `FilterInteraction.cs:88-112` | Verified |
| **Inbound interaction parameter names** | `FilterInteractionInput.cs` — `FilterColumnId`, `FilterValue`, `UserFilter`, `FilterOperation` | Verified |
| ~~Encoder emits `QuickFilterColumnId` / `QuickFilterValue`~~ | **RETRACTED.** Those are *outbound* control-state properties (`FilterLogicalControlSerializer.cs:19-20`). Sending them as interaction parameters would silently do nothing | Corrected |
| A non-empty quick filter without a column **throws** | `FilterInteraction.cs:94-97` → `FilterLogicalControl.cs:417-429` → `FilterHelper.CreateQuickFilter` throws on a null binder (`FilterHelper.cs:433-441`) | Verified |
| Expression execution clears **only** `UserFilter` | `FilterInteraction.cs:100-110` — `bindingManager.UserFilter.Clear()` then `AppendFilter` | Verified. `UserFlowFilter` and the quick filter are untouched |
| **`AddFilterLine` silently no-ops when an empty line for that column already exists** | `FilterInteraction.cs:58-71` with `FindEmptyFilterLinesForColumn` `:136-149` — it neither fills the existing line nor adds one, and returns success | Verified. Worst failure mode in this area |
| Values are parsed through the value control using `CultureInfo.CurrentCulture` | `FilterValueControl.cs:127-143`; quick filter at `FilterHelper.cs:469-502` | Verified |
| `clearFilters` sends `Reset` → `ApplySessionFilters(applyOriginal: true)`, not a clear-all | `src/services/filter-service.ts:76-100`; `FilterInteraction.cs:113-121` | Verified — semantics per filter kind still unknown, see Gate 2 |
| `FilterHelper.ParseODataFilter` base implementation returns an **empty** filter | `FilterHelper.cs:519-526` | Verified — the concrete grammar is in a subclass we have not read |

### Gates (close before the matching feature is implemented)

**Gate 1 — the empty-line no-op.** Capture a list page that opens with a pre-seeded empty filter
line (flowfilter Date Filter lines commonly are), send `AddLine` for that column, and observe
whether the value lands. If it does not, the mitigation below is mandatory rather than defensive.

**Gate 2 — Reset semantics.** After applying (a) a per-column filter, (b) a flowfilter, (c) a quick
filter, (d) an expression, send `clearFilters` and record which of the four actually clear. The
current `clearFilters` and the "RemoveLine is unnecessary" deferral both depend on this.

**Gate 3 — expression grammar.** `filterExpression` ships **only** if this closes: locate the
concrete `FilterHelper` subclass implementing `ParseODataFilter`, or capture the web client sending
one, and record the accepted grammar, the identifier form (caption? binder name? binder path?), and
date/string literal syntax. The example in the first draft was invented. If the gate does not
close, `filterExpression` is cut from this spec.

## Design

### 1. Retain the column lists in the tree

`readProperties` is an allowlist (`src/protocol/form-tree-builder.ts:278-311`) and drops both
arrays, so a parser over the built `FormNode` has nothing to read. `FilterNode` therefore gains
typed fields populated by `buildFilter`:

```ts
export interface FilterColumnDescriptor { id: string; caption: string; submenu?: string; source?: string; }
export interface FilterNode {
  // ...existing
  filterColumns: FilterColumnDescriptor[];
  flowFilterColumns: FilterColumnDescriptor[];
}
```

Both default to `[]`. A memoised `filterColumns(root)` view in `form-views.ts` exposes them, matching
the existing `fields` / `actions` / `repeaters` pattern.

### 2. Column resolution as its own unit

`src/protocol/filter-column-resolver.ts`

```ts
export function resolveFilterColumn(node: FilterNode, caption: string):
  | { id: string; kind: 'column' | 'flowfilter' }
  | { error: string; candidates: FilterColumnDescriptor[] };
```

Ambiguity is an **error**, not a first-match. A caption appearing twice — within one list, or once
in each list — returns the candidates with their `id`, `kind`, and `submenu` so the caller can
disambiguate by passing an `id` directly (the resolver accepts an exact `id` as input too).

`FilterService` uses it and stops walking repeater columns. It falls back to repeater columns only
when the filter control published no lists, and it no longer requires a repeater to exist —
a card page with a filter control is filterable.

### 3. Interaction types — a real union

```ts
type FilterInteraction =
  | { type: 'Filter'; op: 'AddLine';    formId; controlPath; filterColumnId: string; filterValue: string }
  | { type: 'Filter'; op: 'Quick';      formId; controlPath; filterColumnId: string; filterValue: string }
  | { type: 'Filter'; op: 'Expression'; formId; controlPath; userFilter: string }
  | { type: 'Filter'; op: 'Reset';      formId; controlPath };
```

"Discriminated by which control path is targeted" was a runtime convention that permits invalid
hybrids. The encoder maps every arm onto BC's actual inbound names — `FilterOperation`,
`FilterColumnId`, `FilterValue`, `UserFilter` — with `Quick` and `Expression` differing only in
which control they target (filter control vs form root).

### 4. Mitigating the silent no-op

After an `AddLine`, the service compares the filter control's children and `HasFiltersApplied`
before and after. If nothing changed and the requested value was non-empty, it returns
`FILTER_NOT_APPLIED` explaining that BC accepted the interaction without applying a filter (the
empty-line branch). Returning `success` on a filter that never applied is worse than an error.

The same diff catches the disabled-control and column-not-found-server-side silent returns
(`FilterInteraction.cs:40-43`, `:54-57`).

Duplicate-line accumulation — applying a filter to a column that already has a **non-empty** line
adds a second line, ANDing them — is pre-existing behaviour. It is now documented and covered by a
test; `clearFilters` before re-filtering is the documented remedy.

### 5. Tool surface on `bc_read_data`

```ts
filters?: Array<{ column: string; value: string }>;      // now reaches flowfilters transparently
flowFilters?: Array<{ column: string; value: string }>;  // asserts kind; errors on a normal column
quickFilter?: { column: string; value: string };         // column REQUIRED, must be a normal column
filterExpression?: string;                               // only if Gate 3 closes
```

`quickFilter.column` is required because a non-empty value with a null binder throws server-side,
and a flowfilter path makes `FindQuickFilterColumnBinder` return null.

Application order inside `ReadDataOperation`:

```
clearFilters -> filterExpression -> filters -> flowFilters -> quickFilter -> sort -> range
```

`filterExpression` first is a **correctness constraint for `UserFilter` only** — it clears that
filter and nothing else. Flowfilters and the quick filter survive an expression, which is
surprising and therefore documented in the tool description and asserted by a test.

### 6. Discovery in the Section DTO

```ts
readonly filterColumns?: FilterColumnDescriptor[];
readonly flowFilterColumns?: FilterColumnDescriptor[];
```

Without this the LLM cannot know a Date Filter exists. Discovery is most of this spec's value.

### Value formatting

Filter values go through BC's culture-sensitive parsing. Dates, decimals, and option values may
need session-culture syntax rather than ISO. We do not translate — the string passes through — but
the tool description carries formats **proven by integration test 12**, not guessed ones, and the
three parsing paths (filter tokens, quick filter, expression) get separate examples because they
are not the same grammar.

### Section targeting

`applyFilters` already accepts a `sectionId`. All four operations must use the **resolved child
form's** `formId`, its `filc` path, and its own column lists — a lines subpage or a ListPart
factbox has its own filter control. Card-shaped factboxes continue to reject list filtering with a
clear message.

## Files touched

```
new   src/protocol/filter-column-resolver.ts
edit  src/protocol/form-node.ts             (FilterNode column arrays)
edit  src/protocol/form-tree-builder.ts     (buildFilter retains them; readProperties untouched)
edit  src/protocol/form-views.ts            (memoised filterColumns view)
edit  src/protocol/section-dto.ts           (expose both lists)
edit  src/protocol/types.ts                 (FilterInteraction union)
edit  src/protocol/interaction-encoder.ts   (all four arms, correct inbound names)
edit  src/services/filter-service.ts        (resolver, no-op detection, quick/expression, no
                                             repeater requirement, fix the null-cast at :83-85)
edit  src/operations/read-data.ts           (new inputs, documented ordering)
edit  src/mcp/schemas.ts                    (ReadDataSchema lives here)
edit  src/operations/read-data.tool.ts      (description + proven examples)
```

## Test plan (TDD order)

**Unit:**

1. `buildFilter` retains both column arrays from a captured `filc` fixture; absent → `[]`.
2. Resolver matches case-insensitively, returns `kind: 'column'`.
3. Resolver returns `kind: 'flowfilter'` for a flowfilter-only caption.
4. Resolver returns an **ambiguity error with candidates** for a duplicated caption, including the
   normal-vs-flowfilter collision.
5. Resolver accepts an exact `id`.
6. `flowFilters` with a normal-column caption → error naming the mismatch.
7. Encoder AddLine emits `FilterColumnId` + `FilterValue` + `FilterOperation`.
8. Encoder Quick emits `FilterColumnId` + `FilterValue` against the **filter control** path —
   explicitly asserting it does **not** emit `QuickFilterColumnId` / `QuickFilterValue`.
9. Encoder Expression emits `UserFilter` against the **form root**.
10. `quickFilter` without a column → schema rejection before any BC traffic.
11. `quickFilter` with a flowfilter column → rejected as the wrong kind.
12. `ReadDataOperation` applies `filterExpression` before `filters` (call-order spy).
13. No-op detection: an `AddLine` whose response shows no filter-state change → `FILTER_NOT_APPLIED`.
14. Memoised view returns an identical reference for an unchanged root.

**Integration — Cronus28:**

15. Customer List (22): `flowFilterColumns` contains "Date Filter" with a non-empty `id`.
16. Apply that flowfilter and assert a balance FlowField value changes — using a customer and date
    range verified during planning to actually differ, or the test is flaky by construction.
17. The same filter applied via `filters` gives identical results (proves transparent routing).
18. **Gate 1 case**: a page opening with a pre-seeded empty filter line → assert either the value
    applies or `FILTER_NOT_APPLIED` is returned. Never silent success.
19. Quick filter on Items (31) narrows rows **and** every returned row satisfies the filter.
20. Expression (only if Gate 3 closed): a range on G/L Entries where every row satisfies both
    bounds and the count is `<=` each one-sided result.
21. Expression then a per-column filter → both applied (intersection), proving the ordering claim
    against BC rather than against our call order.
22. Expression, then a quick filter → assert what happens to the expression and record it.
23. **Gate 2 cases**: `clearFilters` after each of the four filter kinds.
24. Filtering `section: 'lines'` on a Sales Order uses the child form's ids.
25. Applying the same column filter twice → documented AND-accumulation behaviour.
26. Existing filter integration tests unchanged and green.

## Definition of done

- Gates 1 and 2 closed and recorded. Gate 3 closed **or** `filterExpression` cut.
- Unit + integration green, including the existing filter suite.
- `npx tsc --noEmit` clean.
- CLAUDE.md "Filter Protocol" extended: the four operations, `Id`-is-the-path, the inbound
  parameter names, the empty-line no-op, the ordering rule and its `UserFilter`-only scope.

## Out of scope

- Filter tokens (`..`, `|`, `%TODAY`) — already work inside the value string.
- Saved views.
- `RemoveLine` — **conditionally**: if Gate 2 shows Reset does not clear the new filter kinds,
  RemoveLine comes back into scope rather than being deferred.
