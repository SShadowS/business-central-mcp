# Multi-Row Selection — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/02-multirow-*.md`)
**Size:** M (was S — atomicity and the anchor error path are real work)
**Build order:** 2 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/multi-row-selection`

## Problem

BC's row-selection interaction carries a full selection set. Our encoder hardcodes a set of one
(`src/protocol/interaction-encoder.ts:180-181`), `SetCurrentRowInteraction` has a single `key`
(`src/protocol/types.ts:252-257`), and `NavigationService.selectRow` takes one bookmark
(`src/services/navigation-service.ts:25-47`).

No batch posting, no multi-select delete, no apply-entries across several ledger entries.

## Evidence

| Claim | Source | Status |
|---|---|---|
| The interaction accepts a selection set | `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:25-27` reads `Key`, `SelectAll`, `RowsToSelect`, `UnselectAll`, `RowsToUnselect`, `RefreshData` | Verified |
| Parameter names | `InteractionNames.cs:131` — `RowsToSelectParameter = "RowsToSelect"` | Verified |
| `unselectAll: true` clears then selects the listed rows | `SetCurrentRowAndRowsSelectionInteraction.cs:70-113` | Verified |
| **The anchor bookmark is validated and throws if absent** | Strategy `.cs:28-37` — `FindRowFromBookmark` returning null throws `InvalidBookmarkException` | Verified. Corrects the first draft |
| Non-anchor bookmarks are matched only against loaded rows and silently dropped | `SelectRowsInteraction.cs:38-46` | Verified |
| Delete consumes the selection | `DeleteAction.cs:38-46` (`CanInvoke`), `:61-76` (iterates `SelectedRows`) | Verified |
| **Delete falls back to single-row when the current row is NOT in the selection** | `DeleteAction.InvokeCore` — the resolved row is checked for membership before the selection is used | Verified. This is the real reason the anchor must be a member of the set |
| Copy consumes the selection | `CopyBaseAction.cs:6-18`, `RowEntriesCopyDataHelper.cs:9-39` | Verified |
| Parameter matching is case-insensitive | `InteractionParameterHelper.cs:225-239` (`OrdinalIgnoreCase`) | Verified |
| ~~Line 60 is a single-row fast path~~ | **RETRACTED.** `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:53-79` is `GetFriendlyDescription()`; the `Count() == 1` test at line 60 picks telemetry wording and has no execution effect | Corrected |

### What the protocol does and does not guarantee

It establishes BC's selected-row state. **Actions implemented to consume that state** — Delete,
Copy — then operate on those rows. It is *not* true that row-scoped actions generally operate on
N rows: Edit, View, DrillDown and New are current-row operations
(`ROW_TARGETING_ACTIONS`, `src/services/action-service.ts:19-22`), and a custom AL action consumes
the selection only if it was written to (via `SETSELECTIONFILTER` or equivalent). Batch posting and
Apply Entries are **verification gates**, not established facts.

## Design

### Protocol type

```ts
export interface SetCurrentRowInteraction extends BaseInteraction {
  readonly type: 'SetCurrentRow';
  readonly formId: string;
  readonly controlPath: string;
  readonly key: string;               // anchor / current row; MUST be a member of rowsToSelect
  readonly rowsToSelect?: string[];   // defaults to [key]
}
```

Encoder emits `rowsToSelect ?? [key]`, `unselectAll: true`, `selectAll: false`,
`rowsToUnselect: []`. Single-row output is byte-identical to today.

**Anchor membership is an invariant, not a preference.** `DeleteAction` ignores the selection
entirely when the current row is not a member, silently degrading a 3-row delete to 1 row. The
service asserts `rowsToSelect.includes(key)` and throws a programming error if violated.

### Anchor failure is an error, not silence

The first draft claimed BC silently ignores stale bookmarks. It does so only for **non-anchor**
entries. A stale anchor throws `InvalidBookmarkException` server-side, which arrives as an RPC
error. `src/session/rpc-error-classifier.ts` gains a case mapping it to a typed
`InvalidBookmarkError` (code `INVALID_BOOKMARK`) whose message says: the bookmark is no longer in
BC's loaded row set; re-read the section and retry.

The honest contract, which the tool description must state:

> The first bookmark must still be in BC's **loaded** row collection or the call fails. Remaining
> bookmarks are selected only if they are also loaded; ones that are not are silently skipped.
> Loaded rows and the visible viewport are not the same thing — paging can evict rows that were
> read earlier.

### Atomicity

Selection and invocation are two separate `session.invoke` calls, and `BCSession` serializes
*individual invokes*, not operations. A concurrent MCP request can interleave between them and
BC's selection is server-side state.

`BCSession` gains `invokeSequence(interactions, expect)`: one queue entry, several interactions
sent in order, events merged. `positionRows` + action run inside it. Without this, putting
`bookmarks` on the action tool implies an atomicity the implementation does not have.

### Residual selection

BC's selection survives the action. Policy:

- After a successful selection-consuming action, BC clears the selection itself (`ClearSelection`
  inside `DeleteAction.InvokeCore`).
- After a **failed** action, a cancelled dialog, or an action that ignored the selection, the
  multi-selection persists and a later `bc_execute_action` without `bookmarks` inherits it.
- Mitigation: when `bookmarks` is absent but the caller supplies `bookmark`/`rowIndex`, we already
  send a single-row set with `unselectAll: true`, which resets it. The remaining exposure is a
  bookmark-less action following a failed multi-row one. Documented in the tool description and
  covered by test 18.

### Action validation ordering

`ExecuteActionOperation` currently positions the row *before* `ActionService` resolves the action
(`src/operations/execute-action.ts:65-76`), so a typo or a disabled action mutates selection and
then errors. Resolution moves ahead of selection: resolve and validate the action first, then
select, then invoke — all inside the one `invokeSequence`.

### Tool surface

```ts
bookmarks?: string[];   // mutually exclusive with bookmark / rowIndex / cue
```

Validation before any BC traffic:

- `bookmarks` with `bookmark`, `rowIndex`, or `cue` → error naming the conflict.
- `bookmarks: []` or any empty-string element → error.
- more than `BC_MAX_SELECTION` (default 100) entries → error.
- duplicates de-duplicated, order preserved.
- `bookmarks` supplied with an action in `ROW_TARGETING_ACTIONS` that is current-row-only
  (Edit/View/DrillDown/New) → error explaining the action uses only the anchor. Silently acting on
  one row when the caller asked for three is the worst failure class for an LLM caller.

`bc_navigate(action: 'select')` stays single-row.

### Multi-select constraints BC imposes

- A repeater with `AllowMultipleSelection == false` collapses to one row (`RowEntry.cs:101-121`).
- A draft current row is deselected when more than one row is selected
  (`SetCurrentRowAndRowsSelectionInteraction.cs:107-111`).
- Row-level validation errors collapse the selection back to the current row (`:58-64`).
- A filter or refill clears the selection (`BindingManager.ClearState`).

Each is a documented behaviour, not an error we can prevent. The service logs at `warn` when the
post-selection state disagrees with what was requested, where that is observable.

## Files touched

```
edit  src/protocol/types.ts                  (rowsToSelect)
edit  src/protocol/interaction-encoder.ts    (emit the set)
edit  src/services/navigation-service.ts     (selectRows + delegate + anchor invariant)
edit  src/session/bc-session.ts              (invokeSequence)
edit  src/session/rpc-error-classifier.ts    (InvalidBookmarkException -> INVALID_BOOKMARK)
edit  src/core/errors.ts                     (InvalidBookmarkError)
edit  src/operations/execute-action.ts       (bookmarks, positionRows, resolve-before-select)
edit  src/mcp/schemas.ts                     (ExecuteActionSchema lives here, :47 — NOT in the
                                              .tool.ts file, which only imports it)
