## Overall verdict

**Not implementation-ready.** The core diagnosis is partly correct, but the spec overstates what has been verified, misreads the repeater serializer, and designs an output that cannot represent several normal AssistEdit outcomes. The test plan then assumes the happy-path outcome—one ownerless page—even though AssistEdit is arbitrary AL behavior.

I did **not** run a live Cronus28 capture, so I cannot close the `aea` wire-name question empirically. The source evidence makes the spec’s rationale for that gate weaker than stated.

## 1. Existing-code claims

### `isLookup` conflates the two actions

**Verdict: accurate statically. Confidence: certain.**

`buildField` sets one flag from either property:

- `U:/Git/bc-mcp/src/protocol/form-tree-builder.ts:123`:
  `const hasLookup = !!(obj.AssistEditAction || obj.LookupAction);`
- `U:/Git/bc-mcp/src/protocol/form-node.ts:83-88` exposes only `hasLookup`.
- `U:/Git/bc-mcp/src/protocol/section-dto.ts:35-36` describes `isLookup` as AssistEdit or Lookup.
- `U:/Git/bc-mcp/src/protocol/section-dto.ts:170-172` maps `hasLookup` to `isLookup`.
- `U:/Git/bc-mcp/src/protocol/mcp-adapters.ts:11-25` does the same for `ControlField`.

Thus, when the long-form property is present, AssistEdit and Lookup are genuinely conflated.

### `bc_lookup` sends Lookup=110

**Verdict: accurate for the lookup path; overbroad if interpreted repository-wide. Confidence: high.**

`LookupService.lookup`:

- optionally sends Edit=40 at `lookup-service.ts:103-107`;
- then unconditionally sends `SystemAction.Lookup` at `lookup-service.ts:117-124`;
- later always closes a successfully created lookup form with LookupCancel=340.

There is no AssistEdit branch in `src/operations/lookup.ts`.

However, “only SystemAction.Lookup=110 is ever sent” should be phrased as “the field-lookup operation only sends 110.” `ActionService.invokeAction` forwards arbitrary `ActionNode.systemAction` values (`src/services/action-service.ts:238-258`), so the literal project-wide assertion is not established merely by the cited lookup file.

### What happens if 110 is sent to an AssistEdit-only field?

**Verdict: the spec’s broad outcome is directionally right, but incomplete. Confidence: high.**

The decompiled `InvokeActionInteraction` resolves the requested context action through `FindContextSystemAction(systemAction)` (`InvokeActionInteraction.cs:64-91`). With only AssistEdit=100 present, that will not resolve Lookup=110.

Usually the interaction therefore does nothing and still completes; `LookupService` subsequently fails because it sees no `FormCreated` (`lookup-service.ts:130-137`). It is not necessarily a direct server exception saying the action is absent.

There is also a fallback to a visible form-level action having the requested system action (`InvokeActionInteraction.cs:92-103`). That is unlikely for ordinary fields, but the spec should not describe the wrong-system-action behavior as guaranteed to be a simple no-op.

## 2. Decompiled protocol claims and the `aea` gate

### Separate system actions and context resolution

**Verdict: accurate. Confidence: certain.**

- `SystemAction.cs:15-16`: AssistEdit=100 and Lookup=110.
- `EditLogicalControl.cs:277-281`: separate `HasLookup` and `HasAssistEdit`.
- `EditLogicalControl.cs:410`: AssistEdit resolves via `FindContextSystemAction(SystemAction.AssistEdit)`.
- `ClientEditLogicalControl.cs:15-17`: `LookupAction` has release alias `la`; `AssistEditAction` has release alias `aea`.
- `EditLogicalControlSerializer.cs:21-23`: both action objects are serialized separately for ordinary edit controls.

The action object also carries an `Enabled` value derived from `CanInvoke(contextControl)` in `LogicalActionSerializer.cs:24-32`. This is important and is lost by the proposed booleans.

### Is the `aea` verification gate well-founded?

