# OData Writes — Design

**Date:** 2026-07-24
**Size:** L
**Build order:** 7 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/odata-writes`

## Problem

`ODataClient` exposes exactly one verb: `query`, implemented over a private `_fetch` that only
does GET (`src/odata/odata-client.ts:145`, `:220`). `bc_query` is therefore read-only
(`src/operations/query.ts`).

Every mutation has to go through the page protocol: open a page, select a row, write fields one
SaveValue at a time, wait for validation echoes, close. That is correct and fully validated, and
it is the right path for anything a human would do through the UI. It is the wrong path for
"create 200 customers from this list" or "post these 40 invoices" — dozens of round trips per
record, each carrying full form state.

## Evidence

| Claim | Source |
|---|---|
| Bound actions are a first-class OData feature in BC | `Microsoft.Dynamics.Nav.Service.OData.V4/GenericODataController.cs:380` — `InvokeBoundAction`; supporting path work at `:641`, `:698`, `:720` |
| Entities can refuse bound actions | `CompanyTableDataProvider.cs:176` throws `BoundActionNotSupported` |
| Missing action parameters are a specific 400 | `CodeunitInvocationHelper.cs:86` — `ExpectedParameterBoundAction` |
| ETags are modelled per entity with BC-specific exclusions | `Modeling/NavEdmModelAddEntitiesStrategy.cs:80-86` — `ETagExcludesNonEditableFlowFields`, `ETagExcludesFieldsOutsideRepeater` |
| API namespace for bound actions is `Microsoft.NAV` | `VocabularyAnnotationFactory.cs:14` — `ApiNamespace = "Microsoft.NAV"` (the `/odata/v4` endpoint uses the plain `NAV` namespace, `NavODataV4V1CachedModelBuilder.cs:21`) |

### Verification gate

Confirm the bound-action URL shape against the live Cronus28 `$metadata` for
`/api/v2.0`: fetch `{odataUrl}/api/v2.0/$metadata`, find an `<Action>` element with
`IsBound="true"` (e.g. on `salesInvoice`), and record its namespace-qualified name. The design
assumes `POST {entitySet}({id})/Microsoft.NAV.{action}`; the gate either confirms it or supplies
the real shape. Cheap, decisive, and it also tells us which entities in this environment actually
expose actions.

## Design

### One request pipeline

`ODataClient` currently has a GET-only `_fetch`. Replace it with a single `_request` that all
verbs share — method, headers, body, and error mapping in one place, so a fix to error handling
cannot apply to three verbs and miss the fourth:

```ts
private async _request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts?: { body?: unknown; etag?: string; preferRepresentation?: boolean },
): Promise<{ status: number; body: T | undefined; etag?: string }>;
```

`query` is refactored onto it with no behaviour change (its tests are the regression lock).

New public methods, thin wrappers around `_request`:

```ts
create(entity, body, opts?): Promise<ODataEntity>;
update(entity, key, body, etag, opts?): Promise<ODataEntity>;
remove(entity, key, etag, opts?): Promise<void>;
invokeBoundAction(entity, key, action, parameters?, opts?): Promise<unknown>;
```

### ETag policy

BC computes ETags per entity with configurable field exclusions
(`NavEdmModelAddEntitiesStrategy.cs:80-86`), so an ETag is genuinely the concurrency token and not
a formality.

- `update` and `remove` **require** an `etag` argument. There is no default.
- `etag: '*'` is accepted as an explicit "I know, overwrite anyway" and is logged at `warn`.
  Refusing `*` outright would push callers into read-then-write races anyway; making it explicit
  and noisy is the honest trade.
- `bc_query` output gains the per-row `@odata.etag` value as `etag`, so the read that precedes a
  write hands over the token naturally.
- A 412 maps to a dedicated `StaleETagError` (code `STALE_ETAG`) whose message tells the caller to
  re-read and retry — mirroring the existing `STALE_CONTEXT` guard on the page path, so the LLM
  meets one concurrency concept, not two.

### Tool surface

One tool, not four. The LLM picks a verb via a discriminant rather than choosing between four
similarly-named tools:

```
bc_odata_write {
  entity: string,
  operation: 'create' | 'update' | 'delete' | 'action',
  key?: string,                  // required for update | delete | action
  body?: Record<string, unknown>,// required for create | update
  etag?: string,                 // required for update | delete
  action?: string,               // required for operation='action'
  parameters?: Record<string, unknown>,
  company?: string,
}
```

Zod validation enforces the per-operation requirements before anything leaves the process, and
each error names the missing field and the operation that needs it.

Output: `{ operation, entity, key?, row?, etag? }`. `create` and `update` send
`Prefer: return=representation` so the caller gets the server's version (BC fills computed fields,
No. Series values, and the new ETag) without a follow-up GET.

### Deliberate limits

- **No filter-based bulk delete.** Delete takes a single key. A `filter` parameter on a destructive
  verb is a foot-gun that an LLM will eventually pull; a caller that wants ten deletes issues ten
  calls and sees ten results.
- **No batch endpoint.** `$batch` would help throughput but doubles the error-mapping surface
  (per-item failures inside a 200 response). Revisit only if measured throughput demands it.
- **No upsert.** BC's PATCH-on-missing-key behaviour varies by entity; explicit create-or-update
  belongs to the caller.

### Error mapping

BC returns a structured `error: { code, message }` body. Map by status, and keep the BC code:

| Status | Error | Note |
|---|---|---|
| 400 | `BusinessValidationError` | The BC code and message pass through verbatim — these are AL validation failures and the text is the useful part |
| 401 / 403 | `ODataError` code `ODATA_FORBIDDEN` | Distinguish auth failure from permission failure by the BC code |
| 404 | `ODataError` code `ODATA_NOT_FOUND` | Message names entity and key |
| 409 | `ODataError` code `ODATA_CONFLICT` | |
| 412 | `StaleETagError` | Re-read guidance in the message |
| 5xx | `ODataError` code `ODATA_SERVER_ERROR` | |

The existing `classifyBusinessError` handles the page protocol's event-shaped errors; this is its
HTTP-shaped sibling and lives in `src/odata/odata-error-mapper.ts` as a pure function over
`(status, body)` so every case is unit-testable without a network.

### Safety posture

These calls commit immediately with no dialog and no undo. Three mitigations, all of which are
cheap and none of which are a confirmation prompt (the MCP layer has no user to prompt):

1. `operation` is explicit — there is no way to delete by omitting a parameter.
2. Every write is logged at `info` with entity, operation, and key before the request is sent.
3. The tool description states plainly that writes bypass the UI's dialogs and confirmations, and
   that page-protocol tools remain the right choice for anything a human would review.

## Files touched

```
new   src/odata/odata-error-mapper.ts
new   src/operations/odata-write.ts
new   src/operations/odata-write.tool.ts
edit  src/odata/odata-client.ts        (_request pipeline; create/update/remove/invokeBoundAction)
edit  src/operations/query.ts          (surface etag per row)
edit  src/core/errors.ts               (StaleETagError)
edit  src/mcp/tool-registry.ts         (register bc_odata_write)
```

## Test plan (TDD order)

**Unit — mocked fetch, write first:**

1. `create` POSTs to `{base}/companies({id})/{entity}` with a JSON body and
   `Prefer: return=representation`.
2. `update` PATCHes to `{entity}({key})` with `If-Match: <etag>`.
3. `remove` DELETEs with `If-Match` and returns void on 204.
4. `invokeBoundAction` POSTs to `{entity}({key})/Microsoft.NAV.{action}` with the parameters body.
5. `update` without an etag is rejected before any fetch (spy: fetch not called).
6. `etag: '*'` is allowed and emits a warn-level log.
7. Error mapper: 412 -> `StaleETagError`; 400 with a BC code -> `BusinessValidationError` carrying
   that code; 404 -> message naming entity and key; 500 -> `ODATA_SERVER_ERROR`.
8. Zod: `operation: 'update'` without `key` / without `body` / without `etag` each produce a
   distinct message naming the field.
9. `query` behaviour is byte-identical after the `_request` refactor (existing tests unchanged).
10. `query` output exposes `etag` per row when BC returns `@odata.etag`.

**Integration — Cronus28, destructive:**

11. Create a customer with a minimal body; assert an id and etag come back.
12. Patch that customer's name with the returned etag; assert the response reflects it.
13. Patch again with the **stale** etag; assert `STALE_ETAG`.
14. Bound action against the entity found by the verification gate; assert a non-error result.
15. Delete the customer with its current etag; assert a follow-up `bc_query` cannot find it.
16. Create with an invalid body (bad enum value) -> `BusinessValidationError` carrying BC's text.

Tests 11-15 form one ordered lifecycle over a single throwaway record and must clean up after
themselves even on failure.

## Definition of done

- Verification gate closed, bound-action shape recorded.
- Unit + integration green; existing `bc_query` tests untouched and passing.
- `npx tsc --noEmit` clean.
- CLAUDE.md gains an "OData Write Protocol" section: verbs, ETag rules, when to prefer the page
  protocol instead.

## Out of scope

- `$batch`, filter-based bulk operations, upsert (see Deliberate limits).
- Unbound actions / codeunit web services (`/ODataV4/{codeunit}_{method}`).
- Custom API pages beyond Standard API v2.0. The client takes an entity name; a custom API just
  needs a different base URL, which is configuration, not code.
