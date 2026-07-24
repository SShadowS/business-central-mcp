# OData Writes — Design

**Date:** 2026-07-24
**Revised:** 2026-07-24 after two-model adversarial review (see `.panel/07-odata-*.md`)
**Size:** L
**Build order:** 7 of 7 (see [gap analysis](2026-07-24-mcp-gap-analysis.md))
**Branch:** `feat/odata-writes`

## Problem

`ODataClient` exposes one entity verb: `query` (`src/odata/odata-client.ts:145`) over a GET-only
`_fetch` (`:220`). `bc_query` is read-only.

Every mutation therefore goes through the page protocol — correct for anything a human would review,
wrong for "create 200 customers" or "update 300 item prices", which cost dozens of stateful round
trips per record.

## Evidence

| Claim | Source | Status |
|---|---|---|
| Bound actions are dispatched by the generic controller | `GenericODataController.cs:379-423`; response construction `:609-720` | Verified |
| Some entities reject bound actions | `CompanyTableDataProvider.cs:171-181` — `BoundActionNotSupported` | Verified |
| Missing action parameters are a specific 400 | `CodeunitInvocationHelper.cs:76-88` | Verified |
| ETag exclusions are real page metadata | `NavEdmModelAddEntitiesStrategy.cs:80-86`; `NavODataV4EntityTypeAnnotation.cs:14-31` | Verified |
| **PATCH always requires a concurrency token** | `PageDataProvider.ModifyAsync` calls `EnsureConcurrenyTokenSpecified` unconditionally (`:646-675`); a missing/malformed token is a 400 `BadRequest_InvalidToken` (`:1068-1091`) | Verified |
| DELETE and bound actions check the ETag **only when supplied** | `PageDataProvider` (delete / action paths) | Verified — requiring one is our stricter policy, not BC's rule |
| `If-Match: *` is accepted | `ETag.IsAny` | Verified |
| **A stale ETag is 409, not 412** | `NavODataConflictException` → BC code `Request_EntityChanged` (`ExceptionExtensions.cs:103-104`) → `HttpStatusCode.Conflict` (`:186-187`) | Verified. Corrects the first draft |
| Not every 409 is staleness | `BaseExceptionFilter.cs:53-77` also maps duplicate keys, admin changes, and transient DB errors to 409 | Verified |
| Errors serialise as `{error:{code,message}}` | `HttpRequestExtensions.CreateErrorActionResult` `:33-67`, `:367-376` | Verified |
| Status codes vary by operation | Create `201` (or `204` with `Prefer: return-no-content`) `GenericODataController.cs:345-376`; PATCH `200` `:449-466`; DELETE `204` `:118-132`; actions `204` / primitive `200` / status + `Location` `:379-423`, `:609-720` | Verified |
| `Prefer: return=representation` is not explicitly handled | `HttpRequestExtensions.cs:207-218` detects only `return-no-content`; representation is simply the default | Verified — do not depend on the header |
| ~~`Microsoft.NAV` is the bound-action namespace, per `VocabularyAnnotationFactory.cs:14`~~ | **RETRACTED.** That constant is for vocabulary *terms* (`AllowEdit`, `ETagExcludes...`). The action namespace comes from `navEdmModel.NamespaceName` (`NavEdmModelAddEntitiesStrategy.cs:111-132`); the plain V4 model uses `NAV` (`NavODataV4V1CachedModelBuilder.cs:19-21,76`) | Corrected — see Gate 1 |

### Gate 1 — bound-action namespace

Fetch `{odataUrl}/api/v2.0/$metadata`, find an `<Action IsBound="true">`, record its
namespace-qualified name, and record which entities in this environment expose actions at all. The
implementation reads the qualified name from metadata rather than hard-coding a guess.

## Design

### One request pipeline

Replace the GET-only `_fetch` with a shared `_request`:

```ts
private async _request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts?: { body?: unknown; etag?: string },
): Promise<{ status: number; body: T | undefined; etag?: string; location?: string }>;
```

It must **not** call `response.json()` on an empty 2xx, must preserve `status`, the response `ETag`
header, the body's `@odata.etag`, and `Location`. `query` is refactored onto it; its tests are the
regression lock — though "existing tests unchanged" is not a goal, since the current mocks model
only `ok` / `status` / `json` (`tests/unit/odata-client.test.ts`) and now need headers and empty
bodies.

Public methods:

```ts
create(entity, body, opts?): Promise<WriteResult>;
update(entity, key, body, etag, opts?): Promise<WriteResult>;
remove(entity, key, etag, opts?): Promise<WriteResult>;
invokeBoundAction(entity, key, action, parameters?, opts?): Promise<WriteResult>;
```

