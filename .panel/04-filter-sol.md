## Overall verdict

The central discovery is valid: BC publishes filter and FlowFilter binder paths, and `AddLine` already falls back to `UserFlowFilter`. However, the spec has two serious protocol/design errors:

1. It proposes the wrong inbound parameter names for quick-filter execution.
2. Its proposed parser cannot access `FilterColumns` from the current `FormNode` representation because the tree builder discards those properties.

The ordering requirement is substantially correct for normal `UserFilter`, but the spec overstates it as applying equally to FlowFilters and quick filters.

## 1. Existing-code claims

### Repeater-based resolution

**Verdict: accurate. Confidence: certain.**

`FilterService.applyFilters` resolves captions only against the resolved repeater’s columns, case-insensitively, then takes `column.columnBinder.path`:

- `U:/Git/bc-mcp/src/services/filter-service.ts:52-64`

Thus undisplayed filterable columns and FlowFilters are currently inaccessible.

The service also currently requires a repeater before it even looks for the filter control:

- `U:/Git/bc-mcp/src/services/filter-service.ts:33-38`
- `U:/Git/bc-mcp/src/services/filter-service.ts:45-50`

### Current derived-view architecture

**Verdict: accurate. Confidence: certain.**

`fields`, `actions`, `repeaters`, `tabs`, and other views use root-keyed `WeakMap` caches:

- `U:/Git/bc-mcp/src/protocol/form-views.ts:14-20`
- `U:/Git/bc-mcp/src/protocol/form-views.ts:27-56`

Adding a similarly memoized view is architecturally consistent.

### Current DTO/type/encoder/read-operation gaps

**Verdict: accurate. Confidence: certain.**

- `Section` has no filter-column descriptors: `U:/Git/bc-mcp/src/protocol/section-dto.ts:93-117`
- `FilterInteraction` only has `filterColumnId` and `filterValue`: `U:/Git/bc-mcp/src/protocol/types.ts:229-237`
- The encoder currently emits `filterOperation`, `filterColumnId`, and `FilterValue`: `U:/Git/bc-mcp/src/protocol/interaction-encoder.ts:155-160`
- `ReadDataOperation` currently orders `clearFilters -> filters -> sort -> range`: `U:/Git/bc-mcp/src/operations/read-data.ts:49-78`

### Critical omission: the proposed parser has no raw properties to read

**Verdict: design is not implementable as written. Confidence: certain.**

The spec says `readFilterColumns(filterNode: FormNode)` will read `FilterColumns` and `FlowFilterColumns` from the `filc` node’s “raw properties.” But current `FilterNode` retains only generic `properties` and `children`:

- `U:/Git/bc-mcp/src/protocol/form-node.ts:126-128`

`buildFilter` calls `readProperties`, and `readProperties` does not preserve either array:

- `U:/Git/bc-mcp/src/protocol/form-tree-builder.ts:240-246`
- `U:/Git/bc-mcp/src/protocol/form-tree-builder.ts:274-311`

Therefore the files-touched list is incomplete. At minimum, the design must change `form-node.ts` and `form-tree-builder.ts`, probably giving `FilterNode` typed column arrays directly. A standalone parser over the already-built `FormNode` cannot recover discarded wire data.

The “plus short aliases if negotiated” statement is also unresolved rather than designed. No alias source, mapping, fixture, or verification gate is identified.

## 2. BC protocol claims

### `FilterColumns[].Id` is a binder path used by `AddLine`

**Verdict: correct. Confidence: certain.**

The serializer writes:

- `Id = columnDescription.ColumnBinder.Path`
- both `FilterColumns` and `FlowFilterColumns`

Evidence:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/FilterLogicalControlSerializer.cs:22-36`
- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/FilterLogicalControlSerializer.cs:39-47`

`AddLine` compares the supplied path using exact ordinal-style string equality:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:124-134`

Minor correction: serialized entries are not strictly just `{Id, Caption, Submenu}`. The serializer also writes source metadata at approximately line 45. Ignoring it may be acceptable, but the evidence table is incomplete.

### `AddFilterLine` falls back automatically to FlowFilter binders

**Verdict: correct, with qualifications. Confidence: certain.**

The implementation:

1. Searches `AvailableColumnBinders()`.
2. On a miss, changes the target filter to `bindingManager.UserFlowFilter`.
3. Searches `AvailableFlowFilterColumnBinders()`.
4. Uses `FilterLineType.UserFlowFilter`.

Evidence:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:44-56`

