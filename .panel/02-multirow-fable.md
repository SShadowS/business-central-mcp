# Adversarial Review: Multi-Row Selection Spec

## 1. Codebase claims

- **`interaction-encoder.ts` hardcoded single-row set** — accurate. The `SetCurrentRow` case emits `rowsToSelect: [interaction.key], unselectAll: true, selectAll: false, rowsToUnselect: []` (interaction-encoder.ts, `buildInvocation`, the `case 'SetCurrentRow'` branch, ~line 178–181). Confidence: high.
- **`SetCurrentRowInteraction` single `key`** — accurate; types.ts:252–257 shows exactly `{type, formId, controlPath, key}`. Confidence: high.
- **`NavigationService.selectRow(pcId, bookmark, sectionId?)` single bookmark** — accurate (navigation-service.ts:26). Confidence: high.
- **`positionRow` in execute-action.ts** — exists as described; it's only invoked when `bookmark`/`rowIndex` present (execute-action.ts:74–78, 91–113). Confidence: high.

## 2. BC protocol claims

- **Interaction accepts a selection set** — verified. `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.Initialize` reads `Key`, `SelectAll`, `RowsToSelect`, `UnselectAll`, `RowsToUnselect`, `RefreshData` (strategy .cs, ~line 25). Confidence: certain.
- **"Single-row is a special case / fast path at line 60"** — **misleading**. Line ~60's `rowsToSelect.Count() == 1 && !RowsToUnselect.Any()` check is inside `GetFriendlyDescription()` — it only picks a telemetry/description string, not an execution fast path. No behavioral difference. The spec cites this as evidence of execution semantics; it isn't. Confidence: high.
- **"BC silently ignores an out-of-viewport bookmark — no error event"** — **partially wrong**. For the **anchor** (`Key`), the strategy explicitly throws `InvalidBookmarkException` when `FindRowFromBookmark` returns null (strategy .cs, `Initialize`, `if (rowEntry == null) throw`). So a stale/unloaded anchor produces a server error, not silence. Silence may hold only for non-anchor `RowsToSelect` entries — I did not examine `SetCurrentRowAndRowsSelectionInteraction.Invoke` itself, so I can't confirm even that. The spec's "documentation contract" framing rests on a claim that is falsified for the most important bookmark in the array. Confidence: high on the anchor throw; not examined for the rest.
- **Actions consume selection** — verified for Delete: `CanInvoke` requires `SelectedRows.Count > 0 || GetRowEntry(...)` (DeleteAction.cs:42-ish), and `InvokeCore` iterates `bindingManager.SelectedRows` (DeleteAction.cs, delete loop). CopyBaseAction.CanInvoke likewise checks `SelectedRows.Count > 0`. Confidence: high.
- **Critical nuance the spec skates over**: `DeleteAction.InvokeCore` has a guard — if the row resolved from the invoked control (`cr/c[0]` → current row) is **not in `SelectedRows`**, it deletes **only that one row** and ignores the selection entirely. The spec's design happens to survive because the anchor is included in `rowsToSelect`, but this is exactly the invariant the spec should state explicitly and lock with a test (anchor ∈ selection set), and it validates the choice of `key` = a member of `bookmarks`. Confidence: high.
- I did **not** verify `InteractionParameterHelper.TryGetValueIgnoreCase` (casing claim) — the encoder sends lowercase names against PascalCase parameter constants; the whole design depends on this and it's taken from CLAUDE.md on faith. I did not read CLAUDE.md or the gap-analysis doc.
- **Note**: `InteractionNames.cs` also defines a distinct `SelectRowsName = "SelectRows"` interaction with `KeepSelection`/`Select`/`Rows` parameters. The spec doesn't mention it or explain why `SetCurrentRowAndRowsSelection` was chosen over it. Probably the right choice (it's what the web client uses), but an adversarial spec should acknowledge the alternative.

## 3. API shape

`bookmarks[]` on `bc_execute_action` rather than a separate selection tool is right: selection is transient server-side state that BC itself clears after Delete (`bindingManager.ClearSelection()` in DeleteAction.InvokeCore), so a standalone "select" tool would create exactly the hidden cross-call state the spec rejects. Anchor = `bookmarks[0]` is fine given the DeleteAction guard above — but the spec's rationale ("DefaultAction resolution walks up from the current row") is the weaker argument; the *real* reason is the SelectedRows-membership guard, which it doesn't cite. Confidence: medium-high.

## 4. Missed failure modes

1. **Anchor `InvalidBookmarkException`** (see above) — the spec claims no error surfaces; one does. What does the MCP layer return? Unhandled, it's a confusing protocol error. Needs an error-mapping path and a test.
2. **`bookmarks[]` with actions that ignore selection** — Edit/View/DrillDown/New are current-row-only (`ROW_TARGETING_ACTIONS` in action-service.ts:19–22). `bookmarks: [a,b,c]` + `action: "edit"` silently edits only the anchor. No validation, no warning, not even documented.
3. **Selection cleared after action** — BC clears selection post-Delete; a caller chaining two actions on "the selection" will hit single-row behavior on the second call. Should be in the tool description.
4. **Cronus Delete confirmation assumption (test 8)** — deleting customers with ledger entries in Cronus commonly throws a business error rather than a plain confirmation; the test may not exercise the multi-row confirmation path at all.
5. **Selection across scroll blocks / `SelectedStateForNotLoadedRows`** — DeleteAction has an entire paged-rows branch; the interaction between explicit bookmarks and rows that were loaded then scrolled out is asserted-by-documentation only. Not examined live; flagged as unknown.
6. **Subpage routing** looks handled implicitly via `resolveSection` + section-scoped repeater; but there's no test that `bookmarks` on `section: 'lines'` selects in the subpage form rather than the root form.

## 5. Test plan

Reasonable TDD skeleton, but holes: no test for the anchor-invalid-bookmark error path; no test for `bookmarks` + a non-selection-consuming action; no test that a second action after Delete doesn't assume persisted selection; test 8's premise is shaky (see above); and no test of the actual motivating scenario (batch posting / an AL action that reads `Rec` selection via `SETSELECTIONFILTER`) — only system Delete is exercised, which is the *easy* case.

## 6. Scope

Deferring `selectAll` is correct — DeleteAction's `SelectedStateForNotLoadedRows`/`RemoveAllNonpagedInRows` machinery shows its blast radius is genuinely different. Deferring incremental selection is right. I'd **add** to scope: validation or at least documented behavior for `bookmarks[]` with row-scoped-but-not-multi actions, and error mapping for `InvalidBookmarkException`. "Selection state on read output" deferral is fine given BC clears it anyway.

## Top 3 concerns

1. **The "silently ignores stale bookmarks" claim is false for the anchor** — `InvalidBookmarkException` is thrown; the spec's entire "documentation contract" section is built on an unverified (and partly wrong) premise, and no error-handling design exists for it.
2. **No guard/warning for `bookmarks[]` with actions that only use the current row** (Edit/View/DrillDown) — silent wrong-scope execution, the worst failure class for an LLM caller.
3. **The test plan never exercises the motivating use case** (multi-row AL action / batch posting) and test 8's Cronus assumption is likely wrong; multi-select could ship "proven" while only proving system Delete. Plus the minor evidence-table error (line 60 is friendly-description text, not an execution fast path) suggests the evidence table wasn't fully verified.