`WriteResult` is a union over the real response shapes, not a forced entity:

```ts
type WriteResult =
  | { kind: 'entity'; status: number; row: Record<string, unknown>; etag?: string; location?: string }
  | { kind: 'empty';  status: number }
  | { kind: 'value';  status: number; value: unknown };   // primitive action results
```

### Keys — GUID-only, enforced

`key: string` interpolated into `entity(${key})` is unsafe: OData keys are typed, string keys need
quoting and doubled apostrophes (`O''Brien`), and composite keys need named components
(`Key1='A',Key2=42`). BC's model supports multiple keys
(`NavEdmModelAddEntitiesStrategy.cs:66-76`, `DataProvider.cs:65-111`).

This spec takes the honest narrow scope: **Standard API v2.0, `systemId` GUID keys only.** `key` is
validated as a UUID and anything else is rejected with a message saying so. Typed and composite
keys are a follow-up that must be metadata-driven, not string interpolation. `entity` and `action`
are validated as path identifiers to block segment injection.

### Company — explicit for writes

The read client caches a default company and silently falls back to the **first** company when none
is configured (`odata-client.ts:121-128`), while a per-call `company` deliberately bypasses the
cache and re-resolves (`:157-161`, `:195-213`).

For writes that fallback is unacceptable. A write requires **one** of: a configured default company,
an explicit `company` argument, or exactly one accessible company. Otherwise it errors before
sending. Writes never mutate the read cache.

Mutations against the top-level `companies` set are rejected outright.

### Error mapping — status **and** BC code

`src/odata/odata-error-mapper.ts`, a pure function over `(status, body, headers)`:

| Condition | Result |
|---|---|
| 409 + `Request_EntityChanged` | `StaleETagError` (`STALE_ETAG`), message says re-read and retry |
| 409, other codes (duplicate key, transient) | `ODATA_CONFLICT`, code preserved |
| 412 | `StaleETagError` — kept as a cross-version / proxy fallback, not the primary trigger |
| 400 + a validation code family (`Application_FieldValidationException`, …) | `BusinessValidationError`, BC text verbatim |
| 400, other codes (invalid token, malformed body, unsupported op) | `ODATA_BAD_REQUEST` |
| 401 | `ODATA_UNAUTHORIZED` |
| 403 | `ODATA_FORBIDDEN` (permissions, entitlement, licence) |
| 404 | `ODATA_NOT_FOUND`, names entity + key |
| 405 / 501 | `ODATA_UNSUPPORTED` — the entity does not support this write or action |
| 408 / 429 / 503 | `ODATA_RETRYABLE`, surfacing `Retry-After` |
| 5xx | `ODATA_SERVER_ERROR` |
| Non-JSON body (proxy / SignIn HTML) | `ODATA_UNEXPECTED_RESPONSE` |

"All 400 = validation" was materially over-broad; BC uses 400 for invalid ETags, malformed models,
and bad filters too (`ExceptionExtensions.cs:18-158`, `:160-230`).

### Indeterminate outcomes

The client aborts at 30 s (`odata-client.ts:70`, `:228`). A create or bound action can commit and
then time out before the response arrives. So:

- A separate, longer `BC_ODATA_WRITE_TIMEOUT` (default 120 s).
- **No automatic retry** of POST / PATCH / DELETE / action, ever.
- Timeout or connection loss produces `ODATA_OUTCOME_UNKNOWN`, stating the write may have committed
  and must be verified before retrying.
- Every write logs entity, operation, key, and a correlation id **before** the request and again on
  completion — logging only the attempt is not auditing when the outcome is unknown.

### Bound actions and ETags

BC compares an action's ETag when one is supplied. A posting action can otherwise act on a record
that changed since the caller read it. `operation: 'action'` therefore **requires** `etag` (or an
explicit `'*'`, logged at warn), same as update and delete.

### Tool surface

One tool, but a genuine discriminated union so the model sees per-operation required fields in the
JSON Schema rather than a flat bag of optionals:

```ts
z.discriminatedUnion('operation', [CreateSchema, UpdateSchema, DeleteSchema, ActionSchema])
```

```
bc_odata_write {
  operation: 'create' | 'update' | 'delete' | 'action',
  entity, company?,
  body?      // create, update
  key?       // update, delete, action  (UUID)
  etag?      // update, delete, action
  action?, parameters?   // action
}
```

`bc_query` output gains a per-row `etag` extracted from `@odata.etag`, as an explicit DTO
(`{ row, etag? }`) rather than a sibling field that could collide with a real `etag` property —
and the spec no longer claims query output is unchanged, because it is not.

### Safety posture