So no new operation or FlowFilter-specific named parameter is required.

Qualifications omitted by the spec:

- A null `UserFlowFilter` or missing binder returns silently at lines 54-57.
- Normal columns win if a path could appear in both sets, because fallback occurs only after a normal-column miss.
- “No new interaction” does not mean no additional handling: discovery, ambiguity resolution, formatting, error detection, and section targeting still need work.

### Two `FilterOperation.Execute` shapes

**Verdict: correct at the server-dispatch level. Confidence: certain.**

When the resolved control is `FilterLogicalControl`, Execute uses:

- `FilterColumnPath`
- `FilterValue`
- `ExecuteQuickFilter()`

When it is a `LogicalForm`, Execute uses:

- `UserFilter`
- `ParseODataFilter`
- a refill

Evidence:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:90-111`

### The quick-filter encoder proposed by the spec is wrong

**Verdict: false and likely fatal. Confidence: certain.**

The spec says:

> Encoder emits `UserFilter` / `QuickFilterColumnId` / `QuickFilterValue`

That confuses outbound logical-control serialization with inbound interaction parameters.

`FilterInteractionInput` defines the inbound names as:

- `FilterColumnId`
- `FilterValue`
- `UserFilter`
- `FilterOperation`

Evidence:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteractionInput.cs:5-19`

`QuickFilterColumnId` and `QuickFilterValue` are properties serialized from the control to the client:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/FilterLogicalControlSerializer.cs:19-20`

The correct quick-filter inbound payload remains conceptually:

```json
{
  "FilterOperation": 0,
  "FilterColumnId": "<binder path>",
  "FilterValue": "<search value>"
}
```

The proposed unit test 8 would codify an incorrect wire format.

### Optional quick-filter column

**Verdict: unsafe for a nonempty value. Confidence: certain.**

Execute always looks up the supplied path and assigns the result to `QuickFilterColumn`:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:94-97`
- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterLogicalControl.cs:246-249`

A nonempty quick-filter value subsequently calls `CreateQuickFilter(value, QuickFilterColumn)`:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterLogicalControl.cs:417-429`

`CreateQuickFilter` throws when the binder is null:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterHelper.cs:433-441`

Therefore `{ column?: string; value: string }` needs a refinement: `column` must be required whenever `value` is nonempty. Omitting the column could only plausibly be supported for clearing the quick filter with an empty value.

Quick filters must also resolve against normal filter columns only. Sending a FlowFilter path makes `FindQuickFilterColumnBinder` return null.

### Claimed OData expression syntax

**Verdict: not verified by the cited evidence. Confidence: high.**

The supplied files prove that `ParseODataFilter(UserFilter)` is called, but not what concrete grammar, qualifier names, or literal formats BC’s concrete helper accepts.

Indeed, the base implementation simply returns an empty filter:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterHelper.cs:519-526`

The example `No ge '10000' and No le '20000'` therefore needs verification against the concrete BC/NAV `FilterHelper` subclass or a live capture. The spec also does not explain whether expression fields are captions, binder names, binder paths, or OData property names. Exposing only captions and binder paths does not necessarily make raw expressions discoverable.

The claim that parser errors reach the “normal business-error classifier” is likewise not demonstrated by the inspected files.

## 3. Ordering and semantic soundness

### Expression before normal per-column filters

**Verdict: correct and necessary. Confidence: certain.**

The form-targeted Execute path does:

```csharp
bindingManager.UserFilter.Clear();
...
bindingManager.UserFilter.AppendFilter(filterToAdd);
```

