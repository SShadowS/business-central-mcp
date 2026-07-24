# AssistEdit Support — Design

**Date:** 2026-07-24
**Size:** S
**Build order:** 3 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/assist-edit`

## Problem

BC fields carry two distinct field-scoped actions:

- **LookupAction** (`SystemAction.Lookup = 110`) — opens an enumerable list of candidate values.
- **AssistEditAction** (`SystemAction.AssistEdit = 100`) — the `...` button. Opens whatever page
  the AL `OnAssistEdit` trigger runs: a No. Series selection dialog, the Dimensions page for a
  line, an address editor, a Comment sheet.

We conflate them and then implement only one:

```ts
// src/protocol/form-tree-builder.ts:123
const hasLookup = !!(obj.AssistEditAction || obj.LookupAction);
```

```ts
// src/services/lookup-service.ts:121
systemAction: SystemAction.Lookup,
```

An AssistEdit-only field is therefore reported to the LLM as `isLookup: true`
(`src/protocol/section-dto.ts:35`), the LLM calls `bc_lookup`, and BC gets a `Lookup=110` for an
action that does not exist on that control. The field is advertised and unreachable — the worst
of the three possible states.

## Evidence

| Claim | Source |
|---|---|
| Two separate system actions | `Microsoft.Dynamics.Framework.UI.Client/SystemAction.cs:15` — `AssistEdit = 100`, `Lookup = 110` |
| AssistEdit resolves as a context system action on the field | `Microsoft.Dynamics.Framework.UI/EditLogicalControl.cs:410` — `AssistEditAction => FindContextSystemAction(SystemAction.AssistEdit)` |
| Presence flag exists server-side | `EditLogicalControl.cs:278` — `HasAssistEdit => AssistEditAction != null` |
| Wire property name and short alias | `Microsoft.Dynamics.Framework.UI.Client/ClientEditLogicalControl.cs:18` — `new Name("AssistEditAction", "aea")` |
| Serialized on both card fields and repeater columns | `EditLogicalControlSerializer.cs:21`; `RepeaterColumnControlSerializer.cs:73` (`if (editLogicalControl.HasAssistEdit)`) |
| Enabled-state changes are observed and pushed | `Observers/EditLogicalControlObserver.cs:111-117` — emits a `PropertyChanged` for `"AssistEditAction"` |

### Verification gate (close before implementing)

The builder reads `obj.AssistEditAction`, the long form. BC's serializer resolves names through
`Name.Resolve(context)`, which emits the **short alias** `aea` when the session negotiated
abbreviations — which ours does (~50 aliases, per CLAUDE.md). If live wire JSON carries `aea`,
today's `hasLookup` detection is silently missing every AssistEdit field, and the "conflation" bug
is actually a "never detected" bug.

**Gate:** capture a card page with a known AssistEdit field from Cronus28 and grep the raw `lf`
JSON for both `AssistEditAction` and `aea`. Record the answer in the spec's implementation plan
before writing code. The design below reads both spellings regardless, so the gate changes the
test expectations, not the architecture.

## Design

### Split the flag at the tree layer

`FieldNode` carries two independent booleans:

```ts
hasLookup?: boolean;      // LookupAction present
hasAssistEdit?: boolean;  // AssistEditAction present (long name or `aea` alias)
```

Both spellings are read for each: `obj.LookupAction ?? obj.la`, `obj.AssistEditAction ?? obj.aea`
(exact alias for LookupAction confirmed from `ClientEditLogicalControl` during implementation).

### DTO

`ControlField` / `Section.fields` replace the single `isLookup` with:

```ts
readonly isLookup?: boolean;      // browseable candidate list via bc_lookup
readonly isAssistEdit?: boolean;  // `...` button, opens a page via bc_lookup mode:'assist'
```

`lookupCustom` keeps its current meaning (custom AL `OnLookup`, not enumerable) and is only ever
set alongside `isLookup`.

This is a breaking output change; the project takes those freely. It matters because the LLM
chooses its next call from these flags, and a flag that means "one of two incompatible things" is
worse than no flag.

### Invocation

`bc_lookup` gains a mode:

```ts
mode?: 'auto' | 'lookup' | 'assist'   // default 'auto'
```

`auto` resolves against the field's flags: prefer `lookup` when the field has one (it returns
data, which is usually what the caller wants), fall back to `assist`. Explicit modes never
fall back — asking for `assist` on a field without one is an error naming the available modes.

Output becomes a discriminated union, because the two actions return fundamentally different
things:

```ts
type LookupOutput =
  | { kind: 'candidates'; rows: LookupRow[]; totalFound: number }
  | { kind: 'page'; pageContextId: string; caption: string; pageType?: string; sections: Section[] };
