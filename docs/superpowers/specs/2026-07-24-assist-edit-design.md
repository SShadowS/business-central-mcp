# AssistEdit Support — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/03-assistedit-*.md`)
**Size:** M (was S — the output model has to cover every AssistEdit outcome, not one)
**Build order:** 3 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/assist-edit`

## Problem

BC fields carry two distinct field-scoped actions: **LookupAction** (`SystemAction.Lookup = 110`,
an enumerable candidate list) and **AssistEditAction** (`SystemAction.AssistEdit = 100`, the `...`
button that runs arbitrary AL).

We collapse them into one flag and implement only the first:

```ts
// src/protocol/form-tree-builder.ts:123
const hasLookup = !!(obj.AssistEditAction || obj.LookupAction);
```

```ts
// src/services/lookup-service.ts:117-124
systemAction: SystemAction.Lookup,
```

An AssistEdit-only field is reported as `isLookup: true` (`src/protocol/section-dto.ts:35-36`,
mapped at `:170-172` and `src/protocol/mcp-adapters.ts:11-25`). The LLM calls `bc_lookup`, BC's
`FindContextSystemAction(Lookup)` finds nothing, no `FormCreated` arrives, and `LookupService`
fails at `:130-137`. Advertised and unreachable.

## Evidence

| Claim | Source | Status |
|---|---|---|
| Two separate system actions | `SystemAction.cs:15-16` (also `AdvancedLookup = 115`, unused here) | Verified |
| AssistEdit resolves as a context system action | `EditLogicalControl.cs:410` — `FindContextSystemAction(SystemAction.AssistEdit)`; `:277-281` has separate `HasLookup` / `HasAssistEdit` | Verified |
| Wire names and release aliases | `ClientEditLogicalControl.cs:15-18` — `Name("LookupAction","la")`, `Name("AssistEditAction","aea")` | Verified |
| Both actions serialized separately on edit controls | `EditLogicalControlSerializer.cs:21-23` | Verified |
| **Action objects carry an `Enabled` value from `CanInvoke`** | `LogicalActionSerializer.cs:24-32` | Verified — the first draft ignored this |
| Enabled-state changes are pushed reactively | `EditLogicalControlObserver.cs:108-117` emits a `PropertyChanged` for `"AssistEditAction"` | Verified |
| AssistEdit can return with no form at all | `LogicalAction.Invoke` validates, saves, runs action code, and may return without creating a form (`LogicalAction.cs:176-229`) | Verified — drives the output model |
| ~~Repeater columns serialize `AssistEditAction`~~ | **RETRACTED.** `RepeaterColumnControlSerializer.cs:66-84` increments `SystemActionCount`; `:29-36` writes `SystemActionCount`, `IsMandatoryColumn`, `QuickEntry`, `HasLookup`. It does not serialize the action object | Corrected |

### The `aea` question — downgraded from alarm to confirmation

The first draft claimed AssistEdit fields might never be detected, because BC could emit the short
alias. That is over-dramatic. `LookupAction` uses the **identical** `Name(debug, release)`
mechanism with alias `la`, the builder reads only the long form `obj.LookupAction` (including
`LookupAction.CanShowSimpleLookup`), and the lookup flow is live-verified working. If property
names resolved to short aliases on this session, lookups would already be broken.

CLAUDE.md's "~50 aliases" note is about wire **type** discriminators (`t`), not property names —
citing it as evidence of property-alias negotiation was wrong.

So: read both spellings (cheap, harmless), and confirm against a live capture during
implementation. It is a confirmation step, not a design-changing gate.

## Design

### Split the flag, keep the enabled state

`FieldNode` carries action state, not booleans:

```ts
lookupAction?: { enabled: boolean };
assistEditAction?: { enabled: boolean };
```

Read from `obj.LookupAction ?? obj.la` and `obj.AssistEditAction ?? obj.aea`, taking `Enabled`
(default `true` when absent). `form-tree-mutator.ts` gains a case translating a `PropertyChanged`
for `"AssistEditAction"` / `"LookupAction"` into an update of these, so a field disabled after the
initial load stops being advertised as invokable. Today the mutator only merges scalars into
`node.properties` (`src/protocol/form-tree-mutator.ts:15-39`), so a nested action object would
never flip a derived boolean.

DTO:

```ts
readonly isLookup?: boolean;         // browseable candidate list
readonly isAssistEdit?: boolean;     // `...` button
readonly lookupEnabled?: boolean;    // false when BC disabled it
readonly assistEditEnabled?: boolean;
```

### Invocation — explicit mode only

```ts
mode?: 'lookup' | 'assist'    // default 'lookup'
```

There is **no `auto`**. The first draft had `auto` fall back from lookup to assist, which silently
upgrades a non-mutating enumeration into arbitrary AL execution that can mutate the record, open
dialogs, and leave modal state. The LLM already knows which modes exist from the field flags; it
can pick. Asking for a mode the field lacks is an error naming the modes it has.

This resolves the panel split: one tool (discovery, shared inputs, shared field resolution), but no
implicit crossing between read-shaped and write-shaped behaviour.

### Output model — an envelope, not "a page"

AssistEdit runs arbitrary AL. Real outcomes include: mutating the host field with no UI (the
canonical No. Series case), opening a modal dialog, opening one or more regular pages, raising a
validation or business error, or doing nothing visible. A two-arm `candidates | page` union cannot
represent most of those.

```ts
type LookupOutput =
  | { kind: 'candidates'; rows: LookupRow[]; totalFound: number }
  | {
      kind: 'assist';
      updatedFields: Array<{ name: string; value?: string }>;
      changedSections: string[];
      openedPages: Array<{ pageContextId: string; caption: string; isModal: boolean; stateVersion: number }>;
      dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
      requiresDialogResponse: boolean;
    };
