## Verdict

**Not implementation-ready.** The core idea—attach a declarative bookmark set to `bc_execute_action`—is preferable to a standalone selection tool. However, the spec materially overstates what the protocol guarantees, contains an incorrect “fast path” citation, gives a wrong viewport/freshness contract, omits a required schema file, and misses concurrency and residual-selection hazards.

I performed static inspection of the listed TypeScript and decompiled BC28 sources. I did **not** run Cronus28, inspect existing test files, or perform live protocol captures.

## 1. Existing-codebase claims

| Spec claim | Judgment | Evidence and confidence |
|---|---|---|
| Encoder hardcodes one selected row | **Accurate.** | `interaction-encoder.ts:180-181` emits `rowsToSelect: [interaction.key]`, `selectAll: false`, and `unselectAll: true`. **Confidence: certain.** |
| `SetCurrentRowInteraction` only has one key | **Accurate.** | `types.ts:252-257` has `key: string` and no selection collection. **Confidence: certain.** |
| `NavigationService.selectRow` only accepts one bookmark | **Accurate.** | `navigation-service.ts:25-47`. **Confidence: certain.** |
| There is currently no way to express three selected rows | **Accurate through the public implementation inspected.** | The encoder and service constrain this to one row, and `ExecuteActionInput` only has singular `bookmark`/`rowIndex` in `execute-action.ts:11-20`. **Confidence: high.** |
| Strategy line 60 is a “single-row fast path” | **False.** | `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:52-79` is only `GetFriendlyDescription()`. The `rowsToSelect.Count() == 1` condition at line 60 chooses telemetry/friendly-description wording; it does not alter execution. Execution delegates directly at lines 11-14. **Confidence: certain.** |
| Parameter-name citation at `InteractionNames.cs:131` | **Accurate.** | `RowsToSelectParameter = "RowsToSelect"` is at line 131, followed by `UnselectAll` and `RowsToUnselect`. **Confidence: certain.** |
| Delete consumes selected rows | **Accurate, but the citation is incomplete.** | `DeleteAction.cs:38-46` checks `SelectedRows.Count > 0`; lines 61-76 capture and iterate `selectedRows`. The spec’s line 63 points at the snapshot, not the actual loop. **Confidence: certain.** |
| Copy consumes selected rows | **Accurate for BC’s copy action.** | `CopyBaseAction.cs:6-18` requires selected rows; `RowEntriesCopyDataHelper.cs:9-39` builds output from the selected rows. **Confidence: certain.** |
| Parameter matching is case-insensitive | **Accurate.** | `InteractionParameterHelper.cs:225-239` uses `StringComparison.OrdinalIgnoreCase`, matching the note in `CLAUDE.md`. **Confidence: certain.** |
| “Existing target section has no repeater” error can be reused | **Not quite accurate.** | `ExecuteActionOperation.positionRow` has the detailed `rowIndex/bookmark supplied...` error only on its row-index resolution path (`execute-action.ts:98-104`). Direct bookmark selection delegates to `NavigationService`, which returns `Page has no repeater` (`navigation-service.ts:29-31`). The proposed implementation must choose and test one message rather than claim there is a single existing one. **Confidence: high.** |
| Files-touched list is complete | **False.** | `execute-action.tool.ts:1` imports the shared `ExecuteActionSchema`; the actual schema lives in `src/mcp/schemas.ts:70-81`. Adding `bookmarks` and schema-level exclusivity requires editing `src/mcp/schemas.ts`. Merely editing `execute-action.tool.ts` cannot change the schema. **Confidence: certain.** |

The spec also uses `rowsToSelect` in test 7 even though the proposed tool parameter is named `bookmarks`; that appears to be a test-plan typo.

## 2. BC protocol behavior

### What the decompiled code actually proves

`SetCurrentRowAndRowsSelection` does support a set of bookmarks:

- Initialization reads `Key`, `SelectAll`, `RowsToSelect`, `UnselectAll`, and `RowsToUnselect`:  
  `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:17-38`.
- Execution changes selection, changes current row, then changes selection again:  
  `SetCurrentRowAndRowsSelectionInteraction.cs:24-31`.
- With `unselectAll: true`, `ChangeRowsSelection` clears the existing selection and then selects listed rows:  
  `SetCurrentRowAndRowsSelectionInteraction.cs:70-113`.

