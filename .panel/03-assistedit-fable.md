## 1. Codebase claims — verified

- `form-tree-builder.ts:123` claim: **accurate**. `const hasLookup = !!(obj.AssistEditAction || obj.LookupAction);` is exactly there in `buildField` (U:/Git/bc-mcp/src/protocol/form-tree-builder.ts, ~line 123). Confidence: certain.
- `lookup-service.ts` only ever sends `SystemAction.Lookup` (step 6, ~line 121) plus `Edit=40` and `LookupCancel=340`. No `AssistEdit=100` anywhere. **Accurate**. Confidence: certain.
- `section-dto.ts:35` `isLookup` — present, and its own doc comment ("True if the field has an AssistEdit/Lookup action attached") confirms the conflation is *documented* behaviour, not accidental. Confidence: certain.
- The spec's characterisation "advertised and unreachable" is correct: `lookup()` gates on `hasLookup` (step 3) and then always sends 110, so an AssistEdit-only field passes the gate and gets a system action that `FindContextSystemAction(SystemAction.Lookup)` will not resolve on the server.

## 2. Protocol claims — verified, with one significant pushback

Verified against decompiled source:
- `SystemAction.cs`: `AssistEdit = 100`, `Lookup = 110` (also `AdvancedLookup = 115`, which the spec never mentions — probably fine to ignore). ✔
- `ClientEditLogicalControl.cs`: `new Name("AssistEditAction", "aea")` and `new Name("LookupAction", "la")`. ✔
- `EditLogicalControl.cs`: `HasAssistEdit => AssistEditAction != null` (~line 278) and `AssistEditAction => FindContextSystemAction(SystemAction.AssistEdit)` (~line 405–410). ✔
- `EditLogicalControlSerializer.cs` (~line 21): AssistEditAction written via `AssistEditActionPropertyName.Resolve(context)`. ✔

**Pushback on the "aea" verification gate.** The gate is well-founded as a gate, but the spec misses evidence *already in its own codebase* that mostly answers it: `LookupAction` is serialized through the identical `Name.Resolve(context)` mechanism with alias `la`, and today's builder reads the long form `obj.LookupAction` — including `LookupAction.CanShowSimpleLookup` — and this is **live-verified working** (lookup-service.ts header comments, passing integration tests). If action-property names resolved to short aliases on this session, lookups would already be silently broken. So the strong prior is that the wire carries long names for these properties, and the spec's dramatic alternative ("never detected bug") is almost certainly wrong. Reading both spellings is cheap and harmless, but the spec overweights this scenario. Confidence: high (inference, not a wire capture).

Not examined: `RepeaterColumnControlSerializer.cs:73` and `EditLogicalControlObserver.cs:111-117` — I did not read those files, so I cannot confirm the repeater-column and observer claims.

## 3. Design soundness

Extending `bc_lookup` with `mode` rather than a new tool: **agree** — same gesture, same inputs, and tool-count discipline is real. The service-level split (`lookup`/`assistEdit` siblings with shared private helpers) is the right shape.

But **the discriminated union is incomplete**, and this is the spec's biggest design flaw:

- **AssistEdit that opens no UI at all.** Many `OnAssistEdit` triggers (the canonical No. Series case with a single series, address auto-format, etc.) just mutate the record and return `PropertyChanged` — no `FormCreated`, no dialog. The union has only `candidates` and `page`; a successful no-UI AssistEdit cannot be represented. It needs a third arm, e.g. `{ kind: 'applied'; changedFields: ... }`.
- **Modal dialog case.** The spec hand-waves "surfaces through the existing dialogsOpened machinery," but `LookupOutput` has no `dialogsOpened` field and no `kind: 'dialog'` arm. The one-line dismissal is not a design.
- The `auto` mode has a hole: a field with `lookupCustom` (CanShowSimpleLookup=false) plus AssistEdit — `auto` "prefers lookup," which is explicitly rejected by the service's own step-4 guard. `auto` must skip non-browseable lookups.

## 4. Failure modes / protocol realities missed

Beyond the union gaps above:

- **Repeater cells are not actually "in scope for detection."** `buildRepeater` builds `rcc` columns without reading any action properties, and the row-cell template children get `buildField`'s flag but the DTO only surfaces flags for card-shape sections. The spec's files-touched list contains no rcc/column work, so "detection in scope" is asserted but not planned. Cell invocation also needs the `cr` path segment (per CLAUDE.md row-targeting rules), which the spec never mentions.
- **Caption-based field resolution can hit a repeater template child** and send AssistEdit against a template control path, not a row — same `cr` issue.
- **Modality of the opened assist page.** Lookup forms are torn down immediately; an assist page left open may be modal and block subsequent invokes on the host page context. BCSession has modal retry logic, but the spec doesn't discuss what `bc_read_data`/`bc_write_data` on the *host* do while `session:page:assist:*` is open.
- **AssistEdit enabled-state staleness**: the observer pushes `PropertyChanged` for `"AssistEditAction"`, but `form-tree-mutator` (per CLAUDE.md) merges scalar properties — a nested action-object change likely won't flip `hasAssistEdit`. Not examined `form-tree-mutator.ts`; flagging as a risk, not a finding.
- **Leak posture** is acknowledged (caller owns the context) — acceptable given cue drill-down already works this way, but there's no mention of cleanup on session death for assist contexts (probably covered by existing clear-all; unverified).

## 5. Test plan

Good TDD ordering and the alias tests are right. Holes:

- No test for the **no-UI AssistEdit** outcome (the most common real-world AssistEdit!).
- No test for AssistEdit producing a **modal dialog**.
- No test for `auto` on a `lookupCustom + assist` field.
- No test that the returned assist page can be **closed** (`bc_close_page`) and that the host page is usable afterwards.
- Integration test 10's page set is reasonable (Sales Order "No." is a near-guaranteed AssistEdit), but it should assert the field by name, not just "at least one," or the pin for test 11 is unstable.
- No test that `hasAssistEdit` survives a `PropertyChanged` mutation of the field (structural-sharing copy path).

## 6. Scope

- Extending `bc_lookup` rather than a 15th tool: right call.
- Deferring driving/auto-closing the opened page: right.
- **Wrongly implicit-out-of-scope:** the no-UI outcome and the dialog outcome — these are not enhancements, they're required for the tool to not return a confusing error on the single most common AssistEdit field in BC.
- Repeater-cell detection should either be honestly deferred (including the rcc detection gap) or planned with actual file changes; the current wording claims scope it doesn't implement.

## Top 3 concerns

1. **The output union cannot represent a successful AssistEdit that opens nothing** (No. Series auto-assign) or one that opens a modal dialog — the two-arm union will force an error or a lie for common cases.
2. **`auto` mode's "prefer lookup" contradicts the existing `lookupCustom` guard**, producing errors on custom-OnLookup + AssistEdit fields where `assist` is the only viable mode.
3. **Repeater-cell "detection in scope" is unbacked by the plan** — no rcc/column changes are listed, and cell invocation via `cr` paths is entirely unaddressed.

Minor: the "aea" gate is fine to run but the spec's alarm ("never detected bug") contradicts the live-verified long-name `LookupAction` reads already in the codebase.

```json evidence
{
  "files_checked": [
    "U:/Git/bc-mcp/docs/superpowers/specs/2026-07-24-assist-edit-design.md",
    "U:/Git/bc-mcp/docs/superpowers/specs/2026-07-24-mcp-gap-analysis.md",
    "U:/Git/bc-mcp/CLAUDE.md",
    "U:/Git/bc-mcp/src/protocol/form-tree-builder.ts",
    "U:/Git/bc-mcp/src/protocol/form-node.ts",
    "U:/Git/bc-mcp/src/protocol/section-dto.ts",
    "U:/Git/bc-mcp/src/services/lookup-service.ts",
    "U:/Git/bc-mcp/src/operations/lookup.ts",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI/EditLogicalControl.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/ClientEditLogicalControl.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/EditLogicalControlSerializer.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Framework.UI/Microsoft.Dynamics.Framework.UI.Client/SystemAction.cs"
  ],
  "searches_performed": [],
  "confidence": "high"
}
```

Note: I did not read `wire-types.ts`, `RepeaterColumnControlSerializer.cs`, `EditLogicalControlObserver.cs`, `form-tree-mutator.ts`, or `lookup.tool.ts`; claims about those are flagged as unverified above. I also read `EditLogicalControl.cs` only from line 250 onward (which contained both cited members).