```

The `assist` arm mirrors `ExecuteActionOutput`, because AssistEdit *is* an action invocation. It
reuses `detectChangedSections` / `detectDialogs` (`src/protocol/mutation-result.ts`) and
`classifyBusinessError` — which `LookupOperation` does not currently call at all.

### Service

`LookupService` gains a sibling, not a branch:

```ts
lookup(pcId, field, opts)       // 110, harvest rows, LookupCancel to close
assistEdit(pcId, field, opts)   // 100, apply events to host, register opened forms, no auto-close
```

Shared private helpers for field resolution and edit-mode entry. The edit-mode helper is
**strengthened**, not just extracted: today it sends `Edit=40` only when the cached field says
exactly `editable === false` (`lookup-service.ts:103-107`), never re-resolves the field afterwards,
and never checks that Edit made the action invokable.

Opened-form registration reuses the registrar extracted from `ActionService.invokeAction`
(`src/services/action-service.ts:259-284`) — which already applies source-page events, registers
each ownerless form with a UUID pcId, applies events to the new context, and hydrates child forms.
Duplicating "exactly as cue drill-down does" by hand would drift.

Modal outcomes are registered with `isModal: true` and the modal stack updated, because a modal
assist page blocks subsequent invokes on the host page context.

### Lookup-form provenance

`event-decoder.ts:145-161` converts `LookupFormReady` into a plain `FormCreated`. If an AssistEdit
trigger opens lookup-style UI, the service cannot tell whether it must close with `CloseForm` or
`LookupCancel=340`. The decoder keeps a `fromLookup: true` marker on the event so the close path
can choose correctly.

### Repeater cells — explicitly cut

The first draft claimed cell-level detection was in scope. It is not implementable as written:
`buildRepeater` produces `rcc` columns with no action metadata, list-shaped sections emit `rows`
not `fields` (`section-dto.ts:148-190`), `LookupService` scans only `ctx.rootFormId`
(`:68-80`), and cell invocation needs `SetCurrentRow` plus a `${repeaterPath}/cr/c[N]` path against
the child form (the established pattern at `src/services/data-service.ts:219-251`).

Cut. A follow-up spec adds column-level action metadata, `section` / `bookmark` inputs, and
current-row path resolution together. The tool description states plainly that AssistEdit on line
cells is not yet supported, rather than implying a path that does not exist.

Related: `lookupCustom` fields (custom AL `OnLookup`, `CanShowSimpleLookup=false`) remain
unreachable unless they also have an AssistEdit. The description must not suggest otherwise.

## Files touched

```
edit  src/protocol/form-tree-builder.ts     (split flags + enabled, read both spellings)
edit  src/protocol/form-node.ts             (lookupAction / assistEditAction state)
edit  src/protocol/form-tree-mutator.ts     (translate action PropertyChanged into node state)
edit  src/protocol/section-dto.ts           (four DTO fields)
edit  src/protocol/mcp-adapters.ts          (ControlField mapping — missing from the first draft)
edit  src/protocol/types.ts                 (ControlField DTO)
edit  src/protocol/event-decoder.ts         (fromLookup provenance marker)
edit  src/services/action-service.ts        (extract the opened-form registrar)
edit  src/services/lookup-service.ts        (assistEdit + shared helpers + business errors)
edit  src/operations/lookup.ts              (mode input, union output)
edit  src/mcp/schemas.ts                    (LookupSchema lives here)
edit  src/operations/lookup.tool.ts         (description, examples, the line-cell limitation)
```

## Test plan (TDD order)

**Unit:**

1. `LookupAction` only → `isLookup`, no `isAssistEdit`.
2. `AssistEditAction` only → `isAssistEdit`, no `isLookup`.
3. `aea` alias only → `isAssistEdit`. 4. `la` alias only → `isLookup`.
5. Both present → both flags.
6. `Enabled: false` on either action → the matching `*Enabled: false`.
7. `PropertyChanged` for `"AssistEditAction"` flips `assistEditEnabled` on the mutated tree.
8. DTO + `mcp-adapters` map all four fields.
9. `mode: 'assist'` on a lookup-only field → error listing available modes. And the reverse.
10. Default mode is `lookup`; there is no fallback path to assist (assert no 100 is ever sent).
11. `assistEdit` sends systemAction 100 against the field's control path.
12. `assistEdit` does not send `LookupCancel`.
13. `assistEdit` with no `FormCreated` returns `kind: 'assist'` with populated `updatedFields` —
    the no-UI case must succeed, not error.
14. `assistEdit` opening a dialog sets `requiresDialogResponse`.
15. `assistEdit` opening two forms returns two `openedPages`.
16. A business error in the batch returns `Err`, not a malformed envelope.
17. `search` / `maxRows` supplied in assist mode → rejected as lookup-only inputs.

**Integration — Cronus28:**

18. Discovery scan (Customer 21, Item 30, Sales Order 42, G/L Account 17) asserting a **named**
    field reports `isAssistEdit` — pin the field by name so test 19-21 are stable. Sales Order
    "No." is the expected candidate. This also confirms the long-name/alias question live.
19. That field with `mode: 'assist'` → assert the outcome arm actually observed, and record which
    of the three shapes it was in CLAUDE.md.
20. A separately pinned field whose AssistEdit mutates the host with no UI → `kind: 'assist'`,
    `updatedFields` non-empty, `openedPages` empty.
21. A separately pinned field whose AssistEdit opens a dialog → `requiresDialogResponse: true`,
    then `bc_respond_dialog` completes it.
22. An assist page returned by 19 can be read, closed with `bc_close_page`, and the host page is
    usable afterwards.
23. Existing lookup integration tests return `kind: 'candidates'` with unchanged rows.

## Definition of done

- Unit + integration green; existing `bc_lookup` behaviour preserved under the new union.
- `npx tsc --noEmit` clean.
- Tests 19-21 have three separately pinned fixtures, not one field assumed to cover every outcome.
- Tool description states: pick a mode explicitly; assist can mutate and can leave a page open the
  caller must close; line-cell AssistEdit is unsupported.
- CLAUDE.md gains an "AssistEdit" section recording the observed outcome shapes.

## Out of scope

- Repeater / line-cell AssistEdit (cut above, follow-up spec).
- Driving the opened page automatically.
- Custom `OnLookup` (`CanShowSimpleLookup=false`) fields without an AssistEdit.