Thus, for valid loaded rows on a multi-select repeater, the proposed payload does establish a declarative selected set. **Confidence: certain.**

### The “all N rows” claim needs substantial qualification

For **Delete**, the end-to-end reasoning holds:

1. Selection is populated.
2. Invoking against `{repeater}/cr/c[0]` retains the other selected rows; activation only toggles the current row off/on in `InvokeActionInteraction.cs:121-139` and `EnsureControlInCurrentRowStrategy.cs:7-22`.
3. `DeleteAction` iterates `bindingManager.SelectedRows` in `DeleteAction.cs:61-76`.

So a successful selection of N loaded rows causes BC’s Delete action to process those N selected rows. **Confidence: high**, subject to confirmation/business validation behavior not exercised live.

It is **not true generally** that “row-scoped actions operate on all N rows”:

- Edit, View, DrillDown, and DefaultAction are intrinsically current-row operations.
- `InvokeActionInteraction.GetContextActionToExecute` resolves a specific default/context action (`InvokeActionInteraction.cs:101-119`); it does not generically pass an N-row collection to every action.
- Custom AL actions may use the current record only, or may explicitly consume the page selection through selection-filter logic. Nothing in the supplied decompilation proves that batch Post, Apply Entries, or bulk assignment actions consume the selected collection.

The spec should say: **“The interaction establishes BC’s selected-row state. Actions that are implemented to consume that selection, such as Delete and Copy, can then operate on those rows.”** Batch posting and Apply Entries remain verification gates. **Confidence: certain for the distinction; medium for uninspected individual AL actions.**

### `unselectAll: true` is correct but not sufficient

Using `unselectAll: true` is the right declarative intent for a specific loaded selection set. It avoids intentionally depending on the prior selection.

However:

- It only controls the selection-setting interaction. The resulting selection remains server-side state after the action, an action failure, or a cancelled dialog.
- Calls to `bc_execute_action` without bookmarks do not reset selection. A later Delete may therefore inherit a prior multi-selection.
- Selection is not surfaced in `RepeaterState`; only `currentBookmark` is represented in `types.ts:374-381`. The operation cannot report how many bookmarks BC actually accepted.

Therefore, the claim that this design avoids hidden cross-call state is overstated. It avoids *incremental construction* of hidden state but still creates persistent hidden selection state. **Confidence: high.**

### The viewport contract is wrong

The spec says BC “silently ignores a bookmark that is not in the current viewport.” The decompiled behavior is more nuanced:

- The **anchor/key** is looked up with `bindingManager.FindRowFromBookmark` during initialization and throws `InvalidBookmarkException` if absent:  
  `SetCurrentRowAndRowsSelectionInteractionExecutionStrategy.cs:29-37`.
- `BindingManager.FindRowFromBookmark` searches the current row and `LoadedRows`, not merely the visual viewport.
- Non-anchor `RowsToSelect` values are matched only against `BindingManager.Rows.LoadedRows`:  
  `SelectRowsInteraction.cs:38-46`. Missing non-anchor bookmarks are silently ignored.
- The server supports tracking non-loaded bookmarks elsewhere (`RowEntrySelectionHandler.ApplySelection`), but this particular interaction does not use that method.

The correct contract is:

> The anchor must resolve in BC’s currently loaded row collection or the interaction fails. Additional bookmarks are selected only if they are in that loaded collection; missing additional bookmarks are silently ignored. “Visible viewport” and “loaded rows” are not equivalent.

The sentence that a caller may legitimately select rows “loaded, then scrolled past” is only true if those rows remain in `LoadedRows`. If scrolling/paging evicted them, the first bookmark fails and other bookmarks are ignored. **Confidence: certain.**

### Additional protocol qualifications

- A filter or refill clears selection. `BindingManager.ClearState` resets non-loaded selection, clears selected rows, clears current row, and clears row storage (`BindingManager.cs:2180-2192` approximately); the subsequent fill selects its new current row. **Confidence: high.**
- A repeater with `AllowMultipleSelection == false` cannot retain N selected rows: selecting a row clears previous selection in `RowEntry.cs:101-121`. The spec does not mention this. **Confidence: certain.**
- If the current row is a draft and more than one row is selected, BC explicitly deselects that draft current row (`SetCurrentRowAndRowsSelectionInteraction.cs:107-111`). **Confidence: certain.**
- If changing current row exposes row errors, BC clears the requested selection and selects only the current row (`SetCurrentRowAndRowsSelectionInteraction.cs:58-64`). **Confidence: certain.**