Evidence:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:100-110`

Thus applying a normal AddLine filter before `filterExpression` can have its underlying `UserFilter` discarded.

### “Expression clears all per-column filters”

**Verdict: overstated. Confidence: certain.**

It clears only `bindingManager.UserFilter`. It does not clear:

- `bindingManager.UserFlowFilter`
- `bindingManager.QuickFilter`
- search/type-ahead filters

Therefore the ordering constraint is specifically:

```text
filterExpression before normal UserFilter AddLines
```

Applying FlowFilters before the expression would not be cleared by the shown code, although using one deterministic order is still reasonable.

This asymmetry also needs API documentation across calls:

- A new expression replaces existing normal filters.
- It apparently preserves prior FlowFilters and quick filters.
- That is surprising unless explicitly documented and tested.

## 4. Missed failure modes and protocol realities

### Empty filter-line branch silently drops the request

**Confidence: certain.**

`AddFilterLine` checks for an existing empty line for the selected binder. If one exists, the method does nothing—it neither fills that line nor creates another:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:58-73`
- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:136-149`

This can occur if:

- the UI already has an empty line;
- a previous call sent an empty filter value;
- reset/session restoration leaves an empty line;
- stale filter-line controls remain after form-targeted expression execution.

The server returns no explicit failure. This needs a live verification gate and a mitigation, not just a test. Possible mitigations include targeting and filling the existing line, removing empty lines first, or detecting lack of data/filter-state change.

### FlowFilter and quick-filter values are UI/culture formatted

**Confidence: high.**

Filter-line values are parsed through the filter value control and its formatter using `CultureInfo.CurrentCulture`:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterValueControl.cs:127-143`

Quick-filter parsing is also formatter- and current-culture-dependent:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterHelper.cs:469-502`

Consequences the spec misses:

- Date FlowFilters may need BC/session-culture date syntax, not an ISO or OData literal.
- Decimal separators can be locale-sensitive.
- Quick filtering can silently produce no filter for unsupported binder types because `ParseEnteredValue` returns null.
- A generic `string` schema is appropriate, but the tool documentation and integration fixtures must specify proven date formats.

Per-column filter tokens, quick-filter values, and raw OData expression literals are three different parsing paths and should not share examples carelessly.

### Caption ambiguity and `Submenu`

**Confidence: high.**

The proposed resolver returns the first case-insensitive caption match. It does not define behavior for:

- duplicate captions within normal columns;
- duplicate captions within FlowFilters;
- the same caption appearing in both sets;
- related-table columns distinguished by `Submenu` or source metadata.

Silently choosing one is unacceptable. Either reject ambiguous captions and return candidates including `kind`, `submenu`, and `id`, or let inputs address an ID/qualified descriptor directly.

### `clearFilters` is not a simple clear-all operation

**Confidence: certain about implementation; medium about concrete session semantics.**

Current `clearFilters` sends `FilterOperation.Reset`:

- `U:/Git/bc-mcp/src/services/filter-service.ts:76-100`

Server-side Reset calls `ApplySessionFilters(parentForm, applyOriginal: true)` rather than `ClearAllFilters()`:

- `U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:113-121`

Thus the spec must verify that Reset restores/clears each newly supported state:

- expression-derived `UserFilter`;
- `UserFlowFilter`;
- quick filter;
- empty filter-line controls.

Calling saved-view/session behavior “out of scope” does not remove this dependency, because `clearFilters` is implemented through exactly that session-filter mechanism.

There is also an existing null-cast hazard: when no `filc` is found, `clearFilters` falls back to the repeater path (`filter-service.ts:83-85`), but `ResetFilter` casts to `FilterLogicalControl` and dereferences it without a null check. The new work should fix this rather than preserve it.

### Subpages and factboxes

**Confidence: high.**

The section model can resolve child forms and list-bearing factboxes/subpages:

- `U:/Git/bc-mcp/src/protocol/section-resolver.ts:26-79`
- `U:/Git/bc-mcp/src/protocol/section-resolver.ts:99-129`

The implementation must use the child form’s:

- `formId`
- root path for expressions
- `filc` path and column lists for AddLine/quick filter

A header-only integration suite will not detect accidentally sending the parent form ID or parent filter-control path. Card-style factboxes should continue to reject list filtering clearly, while ListPart factboxes may be filterable.

### Interaction typing is not genuinely discriminated

**Confidence: high.**

“Discriminated by which control path is targeted” is a runtime convention, not a robust TypeScript discriminant. A single interface with optional `userFilter`, `filterColumnId`, and `filterValue` permits invalid hybrids.

Use an internal union such as:

```ts
type FilterExecuteInteraction =
  | { mode: 'expression'; controlPath: string; userFilter: string }
  | { mode: 'quick'; controlPath: string; filterColumnId: string; filterValue: string };