```

`kind: 'page'` is what AssistEdit produces: `SystemAction.AssistEdit=100` against the field's
control path, then the resulting ownerless `FormCreated` is registered as a page context exactly
as cue drill-down already does (`session:page:assist:*`), and returned so the caller can read,
write, and close it with the normal tools. An AssistEdit that opens a modal dialog instead of a
page surfaces through the existing `dialogsOpened` machinery.

Why extend `bc_lookup` rather than add `bc_assist_edit`: both are "act on this field's side
button", both take `pageContextId` + `field`, and the LLM already reaches for `bc_lookup` when it
sees a side button. A 15th tool for the same gesture splits discovery for no gain.

### Service

`LookupService` grows a sibling method rather than a branchy one:

```ts
lookup(pcId, field, opts)        // existing: 110, harvest rows, LookupCancel to close
assistEdit(pcId, field, opts)    // new: 100, register the opened form, no auto-close
```

Shared helpers (field resolution by caption, ensuring the host form is in edit mode via
`SystemAction.Edit` as at `lookup-service.ts:104`) are extracted into private methods used by
both — the resolution logic must not fork.

Critically, `assistEdit` does **not** send `LookupCancel=340` on the way out. The lookup path
closes its transient form because it has already harvested the rows; an AssistEdit page is the
deliverable and must stay open under a returned `pageContextId`.

## Files touched

```
edit  src/protocol/form-tree-builder.ts     (split flags, read both spellings)
edit  src/protocol/form-node.ts             (FieldNode: hasAssistEdit)
edit  src/protocol/section-dto.ts           (isAssistEdit; isLookup narrowed)
edit  src/protocol/types.ts                 (ControlField DTO)
edit  src/services/lookup-service.ts        (assistEdit + shared private helpers)
edit  src/operations/lookup.ts              (mode input, union output)
edit  src/operations/lookup.tool.ts         (schema, description, input_examples)
```

## Test plan (TDD order)

**Unit — write first:**

1. Tree builder: object with `LookupAction` only -> `hasLookup: true`, `hasAssistEdit` absent.
2. Tree builder: object with `AssistEditAction` only -> `hasAssistEdit: true`, `hasLookup` absent.
3. Tree builder: `aea` alias only -> `hasAssistEdit: true` (the gate's real payoff).
4. Tree builder: both present -> both true.
5. DTO adapter maps both flags through to `Section.fields`.
6. `mode: 'assist'` on a field with no AssistEdit -> error listing the modes that field supports.
7. `mode: 'auto'` picks `lookup` when both exist; picks `assist` when only assist exists.
8. `assistEdit` sends `systemAction: 100` against the field's control path (spy on the interaction).
9. `assistEdit` does not send `LookupCancel`.

**Integration — Cronus28:**

10. Discovery test: scan a small set of card pages (Customer 21, Item 30, Sales Order 42, G/L
    Account 17) and assert at least one field reports `isAssistEdit: true`. This test doubles as
    the live answer to the verification gate and pins a concrete field for test 11.
11. Invoke `bc_lookup(mode:'assist')` on that field -> assert `kind: 'page'`, a usable
    `pageContextId`, and that `bc_read_data` on it returns fields.
12. Existing lookup integration tests still return `kind: 'candidates'` with the same rows.

## Definition of done

- Verification gate closed and its answer recorded in the plan.
- Unit + integration green; existing `bc_lookup` behaviour preserved under the new union shape.
- `npx tsc --noEmit` clean.
- Tool description explains when to pick `lookup` vs `assist`, and that `assist` leaves a page open
  the caller must close.

## Out of scope

- Auto-closing assist pages. The caller owns the returned context.
- Driving the opened page (e.g. auto-picking a No. Series). Normal tools handle it.
- AssistEdit on repeater cells is in scope for detection (`RepeaterColumnControlSerializer.cs:73`
  proves it is serialized) but the first integration test targets a card field; a cell-level test
  is a follow-up if the control-path resolution differs.
