# Multi-Row Selection — Design

**Date:** 2026-07-24
**Size:** S
**Build order:** 2 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/multi-row-selection`

## Problem

BC's row-selection interaction carries a full selection set. Our encoder hardcodes a set of one:

```ts
// src/protocol/interaction-encoder.ts:181
namedParameters: JSON.stringify({
  key: interaction.key, selectAll: false,
  rowsToSelect: [interaction.key], unselectAll: true, rowsToUnselect: [],
})
```

`SetCurrentRowInteraction` (`src/protocol/types.ts:252-257`) has a single `key`, and
`NavigationService.selectRow` (`src/services/navigation-service.ts:25`) takes a single bookmark.
There is no way to express "these three rows".

Consequences: no batch posting, no multi-select delete, no "apply entries" across several ledger
entries, no bulk assignment. Every list flow that BC users drive with ctrl-click is unreachable.

## Evidence

| Claim | Source |
|---|---|
| The interaction accepts a selection set, not one row | `Microsoft.Dynamics.Framework.UI.Client/SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:25` reads `SelectAll`, `RowsToSelect`, `RowsToUnselect` |
| Parameter names | `Microsoft.Dynamics.Framework.UI.Client/InteractionNames.cs:131` — `RowsToSelectParameter = "RowsToSelect"` |
| Single-row is a special case in BC's own strategy | Same file, line 60: `rowsToSelect.Count() == 1 && !RowsToUnselect.Any()` takes a fast path |
| Actions genuinely consume the selection | `Microsoft.Dynamics.Framework.UI/DeleteAction.cs:42,63` — `CanInvoke` checks `SelectedRows.Count > 0`; the delete body iterates `bindingManager.SelectedRows` |
| Copy actions too | `CopyBaseAction.cs:14`, `RowEntriesCopyDataHelper.cs:13` |
| Parameter casing is safe | `InteractionParameterHelper.TryGetValueIgnoreCase` uses `OrdinalIgnoreCase` (CLAUDE.md, verified) |

## Design

### Protocol type

`SetCurrentRowInteraction` gains an optional selection, keeping `key` as the anchor (the row that
becomes *current*, which is what row-scoped `cr/c[0]` path resolution targets):

```ts
export interface SetCurrentRowInteraction extends BaseInteraction {
  readonly type: 'SetCurrentRow';
  readonly formId: string;
  readonly controlPath: string;
  readonly key: string;               // anchor / current row
  readonly rowsToSelect?: string[];   // defaults to [key]
}
```

Encoder emits `rowsToSelect: interaction.rowsToSelect ?? [interaction.key]`, `unselectAll: true`,
`selectAll: false`, `rowsToUnselect: []`. Single-row behaviour is byte-identical to today, so no
existing test changes.

`unselectAll: true` stays because our selection semantics are declarative: the caller states the
complete set it wants, and BC clears whatever was selected before. Incremental add/remove would
make selection hidden cross-call state the LLM has to track — rejected.

### Service

`NavigationService` gains one method and keeps the old one as a thin delegate (DRY — one
implementation, two arities):

```ts
selectRow(pcId, bookmark, sectionId?)            // => selectRows(pcId, [bookmark], sectionId)
selectRows(pcId, bookmarks: string[], sectionId?)
```

`selectRows` sends the anchor as `bookmarks[0]`. Rationale: BC's `DefaultAction` resolution walks
up from the current row, and the first bookmark is the caller's most natural anchor. Documented in
the tool description so a caller who cares about which row is "current" orders the array
deliberately.

### Tool surface

`bc_execute_action` input gains:

```ts
bookmarks?: string[];   // mutually exclusive with bookmark / rowIndex
```

`ExecuteActionOperation.positionRow` becomes `positionRows`, resolving in priority order:

1. `bookmarks` present -> `selectRows(bookmarks)`
2. `bookmark` present -> `selectRows([bookmark])`
3. `rowIndex` present -> resolve to a bookmark from loaded rows (unchanged), then `selectRows([b])`

Validation, rejected before any BC traffic:

- `bookmarks` together with `bookmark` or `rowIndex` -> `ProtocolError` naming the conflict.
- `bookmarks: []` -> `ProtocolError` ("pass at least one bookmark, or omit the parameter").
- `bookmarks` on a section with no repeater -> the existing "target section has no repeater" error.

Duplicate bookmarks are de-duplicated (order-preserving) rather than rejected — a caller building
the array from two filters should not be punished for an overlap.

`bc_navigate(action: 'select')` stays single-row. Selection-for-action belongs on the tool that
invokes the action; keeping it in one place is why this is a parameter and not a new tool.

### What we cannot validate

BC silently ignores a bookmark that is not in the current viewport — no error event comes back.
We do not attempt to verify each bookmark against loaded rows first, because a caller may
legitimately select rows that were loaded, then scrolled past. Instead the tool description states
the requirement plainly: bookmarks must come from a `bc_read_data` of the same section, and rows
must still be loaded. This is a documentation contract, not a runtime guarantee, and the spec says
so rather than pretending otherwise.

## Files touched

```
edit  src/protocol/types.ts                  (rowsToSelect on SetCurrentRowInteraction)
edit  src/protocol/interaction-encoder.ts    (emit the set)
edit  src/services/navigation-service.ts     (selectRows + delegate)
edit  src/operations/execute-action.ts       (bookmarks input, positionRows)
edit  src/operations/execute-action.tool.ts  (schema + description + input_examples)
```

## Test plan (TDD order)

**Unit — write first:**

1. Encoder with `key` only produces today's exact payload (regression lock, byte-compare).
2. Encoder with `rowsToSelect: [a,b,c]` emits `RowsToSelect` of length 3, `key: a`, `unselectAll: true`.
3. `selectRow` delegates to `selectRows` with a single-element array (spy on the interaction sent).
4. Operation rejects `bookmarks` + `bookmark` with a message naming both.
5. Operation rejects `bookmarks: []`.
6. Operation de-duplicates `[a, b, a]` to `[a, b]` preserving order.
7. Operation with `rowsToSelect` on a repeaterless section returns the existing error.

**Integration — Cronus28, destructive allowed:**

8. Customer List: read 3 bookmarks, `bc_execute_action` with `bookmarks` and action `Delete`,
   assert a confirmation dialog appears, respond No. Proves BC received a 3-row selection
   (the confirmation text differs from the single-row case).
9. Destructive round trip on disposable data: create 3 lines in a General Journal via
   `bc_execute_action("New")` + `bc_write_data`, select all 3 by bookmark, Delete, confirm Yes,
   re-read and assert the lines are gone.
10. Single-bookmark path still works end to end (existing drill-down / delete integration tests
    unchanged and green).

## Definition of done

- Unit + integration tests green; existing row-scoped action tests untouched and passing.
- `npx tsc --noEmit` clean.
- `bc_execute_action` description documents the bookmark-freshness contract and the anchor rule.
- CLAUDE.md "Row-Targeting Actions" section extended with the multi-row form.

## Out of scope

- `selectAll: true` (select every row matching the current filter server-side). Genuinely useful
  for batch posting, but it changes error blast radius a lot; revisit once multi-select is proven.
- Incremental selection (`addBookmarks` / `removeBookmarks`).
- Selection state surfaced on read output.
