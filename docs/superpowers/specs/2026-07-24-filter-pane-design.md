# Filter Pane: Flowfilters, Expressions, Quick Filter — Design

**Date:** 2026-07-24
**Size:** M
**Build order:** 4 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/filter-pane`

## Problem

`FilterService.applyFilters` resolves a filter column by matching the caption against
**repeater columns** and taking that column's `columnBinder.path`
(`src/services/filter-service.ts:52-64`). Anything not displayed as a repeater column cannot be
filtered, and BC's filter pane has two more sections we never touch:

1. **Flowfilters** — the "Filter totals by" block. Date Filter, Global Dimension 1 Filter, etc.
   These are how you ask "customer balance *as of Q1*" or "item inventory *in location BLUE*".
   Without them, every aggregate we read is the unfiltered total.
2. **Quick filter** — the list search box, a single value applied across a chosen column.
3. **Filter expressions** — BC parses a full OData-ish filter string. Ranges, `or`, comparison
   operators. Our per-column `{column, value}` pairs can express a BC filter token like `>1000`
   only by smuggling it into the value string, and nothing across columns.

There is a fourth, quieter problem: we resolve column paths from the wrong source. BC publishes
the authoritative list of filterable columns on the filter control itself. We reconstruct it from
the repeater, which is a subset and can disagree.

## Evidence

| Claim | Source |
|---|---|
| BC serializes both column lists on the filter control | `Microsoft.Dynamics.Framework.UI.Client/FilterLogicalControlSerializer.cs:22-36` — `FilterColumns` and `FlowFilterColumns` arrays |
| Each entry is `{Id, Caption, Submenu}` where **`Id` is the ColumnBinder path** | Same file, `WriteColumnDescription`: `writer.WriteProperty("Id", columnDescription.ColumnBinder.Path)`; `ClientFilterColumnDescription.cs` |
| `AddLine` matches on exactly that path | `Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:124-134` — `FindColumnBinder` compares `columnBinder.Path == path` |
| **Flowfilters need no new interaction** | `FilterInteraction.cs:48-53` — `AddFilterLine` searches `AvailableColumnBinders()` first, and on a miss retries against `AvailableFlowFilterColumnBinders()` with `FilterLineType.UserFlowFilter` |
| Quick filter is `FilterOperation.Execute` on the filter control | `FilterInteraction.cs:94-97` — sets `QuickFilterColumn` + `QuickFilterValue`, calls `ExecuteQuickFilter()` |
| Expression filter is `FilterOperation.Execute` on the **form** | `FilterInteraction.cs:100-110` — `ParseODataFilter(UserFilter)`, appended to `UserFilter`, then `BindingManager.Fill` with `Refill = true` |
| Wire props for quick filter | `FilterLogicalControlSerializer.cs:19-20` — `QuickFilterValue`, `QuickFilterColumnId` |

The headline finding: **flowfilter support is one column-resolution fix away.** The interaction we
already send handles it; we just never pass a flowfilter column's path because we never read the
list that contains it.

## Design

### 1. Read the authoritative column lists

New pure parser `src/protocol/filter-columns.ts`:

```ts
export interface FilterColumnDescriptor { id: string; caption: string; submenu?: string; }
export interface FilterColumns { columns: FilterColumnDescriptor[]; flowFilterColumns: FilterColumnDescriptor[]; }
export function readFilterColumns(filterNode: FormNode): FilterColumns;
```

Reads `FilterColumns` / `FlowFilterColumns` off the `filc` node's raw properties (plus their short
aliases if the session negotiated them — resolve during implementation the same way spec 3 does).
Memoised as a derived view in `src/protocol/form-views.ts`, consistent with `fields`, `actions`,
`repeaters`: same root reference returns the same array reference.

### 2. Column resolution moves to a dedicated unit

New `src/protocol/filter-column-resolver.ts`:

```ts
export function resolveFilterColumn(
  cols: FilterColumns, caption: string,
): { id: string; kind: 'column' | 'flowfilter' } | { error: string; available: string[] };
```

Pure, exhaustively unit-testable, and the single place that knows how a user-facing caption
becomes a BC column path. `FilterService` calls it and stops walking repeater columns. Falls back
to repeater-column lookup **only** when the filter control published no lists (defensive; a page
whose `filc` predates this shape). The error message lists both column sets so the LLM can
self-correct.

### 3. Tool surface on `bc_read_data`

```ts
filters?: Array<{ column: string; value: string }>;   // unchanged; now resolves flowfilters too
flowFilters?: Array<{ column: string; value: string }>; // explicit, errors if not a flowfilter column
filterExpression?: string;                              // raw BC/OData filter, applied to the form
quickFilter?: { column?: string; value: string };       // list search box
```

`filters` gaining transparent flowfilter reach is a behaviour change, not a new parameter: a
caption that only exists as a flowfilter used to error with "Filter column not found" and will now
work. `flowFilters` exists for callers that want to *assert* the routing — passing a normal column
there is an error naming the mistake. Both land on the same `Filter(AddLine)` interaction; the
difference is validation, not wire format.

Application order inside `ReadDataOperation`, which must be deterministic and documented:

```
clearFilters -> filterExpression -> filters -> flowFilters -> quickFilter -> sort -> range
```

`filterExpression` goes first because BC's expression path calls `UserFilter.Clear()` before
appending (`FilterInteraction.cs:102`) — running it after per-column filters would silently discard
them. This ordering is a correctness constraint, not a preference, and gets its own unit test.

### 4. Section DTO exposes what is filterable

```ts
readonly filterColumns?: FilterColumnDescriptor[];
readonly flowFilterColumns?: FilterColumnDescriptor[];
```

Without this the LLM cannot know a "Date Filter" exists on the page. Discovery is most of the
value of this spec.

### 5. Interaction types

`FilterInteraction` gains the two `Execute` shapes:

```ts
filterOperation: FilterOperation.Execute
// quick filter:  controlPath = filc path, filterColumnId?, filterValue
// expression:    controlPath = form root,  userFilter: string
```

Encoder emits `UserFilter` / `QuickFilterColumnId` / `QuickFilterValue` accordingly. Two shapes,
one interaction type, discriminated by which control path is targeted — mirroring exactly what
`FilterInteraction.InvokeCore` does server-side.

### Expression syntax

`ParseODataFilter` accepts BC's OData-style subset (`No ge '10000' and No le '20000'`). We do not
parse, validate, or rewrite the string — it goes to BC verbatim and BC's error comes back through
the normal business-error classifier. The tool description states the syntax and gives two
examples; inventing a second filter DSL on top would be a maintenance trap.

## Files touched

```
new   src/protocol/filter-columns.ts
new   src/protocol/filter-column-resolver.ts
edit  src/protocol/form-views.ts           (memoised filterColumns view)
edit  src/protocol/section-dto.ts          (expose both column lists)
edit  src/protocol/types.ts                (FilterInteraction: userFilter, quick filter fields)
edit  src/protocol/interaction-encoder.ts  (Execute shapes)
edit  src/services/filter-service.ts       (use the resolver; applyExpression; applyQuickFilter)
edit  src/operations/read-data.ts          (new inputs, documented ordering)
edit  src/operations/read-data.tool.ts     (schema, description, examples)
```

## Test plan (TDD order)

**Unit — write first:**

1. `readFilterColumns` parses both arrays from a captured `filc` node fixture.
2. `readFilterColumns` returns empty lists (not undefined) when the props are absent.
3. Resolver matches case-insensitively and returns `kind: 'column'` for a normal column.
4. Resolver returns `kind: 'flowfilter'` for a flowfilter-only caption.
5. Resolver error lists both column sets.
6. `flowFilters` input with a normal-column caption -> error naming the mismatch.
7. Encoder emits `UserFilter` for the expression shape against the form root.
8. Encoder emits `QuickFilterColumnId` + `QuickFilterValue` for the quick-filter shape.
9. `ReadDataOperation` applies `filterExpression` before `filters` (spy on call order) — the
   correctness constraint from the design.
10. Memoised view returns an identical reference for an unchanged root.

**Integration — Cronus28:**

11. Customer List (22): read `flowFilterColumns`, assert "Date Filter" is present with a non-empty `id`.
12. Apply a Date Filter flowfilter and assert a balance-type column changes value versus unfiltered.
13. Apply the same via `filters` (not `flowFilters`) and assert identical results — proves the
    transparent-routing claim.
14. `filterExpression` on G/L Entries (20) with a range, assert the row count is between the two
    single-bound filters' counts.
15. `quickFilter` on Items (31) narrows the row set.
16. Existing filter integration tests unchanged and green (the resolver swap must be invisible to them).

## Definition of done

- Unit + integration green, including the untouched existing filter suite.
- `npx tsc --noEmit` clean.
- CLAUDE.md "Filter Protocol" section extended: the three filter kinds, the `Id`-is-the-path fact,
  and the fixed application order.

## Out of scope

- Filter tokens (`%TODAY`, `..`, `|`). They already work — BC parses them inside the value string.
- Saved views / `ApplySessionFilters` (`FilterOperation.Reset`, `FilterInteraction.cs:114-122`).
- Removing an individual filter line (`RemoveLine`); `clearFilters` plus re-apply covers it.