edit  src/operations/execute-action.tool.ts  (description + input_examples)
edit  src/core/config.ts                     (BC_MAX_SELECTION)
```

## Test plan (TDD order)

**Unit:**

1. Encoder with `key` only reproduces today's exact payload (byte-compare regression lock).
2. Encoder with three rows emits `RowsToSelect` length 3, `key` = first, `unselectAll: true`.
3. Service rejects an anchor that is not a member of `rowsToSelect`.
4. `selectRow` delegates to `selectRows` with a one-element array.
5. Schema rejects `bookmarks` + `bookmark`, + `rowIndex`, + `cue` — three distinct messages.
6. Schema rejects `[]`, `['']`, and over-`BC_MAX_SELECTION` arrays.
7. De-duplication preserves order.
8. `bookmarks` + `edit` (current-row-only action) → error, no BC traffic.
9. `InvalidBookmarkException` from BC maps to `INVALID_BOOKMARK` with re-read guidance.
10. Action resolution failure produces no selection interaction (spy: zero sends).
11. `invokeSequence` submits both interactions as one queue entry; a concurrent invoke cannot
    interleave (assert ordering with a controlled fake queue).

**Integration — Cronus28, destructive:**

12. Customer List: select 3 bookmarks, Delete, assert a confirmation dialog, answer No. Assert the
    dialog text against a captured BC28 string that names the count — a dialog merely *appearing*
    proves only that Delete ran.
13. Full destructive round trip on disposable data: create 3 General Journal lines, select all 3,
    Delete, confirm Yes, re-read and assert all three are gone.
14. **The motivating case**: an action that consumes the selection through AL rather than the
    system Delete — pin one on Cronus28 during planning (candidate: a journal batch post, or Item
    Ledger "Apply Entries"). If no such action can be verified, the spec's batch claims are cut
    rather than shipped unproven.
15. Stale **anchor** (bookmark from a since-filtered list) → `INVALID_BOOKMARK`.
16. Stale **non-anchor** → partial selection, action affects fewer rows, no error. Assert the
    observed behaviour and record it in CLAUDE.md.
17. Bookmarks on `section: 'lines'` of a Sales Order select in the subpage form — assert the
    `formId` and repeater path used by both interactions are the child's, not the root's.
18. Failed multi-row action, then a bookmark-less action → assert the documented residual-selection
    behaviour (this is the one the design cannot prevent).
19. Single-bookmark path unchanged: existing drill-down / delete integration tests green.

## Definition of done

- Unit + integration green; existing row-scoped action tests untouched and passing.
- `npx tsc --noEmit` clean.
- Test 14 either passes or the batch-posting claims are removed from the tool description.
- CLAUDE.md "Row-Targeting Actions" extended with the multi-row form, the anchor-membership
  invariant, and the loaded-rows contract.

## Out of scope

- `selectAll: true`. `DeleteAction.cs:57-92` shows it drives `SelectedStateForNotLoadedRows` and
  pages through unloaded rows — a materially larger blast radius.
- Incremental add/remove selection.
- Surfacing the selected set on read output (BC does not report which bookmarks it accepted).