## 3. API shape and anchor

### `bookmarks[]` on `bc_execute_action` versus a selection tool

The action parameter is the better public API:

- It expresses selection as action context.
- A standalone selection tool would make state lifetime and races even more visible to callers.
- It lets the description explain that some actions consume selection while others use only the current row.
- Keeping `bc_navigate(action: "select")` singular is reasonable.

**Confidence: high.**

But the implementation is not atomic merely because the parameter is on the action tool. It performs:

1. `NavigationService.selectRows()` → one `session.invoke`
2. `ActionService.executeAction()` → another `session.invoke`

`BCSession` serializes individual invokes, not an entire operation spanning multiple invokes. A concurrent MCP request can be enqueued between selection and action. The spec needs either:

- a session-level `runExclusive`/`invokeSequence` primitive wrapping both interactions, or
- support for sending selection and action as one ordered `interactionsToInvoke` batch after action resolution.

Without that, attaching bookmarks to the action tool gives a misleading atomicity impression. **Confidence: high.**

### Which row should be current?

Using `bookmarks[0]` as the default anchor is defensible and predictable. It should be documented as semantically meaningful.

The rationale in the spec is inaccurate, however:

- `RepeaterControl.ResolvePathName("cr")` directly returns `CurrentRowViewport.Children[0]` (`RepeaterControl.cs:798-817`); `/c[0]` then addresses the first child/cell of that current row.
- `GetContextActionToExecute` does not generally “walk up from the current row.” For None/Edit it reads `logicalControl.DefaultAction`; for other system actions it calls `FindContextSystemAction` (`InvokeActionInteraction.cs:101-119`).

The first bookmark is therefore the right anchor principally because `Key` sets `BindingManager.CurrentRow`, and `cr` resolves against that current row—not because DefaultAction performs the described upward walk.

For a minimal API, first-element anchoring is acceptable. If mixed current-row/selection actions become common, a clearer future shape would be `bookmarks` plus optional `currentBookmark` constrained to be a member of the set. **Confidence: high.**

## 4. Missed failure modes and edge cases

1. **Concurrent-operation interleaving.** Another request can run between selection and action because the two `session.invoke` calls are separately queued.

2. **Invalid or disabled action leaves selection behind.** Current `execute-action.ts:65-76` positions the row before `ActionService` resolves and validates the action. A typo, disabled action, or section mismatch can mutate selection and then return an error.

3. **Action failure or cancellation leaves hidden multi-selection.** The next row action without bookmarks can inherit it. This is especially relevant to the proposed integration test that answers “No” to Delete.

4. **Partial selection is silent.** Non-anchor unloaded/stale bookmarks are ignored. No accepted-selection count is returned.

5. **Anchor failure differs from non-anchor failure.** A stale first bookmark throws `InvalidBookmarkException`; stale later bookmarks disappear silently. Reordering the same array can change success into failure.

6. **Filter/refresh between selection and action.** Any refill clears selection. An action, asynchronous event, or concurrent request that refreshes the target form can collapse the selection to the new current row.

7. **`AllowMultiSelect=false`.** BC silently reduces individual row selection to one row.

8. **Draft rows and validation errors.** Draft anchors can be removed from a multi-selection, and row errors can force selection back to one current row.

9. **Actions that ignore selection.** Edit/View/DrillDown and many named actions will use only the anchor/current record. Tool documentation must not promise batch semantics merely because `bookmarks` was supplied.

10. **Subpage versus root action routing.** Selection correctly targets the form/repeater returned by `resolveSection` (`navigation-service.ts:27-39`). System row actions also use that form and repeater (`action-service.ts:190-209`). Named actions are searched only in the selected section’s form. A root action intended to consume a lines-subpage selection may therefore be unavailable or may run against the wrong binding manager. This needs an explicit integration case.

11. **Multiple repeaters in one form.** `resolveSection` falls back to the first repeater when no `repeaterControlPath` is recorded (`section-resolver.ts:104-109`). Bookmarks could target an unintended repeater on more complex pages.