```

The encoder can then map both modes to the actual BC parameter names.

## 5. Test-plan assessment

The plan has significant holes.

### Tests that should be added

1. **Correct inbound quick-filter parameter names.** Assert `FilterColumnId` and `FilterValue`, explicitly not `QuickFilterColumnId`/`QuickFilterValue`.
2. **Nonempty quick filter without a column.** Schema/service rejection before invoking BC.
3. **FlowFilter path passed to quick filter.** Must reject as the wrong kind.
4. **Expression plus normal filter integration.** Assert the final result is the intersection. A spy call-order test does not prove BC retained both.
5. **Expression replacement semantics across calls.** Verify prior normal filters are cleared while FlowFilters/quick filters behave as documented.
6. **`clearFilters` after each filter kind and combinations.**
7. **Existing empty filter-line case.** This is a known silent no-op branch and needs a live test.
8. **Repeated filters on the same column**, including empty then nonempty values.
9. **Caption ambiguity**, including normal-vs-FlowFilter collision and duplicate submenu entries.
10. **Fallback when filter arrays are absent**, proving repeater filtering still works.
11. **List subpage/ListPart factbox targeting**, proving the child `formId` and child paths are used.
12. **Culture-sensitive FlowFilter values**, especially a Date FlowFilter.
13. **Malformed expression and unknown field**, including actual error classification.
14. **Expression field-name discovery**, proving the documented identifiers work.
15. **Quick filter plus regular filter**, proving they combine rather than replace one another.
16. **Unsupported quick-filter column type**, checking for error or documented no-op behavior.
17. **DTO projection tests**, proving filter lists appear on the correct section and are absent/empty appropriately.

### Problems in existing proposed assertions

**Confidence: high.**

The G/L Entry range test says the range count should be “between the two single-bound filters’ counts.” An intersection generally should be less than or equal to both single-bound counts, not numerically between them. Better assertions are:

- every returned row satisfies both bounds;
- count is `<=` each one-sided result;
- a known fixture has an exact expected result.

The Date Filter test is also data-dependent. It needs a known customer/date range whose visible FlowField is known to change; otherwise a valid filter may produce the same balance and create a flaky false failure.

“Quick filter narrows the row set” is too weak. Assert the selected column’s values satisfy the verified quick-filter semantics.

## 6. Scope recommendations

### Keep

- Reading authoritative normal/FlowFilter descriptors.
- Transparent FlowFilter routing through AddLine.
- Section DTO discovery.
- Quick filter, after fixing parameter names and column requirements.

### Reconsider or gate

**Raw `filterExpression`: confidence high.**

Keep it only behind a verification gate for:

- concrete grammar;
- accepted field identifiers;
- date/string literal syntax;
- error behavior.

Those are currently asserted without sufficient decompiled or live evidence.

**Explicit `flowFilters`: confidence medium.**

It is arguably redundant because transparent `filters` already routes FlowFilters. If retained, it must solve ambiguity rather than merely “assert kind.” A better selector may accept `{column, kind, submenu?}` or a published descriptor ID.

### Wrongly deferred

**Confidence: medium-high.**

Individual `RemoveLine` can remain out of scope, but “clearFilters plus re-apply covers it” is too strong. It only covers cases where the caller knows every filter that should survive and where Reset has characterized behavior. It does not safely preserve unknown user/session filters or solve the empty-line branch.

Saved-view manipulation itself may remain out of scope, but Reset/session-filter semantics cannot: they are part of the existing `clearFilters` implementation and must be tested against all three new filter mechanisms.

## Top 3 concerns

1. **The quick-filter encoder names are wrong:** inbound execution requires `FilterColumnId`/`FilterValue`, not the serializer’s outbound `QuickFilterColumnId`/`QuickFilterValue`.
2. **The parser cannot work over the current tree:** `FilterColumns` and `FlowFilterColumns` are discarded by `form-tree-builder.ts`, while the spec omits the necessary tree-model changes.
3. **Silent and asymmetric behavior is unaddressed:** AddLine can silently no-op on an existing empty line, expression execution clears only normal `UserFilter`, and Reset semantics for FlowFilters/quick filters are unverified.