Writes commit immediately, with no dialog and no undo, and the MCP layer has no user to prompt. So:
explicit `operation`, mandatory company selection, mandatory ETag on every record-scoped mutation,
correlation-id logging on both sides of the request, and a tool description that says plainly these
calls bypass the UI's validation dialogs and that page-protocol tools remain correct for anything a
human would review.

## Files touched

```
new   src/odata/odata-error-mapper.ts
new   src/operations/odata-write.ts
new   src/operations/odata-write.tool.ts
edit  src/odata/odata-client.ts        (_request; create/update/remove/invokeBoundAction; write
                                        company policy; write timeout)
edit  src/operations/query.ts          (per-row { row, etag } DTO)
edit  src/core/errors.ts               (StaleETagError, OutcomeUnknownError)
edit  src/mcp/schemas.ts               (discriminated union schema)
edit  src/mcp/tool-registry.ts         (Operations interface + registration)
edit  src/core/config.ts               (BC_ODATA_WRITE_TIMEOUT)
```

## Test plan (TDD order)

**Unit (mocked fetch):**

1. `create` POSTs to `{base}/companies({id})/{entity}` with JSON body and auth/tenant headers.
2. `update` PATCHes `{entity}({key})` with `If-Match`.
3. `remove` DELETEs with `If-Match`, returns `kind: 'empty'` on 204.
4. `invokeBoundAction` POSTs the metadata-derived qualified action name.
5. `update` / `remove` / `action` without an etag rejected before any fetch.
6. `etag: '*'` allowed, emits a warn log.
7. Non-UUID `key` rejected with a message naming the limitation.
8. Injection attempts in `entity` / `action` rejected.
9. Mutation against `companies` rejected.
10. No configured company + multiple companies → rejected before sending; explicit `company` uses
    the override path and does not corrupt the read cache.
11. `201` with body → `kind: 'entity'`; `204` → `kind: 'empty'`; primitive JSON → `kind: 'value'`;
    `Location` and response-header ETag preserved; weak ETags (`W/"..."`) passed through verbatim.
12. Error mapper: 409 + `Request_EntityChanged` → `STALE_ETAG`; 409 duplicate key → `ODATA_CONFLICT`;
    412 → `STALE_ETAG`; 400 invalid token vs 400 validation → different codes; 403; 404; 405; 429
    with `Retry-After`; 500; HTML body → `ODATA_UNEXPECTED_RESPONSE`.
13. Timeout → `ODATA_OUTCOME_UNKNOWN`, and no retry is attempted for any write verb.
14. Schema: each operation's missing required field produces a distinct message.
15. `query` exposes `etag` per row; rows without `@odata.etag` omit it.

**Integration — Cronus28, destructive, one test with `try/finally`:**

The lifecycle runs as a **single** test around a unique marker string generated before creation, so
a mid-way failure cannot cascade into the next test and cleanup can find leftovers by querying the
marker and deleting with `*` if necessary. Cleanup must work even when create's response was lost.

16. Create a customer carrying the marker → id + etag returned, status recorded.
17. PATCH the name with that etag → response reflects it; record the actual status.
18. PATCH again with the **stale** etag → assert `STALE_ETAG` **and** record the live status/code
    (expected 409 / `Request_EntityChanged`).
19. Bound action against the entity found by Gate 1 — on a record created for the test, not a shared
    CRONUS document.
20. DELETE with the current etag; a follow-up query cannot find the marker.
21. Create with an invalid enum value → `BusinessValidationError` carrying BC's text.
22. A write against an entity that does not support it → `ODATA_UNSUPPORTED`.
23. Confirm live whether `Prefer: return=representation` changes anything on this endpoint.

## Definition of done

- Gate 1 closed; the qualified action name is read from metadata, not hard-coded.
- Unit + integration green; `bc_query` tests updated for the new row DTO.
- `npx tsc --noEmit` clean.
- CLAUDE.md gains an "OData Write Protocol" section: verbs, GUID-key limitation, 409/`Request_EntityChanged`
  staleness, the company policy, and when to prefer the page protocol.

## Out of scope

- `$batch`. Deferred — but the throughput claim is tempered accordingly: without it, 200 creates
  are still 200 calls. This is a latency improvement per record, not a bulk endpoint.
- Filter-based bulk delete, upsert, unbound / codeunit actions.
- Typed and composite keys (see the key decision above).
- **Custom APIs.** The first draft called these "configuration, not code" — wrong: `baseApiUrl`
  hard-codes `/api/v2.0` at `odata-client.ts:68`, and custom APIs use publisher/group/version
  segments. Supporting them needs a configurable API root, which is its own change.