12. **Incomplete exclusivity rules.** The spec rejects `bookmarks` with singular selectors, but should also reject:
    - existing `bookmark` together with `rowIndex`;
    - any row selector with `cue`;
    - `bookmarks` when there is no `action`;
    - empty-string bookmark elements.

13. **Unbounded arrays.** A reasonable maximum should protect RPC size and accidental mass actions.

14. **Deduplication rationale is misleading.** Bookmarks obtained under two different filters are not necessarily simultaneously loaded; applying a new filter refills rows and clears selection. Deduplication itself is harmless, but the stated two-filter use case is unsafe.

## 5. Test-plan assessment

The plan is directionally useful but inadequate for the claims being made.

### Good tests

- Exact single-row encoder regression.
- Multi-row payload shape.
- Empty array and conflict checks.
- Order-preserving deduplication.
- A destructive test that verifies exactly three known records are gone.

### Problems and missing tests

1. Test 2 says `RowsToSelect` while the encoder design says `rowsToSelect`. Casing is accepted by BC, but a byte-level/unit assertion must specify the actual encoded casing.

2. The Customer Delete confirmation test is weak. A dialog appearing proves only that Delete was invoked. A wording difference is brittle and does not necessarily prove that exactly three rows were selected unless the exact BC28 message and count are asserted from a verified capture.

3. The General Journal deletion test proves Delete only. It does not substantiate the spec’s broader batch posting, Apply Entries, or bulk-assignment claims. Add at least one disposable custom or standard action known to consume a selection filter, or narrow the claims.

4. Add protocol/integration tests for:
   - stale **anchor** bookmark → explicit error;
   - stale non-anchor bookmark → observed partial-selection behavior;
   - bookmark outside visual viewport but still loaded;
   - bookmark no longer loaded after paging;
   - selection followed by filter/Refresh before action;
   - `AllowMultiSelect=false`;
   - draft anchor;
   - current-row validation error;
   - line-subpage Delete and a root action while lines are selected;
   - action that ignores selection and acts on the first bookmark only.

5. Add operation/schema tests for all selector combinations:
   - `bookmarks + bookmark`;
   - `bookmarks + rowIndex`;
   - `bookmark + rowIndex`;
   - `bookmarks + cue`;
   - `bookmarks: [""]`;
   - duplicates reducing to one element;
   - maximum array size.

6. Test that action validation occurs before selection, or explicitly test/handle the residual selection after an invalid action.

7. Test post-dialog behavior: select three, invoke Delete, answer No, then verify what remains selected or force a deterministic reset before another row action.

8. Add a concurrency test proving another operation cannot interleave between select and invoke.

9. Verify form routing in both a root list and document lines subpage, including the actual `formId` and repeater path used by both interactions.

10. The delegation test is implementation-coupled and lower value than a service test asserting one exact interaction for both APIs.

**Confidence: high** on these static test-plan holes; **medium** on exact live confirmation behavior because I did not run BC28.

## 6. Scope

- **Keep** `bookmarks[]` on `bc_execute_action`.
- **Keep deferred** incremental add/remove selection.
- **Keep deferred** `selectAll: true`. The decompiled implementation sets `SelectedStateForNotLoadedRows`, and Delete can page through and delete selected non-loaded rows (`DeleteAction.cs:57-92`). That is a materially different, much larger blast-radius feature and should not be slipped into this small change.
- **Bring into scope** atomic select-plus-action serialization.
- **Bring into scope** accurate loaded-row validation/documentation and partial-selection behavior.
- **Bring into scope** residual-selection policy, at minimum documentation and tests; preferably deterministic reset where safe.
- **Bring into scope** schema edits in `src/mcp/schemas.ts` and complete exclusivity validation.
- Either **add a verified selection-consuming non-Delete action test** or cut the unsupported batch-posting/Apply Entries claims.

With those additions this is closer to a **medium** change than the stated small change.

## Top 3 concerns

1. **The protocol does not guarantee all N bookmarks are selected:** the anchor errors if unloaded, later unloaded bookmarks are silently ignored, and non-multiselect/draft/error states can collapse the set.
2. **Selection and action are separate queue entries:** concurrent work or refresh can interleave, so the action parameter is not operationally atomic.
3. **Persistent hidden selection can affect later calls:** invalid actions, failures, and cancelled dialogs can leave a multi-selection that a subsequent action without bookmarks inherits.