**Verdict: a live check is prudent, but the gate’s justification is misleading. Confidence: medium-high.**

The decompiled source proves that `aea` is a possible `Name` release alias. It does **not** prove that the current `/csh` web serialization emits that alias.

The spec says the session “negotiated abbreviations” and cites CLAUDE.md’s “~50 aliases.” CLAUDE.md is discussing wire **type** aliases, especially `t` discriminators, not necessarily property-name release aliases. The current `InteractionEncoder` feature list contains no obvious property-abbreviation negotiation (`src/protocol/interaction-encoder.ts:22-29`).

More importantly:

- `WebObjectSerializerContext` sets `UseBrowserNames=true` (`WebObjectSerializerContext.cs:35-44`).
- The project’s live-verified lookup flow currently depends on reading long-form `LookupAction`; the builder does not read `la`.
- `LookupAction` and `AssistEditAction` are declared using the same `Name(debug, release)` pattern in adjacent lines.

That makes it unlikely that current sessions emit `la`/`aea` while the existing lookup integration still works. I did not locate/read the `Name.Resolve` implementation, so a raw capture remains the definitive answer, but the spec should not claim CLAUDE.md establishes alias negotiation.

### Is the spec’s conclusion about “today” established?

**Verdict: not fully. Confidence: high.**

The Problem section states as fact that AssistEdit-only fields are advertised as `isLookup:true`. The later verification gate admits they might never be detected if `aea` is emitted. Those two statements are inconsistent.

A defensible statement is:

> With long-form `AssistEditAction`, the current parser advertises an AssistEdit-only field as `isLookup:true`, and `bc_lookup` then sends Lookup=110 and fails to receive a lookup form. Live capture is still required to prove which property spelling current BC28 sends.

### Repeater serialization claim

**Verdict: materially inaccurate. Confidence: certain.**

The cited `RepeaterColumnControlSerializer.cs:73` does **not** serialize `AssistEditAction` or `aea` on the repeater column. It increments `SystemActionCount` when `HasAssistEdit` is true:

- `RepeaterColumnControlSerializer.cs:29-36` writes `SystemActionCount`, `IsMandatoryColumn`, `QuickEntry`, and `HasLookup`.
- `RepeaterColumnControlSerializer.cs:66-84` counts Lookup, AssistEdit, and DrillDown.

Therefore the evidence supports “the column header reports an aggregate action count,” not “AssistEditAction is serialized on repeater columns.” An edit-control row template may separately carry the action through `EditLogicalControlSerializer`, but that is a different claim and needs verification against the actual repeater tree.

The observer citation is accurate: `EditLogicalControlObserver.cs:108-117` notices AssistEdit enabled-state changes and emits `"AssistEditAction"` changes.

## 3. API and output design

### Extend `bc_lookup` versus a separate tool

**Verdict: I favor a separate `bc_assist_edit` or a more general field-action tool. Confidence: high.**

The spec’s “same side button gesture” rationale is UI-centric. The tools have substantially different semantics:

- `bc_lookup` currently promises non-mutating candidate enumeration and automatic cancellation.
- AssistEdit executes arbitrary AL, may mutate the current field/record, may raise confirmation or validation, and may leave forms or modal state open.
- `search` and `maxRows` make sense only for Lookup.
- AssistEdit on a repeater needs section and row targeting, unlike the current header-only lookup input.

Making `mode:'auto'` invoke arbitrary AssistEdit behavior when no Lookup exists is particularly unsafe. Omitted mode changes `bc_lookup` from a non-mutating read-like operation into a potentially mutating action.

If one tool is retained, `assist` should require explicit selection; `auto` should not silently cross from candidate enumeration into arbitrary AL execution.

### Proposed discriminated union

**Verdict: insufficient. Confidence: certain.**

The union can represent only candidates or exactly one page:

```ts
{ kind: 'candidates', ... }
{ kind: 'page', ... }
```

Normal AssistEdit outcomes also include:

1. Direct host-field mutation with no page.
2. No visible result.
3. `DialogOpened` requiring `bc_respond_dialog`.
4. A modal page/dialog rather than an ownerless regular page.
5. One or more pages.
6. A message or validation/business error.
7. Potential lookup-form behavior requiring LookupOk/LookupCancel semantics.

The text says modal dialogs “surface through existing `dialogsOpened` machinery,” but the proposed output contains neither `dialogsOpened` nor `requiresDialogResponse`. `LookupOperation` currently does not call `detectDialogs`; that machinery is explicitly wired in operations such as `execute-action.ts` and `respond-dialog.ts`.

At minimum, AssistEdit should return a mutation-style envelope:

```ts
{
  kind: 'assistResult';
  updatedFields?: ...;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: ...;
  requiresDialogResponse: boolean;
}
```

If a single-page convenience branch is retained, it should also mirror normal page metadata: `isModal`, `stateVersion`, and potentially all opened pages rather than exactly one.

The candidates branch itself is a reasonable discriminant, though “existing behavior preserved” is inaccurate because wrapping existing output in `kind:'candidates'` is a breaking shape change.

## 4. Missed failure modes and protocol realities

### Arbitrary AssistEdit result

**Confidence: certain.**

The spec incorrectly defines AssistEdit as producing a page. `LogicalAction.Invoke` can validate/save, execute arbitrary action code, and return without any form (`LogicalAction.cs:176-229`). A field update must be applied back to the host context even when no new form appears. The service design does not explicitly say it applies the full event batch to the host before registering opened forms.

### Enabled state is ignored

**Confidence: certain.**

Presence is not equivalent to invokability. `LogicalActionSerializer` serializes `Enabled=false`, and `EditLogicalControlObserver` pushes enabled-state changes. The proposal stores only:

```ts
hasAssistEdit?: boolean
```

It neither records initial `Enabled` nor updates the flag/action state after `PropertyChanged`. `form-tree-mutator.ts:15-39` only merges changes into `node.properties`; it does not translate `"AssistEditAction"` or `aea` into `FieldNode.hasAssistEdit`.

Thus the spec cites reactive enabled-state evidence but does not design support for it. Disabled AssistEdit may be advertised and invoked, and later enabling/disabling will leave stale DTO flags.

### Repeater cells are not actually in scope

**Confidence: certain.**

The existing lookup input has no `section`, `bookmark`, or `rowIndex`. `LookupService` resolves only `ctx.rootFormId` and scans only the root tree (`lookup-service.ts:68-80`).

For line cells, the established implementation pattern is:

1. resolve the section/child form;
2. `SetCurrentRow`;
3. convert column index to `${repeaterPath}/cr/c[N]`;
4. invoke against the child form ID.

See `src/services/data-service.ts:219-251`.

Additionally, list-shaped `Section` output emits `rows`, not `fields` (`section-dto.ts:148-190`), and `RepeaterColumnNode` carries no lookup/assist flags. Even successful detection on template `FieldNode`s would not expose `isAssistEdit` to the caller for line columns.

Therefore “detection in scope; cell-level test follow-up” is not credible. Either:

- add `section`, `bookmark`/`rowIndex`, repeater-column metadata, and current-row path resolution now; or
- explicitly cut repeater AssistEdit from this spec.

### Host edit mode

**Confidence: high.**

The existing helper sends Edit only when the cached field says exactly `editable === false`. It does not:

- handle undefined/stale editability;
- re-resolve the field after Edit;
- verify Edit made it invokable;
- resolve the correct child/section form;
- distinguish the host document from a lines subpage.

Extracting that helper unchanged is not sufficient.

### Opened-page registration and lifecycle

**Confidence: high.**

The cue/action path does more than create a repository entry. `ActionService.invokeAction`:

- applies source-page events;
- registers each new ownerless form;
- uses UUID-based page-context IDs;
- applies events to the new context;
- hydrates child forms (`action-service.ts:259-284`).

The proposed `LookupService.assistEdit` should reuse an extracted opened-form registrar/hydrator rather than duplicate “exactly as cue” behavior. It must also handle:

- partial failure after BC opened the form but before context registration;
- multiple new forms;
- root data loading where initial `FormCreated` fields are empty;
- cleanup if registration/hydration fails;
- modal forms, which cannot safely be treated as ordinary ownerless pages;
- deliberate leaks when callers fail to close returned contexts.

The proposed context branch also omits `stateVersion`, making normal stale-write protection less usable.

### Loss of lookup-form provenance

**Confidence: medium-high.**

`event-decoder.ts:145-161` converts `LookupFormReady` into an ordinary `FormCreated`. If an AssistEdit trigger launches lookup-style UI, the service cannot tell from the decoded event whether it should later use normal CloseForm or LookupCancel/LookupOk semantics. That distinction should be preserved in the event model before treating every AssistEdit-created form as a regular page.

### Custom `OnLookup` remains unreachable

**Confidence: high.**

The spec preserves `lookupCustom` but continues telling callers to use the field’s “own UI / AssistEdit.” A custom OnLookup trigger is analogous to AssistEdit: it can open arbitrary UI rather than an enumerable simple lookup. If the field has no AssistEdit, that advice still leaves it unreachable.

It may reasonably be separate scope, but the tool description must not imply an available path that the MCP server does not expose.

## 5. Test-plan holes

**Verdict: inadequate for the proposed behavior. Confidence: high.**

Missing tests include:

- `la` alias, despite the design promising both spellings.
- `Enabled:false` on lookup and AssistEdit action objects.
- reactive `PropertyChanged` enable/disable transitions.
- `mcp-adapters.ts` mapping; it is not even listed under files touched.
- explicit `mode:'lookup'` against Assist-only and explicit `assist` against Lookup-only.
- behavior of `search`/`maxRows` in assist mode.
- no-page/direct-field-update AssistEdit.
- dialog-opening AssistEdit and `requiresDialogResponse`.
- multiple opened pages.
- business errors and validation errors.
- host Edit failure and re-resolution after entering edit mode.
- child section/factbox resolution and duplicate field captions.
- repeater row positioning and `/cr/c[N]` path generation.
- opened-page registration, child hydration, root loading, close, and index cleanup.
- cleanup after registration/hydration failure.
- output schema/type tests for every discriminant.
- preserving LookupFormReady provenance if AssistEdit opens lookup UI.

Integration test 10/11 is also logically invalid: discovering any field with AssistEdit does not imply that field opens a regular page. The first discovered AssistEdit may mutate the host, open a dialog, do nothing, or open lookup-style UI. Tests should pin separately verified fixtures for:

1. AssistEdit opening a normal page;
2. AssistEdit opening a modal/dialog;
3. AssistEdit updating the host without a page;
4. repeater AssistEdit, if truly in scope.

## 6. Scope assessment

### Should be added now

- Correct initial and reactive action-state modelling, including `Enabled`.
- All real AssistEdit outcomes, especially dialogs and host-only updates.
- Shared opened-form registration/hydration lifecycle.
- Explicit section and row targeting if repeater support remains in scope.
- A clear decision on lookup-form provenance and closing semantics.

### Should be cut or narrowed

- Remove `mode:'auto'` crossing into AssistEdit, or use a separate tool.
- Cut repeater support explicitly unless the full targeting/output work is implemented.
- Do not promise that AssistEdit returns a page.
- Do not claim repeater columns serialize `AssistEditAction`; the cited source does not show that.
- Do not claim current sessions negotiated `aea` based on CLAUDE.md’s type-alias note.

## Top 3 concerns

1. **The output model assumes one page, but AssistEdit can yield a dialog, host mutation, no UI, multiple forms, or lookup-style UI.**
2. **Repeater support is nominal only: there is no column metadata, section input, row selection, child form resolution, or `/cr/c[N]` targeting.**
3. **Action presence is modelled as a stale boolean while BC serializes and reactively updates action enabled state; the cited observer behavior is not handled.**