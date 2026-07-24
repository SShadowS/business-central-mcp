## Overall verdict

**Needs substantial revision before implementation.** The basic idea—adding writes through a shared HTTP pipeline—is reasonable, but the specification has one protocol-critical factual error, an underspecified key/URL model, and several unsafe assumptions about response handling and destructive operations.

I did **not** inspect live Cronus28 `$metadata` or execute requests. The namespace conclusion therefore remains unverified against the live endpoint.

## 1. Existing-code claims

### `ODataClient` is GET-only

**Verdict: substantially accurate. Confidence: almost certain.**

- `ODataClient.query` begins at `src/odata/odata-client.ts:145`.
- Its network path is `_fetch` at approximately `src/odata/odata-client.ts:220`, and `fetch` is called without a `method`, so it is GET-only.
- `src/operations/query.ts:35-65` only calls `client.query`.

The wording “exposes exactly one verb” is slightly imprecise because `resolveCompanyId()` is also public, but there is only one public entity operation and no mutation support.

### Existing company behavior

**Verdict: the spec fails to account for important existing behavior. Confidence: almost certain.**

The client has two distinct resolution paths:

- Default company resolution is cached for the lifetime of the client: `odata-client.ts:60-100`.
- A per-query `company` override deliberately bypasses that cache and re-fetches companies: `odata-client.ts:157-161`, `:195-213`.

The write design includes a `company` field but does not state whether writes use the override path, mutate the default cache, or introduce a name-to-ID cache. Tests do not cover it.

More importantly, when no default company is configured, the current client silently chooses the first company (`odata-client.ts:121-128`). That is tolerable for reads but a poor default for destructive writes. I would require either:

1. an explicitly configured write company,
2. an explicit tool `company`, or
3. exactly one accessible company.

Silently writing to “the first” company is unsafe.

### “Query behavior byte-identical” versus adding `etag`

**Verdict: internally contradictory. Confidence: high.**

Rows are currently passed through unchanged (`odata-client.ts:185-192`; `query.ts:49-57`). BC already returns `@odata.etag` inside entity JSON. “Expose `@odata.etag` as `etag`” necessarily changes row shape unless it merely documents the existing annotation.

Adding a sibling `etag` field also risks colliding with a real API property named `etag`. The spec needs an exact DTO, for example:

```ts
{ row: Record<string, unknown>; etag?: string }
```

or it should preserve `@odata.etag` unchanged. It cannot both change this and promise byte-identical output.

## 2. Decompiled BC28 protocol claims

### Bound actions exist and can be rejected

**Verdict: accurate, but some cited line precision is weak. Confidence: almost certain.**

- `GenericODataController.InvokeBoundAction` dispatches the final `OperationSegment` through the data provider: `GenericODataController.cs:379-423`.
- Bound-action results can be `204`, primitive `200`, or a status plus `Location`, depending on the AL return type and `WebServiceActionContext`: `GenericODataController.cs:390-419`, `:609-720`.
- `CompanyTableDataProvider.InvokeAsync` rejects bound actions with `BoundActionNotSupported`: approximately `CompanyTableDataProvider.cs:171-181`. The spec’s single-line citation `:176` does not appear to be the actual throw line, although the substantive claim is correct.
- Missing parameters produce `NavODataBadRequestException(ExpectedParameterBoundAction, parameter.Name)`: `CodeunitInvocationHelper.cs:76-88`.

### Bound-action namespace is `Microsoft.NAV`

**Verdict: likely true for Standard API v2.0, but not proved by the cited source. Confidence: medium.**

This evidence is invalid:

- `VocabularyAnnotationFactory.cs:14` defines `ApiNamespace = "Microsoft.NAV"` for vocabulary terms such as `AllowEdit` and `ETagExcludes...`.
- It does **not** determine the namespace used when constructing actions.

The action namespace comes from `navEdmModel.NamespaceName`:

- `NavEdmModelAddEntitiesStrategy.cs:111-132` creates `new EdmAction(navEdmModel.NamespaceName, action.Name, ...)`.

For the plain OData V4 model, `NavODataV4V1CachedModelBuilder.cs:19-21` and `:76` establish `NAV`, which supports the spec’s plain-endpoint distinction. But none of the Standard API model-builder files I successfully opened establishes that its `NamespaceName` is `Microsoft.NAV`.

Therefore:

- The verification gate against `/api/v2.0/$metadata` is necessary and well chosen.
- The evidence table must not present `VocabularyAnnotationFactory` as proof of the action namespace.
- The implementation should derive or validate the qualified action name from metadata rather than permanently hard-code an assumption if practical.

### ETag exclusions and concurrency

**Verdict: exclusions are real; the status mapping is wrong. Confidence: almost certain.**

The exclusions are real page metadata:

- `NavEdmModelAddEntitiesStrategy.cs:80-86` emits `ETagExcludesNonEditableFlowFields` and `ETagExcludesFieldsOutsideRepeater`.
- `NavODataV4EntityTypeAnnotation.cs:14-31` carries those flags into the entity annotation.
- `PageDataProvider` computes and compares an ETag from `GetValuesForEtag(...)` during delete, update, media changes, and bound actions.

Important semantics:

- PATCH requires a concurrency token. `ModifyAsync` calls `EnsureConcurrenyTokenSpecified` unconditionally, approximately `PageDataProvider.cs:646-675`.
- Missing or malformed tokens become a 400 `BadRequest_InvalidToken`: `PageDataProvider.cs:1068-1091`.
- `If-Match: *` is accepted through `ETag.IsAny`.
- DELETE and bound actions only check concurrency when an ETag was supplied. Requiring one client-side is a stricter safety policy, not BC server behavior.
- Bound actions compare ETags if present: approximately `PageDataProvider.cs:405-435`.

#### Critical error: stale ETags are 409 in BC28, not 412

A mismatch throws `NavODataConflictException` in `PageDataProvider`. The exception mapping is explicit:

- `ExceptionExtensions.cs:88-94` maps it to BC code `Request_EntityChanged`.
- `ExceptionExtensions.cs:164-172` maps it to HTTP `409 Conflict`.

Therefore the spec’s central mapping:

> `412 -> StaleETagError`

is incorrect for the examined BC28 implementation.

The mapper should identify staleness primarily using BC code `Request_EntityChanged`, with status 409. Supporting 412 as a cross-version/proxy compatibility fallback is reasonable, but 412 must not be the only trigger.

Also, not every 409 is stale. `BaseExceptionFilter.cs:53-77` maps duplicate-key cases, administrator changes, and transient database cases to 409. A status-only `409 -> ODATA_CONFLICT` or `409 -> STALE_ETAG` is insufficient; the BC code matters.

### Error body shape

**Verdict: normal BC OData errors do use the expected shape. Confidence: high.**

`HttpRequestExtensions.CreateErrorActionResult`:

- Gets status from the exception.
- Converts it to an `ODataError` with `ErrorCode` and `Message`.
- Serializes it using `ODataErrorSerializer`.
- Returns `application/json`.

See `HttpRequestExtensions.cs:33-67` and `:367-376`. This supports the usual body:

```json
{
  "error": {
    "code": "...",
    "message": "..."
  }
}
```

The client must still tolerate non-JSON authentication/gateway responses, which the existing `_fetch` already attempts to do.

### Error status classification

**Verdict: the proposed table is materially over-broad. Confidence: high.**

“All 400 responses are `BusinessValidationError`” is wrong. BC uses 400 for many non-business-validation conditions:

- Invalid arguments
- Invalid or missing ETags
- Invalid model/body
- Unsupported operations
- Malformed filters or paths
- Some AL/runtime exceptions

See the code/status dictionaries in `ExceptionExtensions.cs:18-158` and `:160-230`.

Likewise:

- 401 covers credential/token failures.
- 403 covers several permission and entitlement cases: `BaseExceptionFilter.cs:30-89`.
- 405 and 501 are normal outcomes for entities that do not support a write or action.
- 408, 429, and 503 are explicitly possible and missing from the table.
- License/entitlement failures can surface as 401, 403, or other BC runtime errors depending on exception type. They must not be collapsed into validation errors.

The mapper should use both status and BC code. `BusinessValidationError` should be reserved for known validation-code families such as `Application_FieldValidationException`, not every 400.

### Success status and `Prefer`

**Verdict: the spec’s response contract is too rigid. Confidence: high.**

From `GenericODataController.cs`:

- Create normally returns `201 Created` with the entity: `:345-376`.
- Create returns `204` when BC recognizes `Prefer: return-no-content`.
- PATCH returns an entity and therefore normally `200`: `:449-466`.
- DELETE returns `204`: `:118-132`.
- Bound actions may return `204`, primitive `200`, or a status/`Location`: `:379-423`, `:609-720`.

`HttpRequestExtensions.cs:207-218` only explicitly detects `return-no-content`. It does not specifically process `return=representation`; representation is simply the default in this implementation.

Consequences:

- `create(...): Promise<ODataEntity>` and `update(...): Promise<ODataEntity>` are too strong as generic contracts.
- `_request` must parse empty 2xx responses without calling `response.json()`.
- It should preserve `status`, `Location`, response-header `ETag`, and body `@odata.etag`.
- `invokeBoundAction` must preserve primitive bodies and `Location`, not force an entity-shaped output.
- No test currently covers `201`, empty `200`, `202`, `204`, scalar JSON, or `Location`.

I found no decompiled evidence that an ordinary, non-batch request returns a top-level error envelope with HTTP 200. Still, defensively detecting an exact top-level `{ error: { code, message } }` on a 2xx response is reasonable, especially around proxies and legacy behavior. It should be tested and documented as defensive behavior rather than claimed BC28 behavior.

## 3. Tool and URL design

### One discriminated tool versus four tools

**Verdict: acceptable only if implemented as a real discriminated union; not clearly superior. Confidence: medium-high.**

A single tool can work because the operations share entity/company resolution and write safety. But the displayed schema is a flat object with many optional fields, not a true discriminated union.

It should be structurally equivalent to:

```ts
z.discriminatedUnion('operation', [
  CreateSchema,
  UpdateSchema,
  DeleteSchema,
  ActionSchema,
])
```

and the generated MCP JSON Schema should retain `oneOf`/operation-specific required fields. Refinements that only fail after tool invocation are less useful to the model.

There is also a reasonable case for separating bound actions from CRUD:

- Actions have parameter metadata rather than a body.
- They can return primitives, no content, or `Location`.
- They may post documents or cause other irreversible transitions.
- They have different concurrency and timeout semantics.

My preference would be either:

1. `bc_odata_write` for create/update/delete plus `bc_odata_action`, or
2. one genuine discriminated-union tool with operation-specific descriptions and output variants.

Four entirely separate CRUD tools are not necessary.

### Company-scoped Standard API URLs

**Verdict: correct for ordinary Standard API v2.0 entities, but incompletely specified. Confidence: high.**

This base shape is correct:

```text
/api/v2.0/companies(<company-guid>)/<entity>
```

The existing client already uses it at `odata-client.ts:181-183`.

Missing requirements:

- Append `tenant` on every write and action.
- Honor `company` through the override resolution path.
- Reject mutations against top-level `companies`.
- Validate `entity` and `action` as path identifiers.
- Test that an override does not accidentally use the cached default company.
- Decide what happens if a company is renamed or recreated while an ID is cached.

### Key formatting

**Verdict: unsound as specified. Confidence: almost certain.**

A raw `key?: string` interpolated as `entity(${key})` only works safely when the key is already a canonical GUID literal. OData keys are typed:

```text
customers(00000000-0000-0000-0000-000000000000)
entity('string key')
entity(Key1='A',Key2=42)
```

String keys require:

- surrounding quotes,
- doubling embedded apostrophes (`O'Brien` → `'O''Brien'`),
- path-safe encoding,
- protection against `)`, `/`, `?`, `#`, and injected OData segments.

Composite keys require named key components and per-component type formatting. The model itself supports multiple keys:

- `NavEdmModelAddEntitiesStrategy.cs:66-76` adds all entity keys.
- `DataProvider.cs:65-111` processes collections of entity keys.
- Bound-action response construction also compares full key counts: `GenericODataController.cs:641-688`.

The design must choose one of two honest scopes:

1. **Standard API v2.0 GUID-only scope:** validate `key` as UUID and reject everything else.
2. **Generic OData scope:** accept a structured key object and use `$metadata` to serialize strings, GUIDs, numbers, dates, and composites correctly.

The current unconstrained string provides neither safety nor generality.

### Custom API claim

**Verdict: inaccurate. Confidence: almost certain.**

The spec says a custom API “just needs a different base URL, which is configuration, not code.” The current constructor hard-codes `/api/v2.0`:

- `odata-client.ts:68`.

Custom APIs commonly use publisher/group/version path segments. Merely changing `odataUrl` cannot remove the subsequently appended `/api/v2.0`. Supporting them requires a configurable API root or route model, plus potentially different metadata/action namespaces.

## 4. Missed failure modes

### High-severity omissions

1. **Indeterminate outcome after timeout or connection loss. Confidence: almost certain.**

   The current client aborts after 30 seconds (`odata-client.ts:70`, `:228`). A create or bound action can commit in BC and then time out before the response reaches the client. Retrying may duplicate a record or post an action twice.

   The write path needs:
   - independently configurable write/action timeouts,
   - no automatic retries of non-idempotent operations,
   - an explicit “outcome unknown; verify before retrying” error,
   - request/correlation IDs in logs and errors,
   - guidance to re-query using a caller-supplied unique business key.

2. **Bound actions have no ETag policy. Confidence: high.**

   BC checks an action’s ETag if supplied, but the tool does not require one. A posting action can therefore act on a record changed since the caller read it. Require an ETag or explicit `*` for record-bound actions unless metadata/live behavior demonstrates that a particular action rejects `If-Match`.

3. **Wrong company due to implicit first-company selection. Confidence: high.**

   Destructive calls should not inherit the read client’s “first accessible company” fallback without an explicit safety decision.

### Other omissions

- Correct string-key quoting and apostrophe escaping.
- Composite and non-GUID keys.
- Action-name path injection.
- Empty body versus `{}` for parameterless actions.
- `Content-Type: application/json` and charset handling.
- Exact preservation of weak ETags such as `W/"..."`.
- ETags returned only in body annotations versus only in headers.
- `Prefer: return=representation` ignored or no representation returned.
- Create `201`, update `200`, delete/action `204`, scalar action results, and `Location`.
- 405, 408, 415, 429, and 503, including `Retry-After`.
- Duplicate-key 409 versus stale-ETag 409.
- Permission, entitlement, and licence failures.
- HTML/plain-text authentication and reverse-proxy errors.
- Malformed JSON on a 2xx response.
- Exact top-level error envelope on a 2xx response.
- Empty or unchanged PATCH bodies.
- Server-side rename when a key field is patched.
- Actions whose `WebServiceActionContext` deletes or relocates the source record.
- BC throttling and concurrent write limits.
- Logging before a request is not sufficient auditing when the outcome is unknown; completion status and correlation ID must also be logged.
- Create/action requests are not protected by ETag concurrency.
- No explicit behavior for media/navigation properties or deep inserts, even though `PageDataProvider` can process some nested entities.
- Body values such as `undefined`, bigint, dates, circular values, and non-JSON data.
- Response-size limits for representation bodies.

## 5. Test plan

**Verdict: materially incomplete. Confidence: high.**

### Unit-test holes

Add tests for:

- `Authorization`, `Accept`, `Content-Type`, tenant, and method together.
- Default company versus override company.
- Override not using or corrupting the default-company cache.
- Refusal to mutate top-level `companies`.
- GUID keys.
- String keys, apostrophes, spaces, slashes, `)`, `?`, and `#`.
- Composite keys and typed components, or explicit rejection if GUID-only.
- Invalid entity and action identifiers.
- `201` create representation.
- `200` PATCH representation.
- `204` create/update/action with no JSON body.
- Primitive action return values.
- `Location` and response-header ETag.
- `@odata.etag` extraction and collision behavior.
- Weak ETag pass-through.
- 400 invalid token versus 400 validation error.
- BC28 `409 + Request_EntityChanged -> STALE_ETAG`.
- Non-stale 409 duplicate key.
- 401, 403, 404, 405, 408, 415, 429, 500, and 503.
- Non-JSON errors.
- Defensive 2xx error envelope.
- Timeout after the request may have committed.
- No automatic retry of POST/PATCH/DELETE/action.
- `Prefer` not honored.
- Action with required missing parameters and parameterless action.
- Action with `If-Match`.

The existing mocked `Response` objects in `tests/unit/odata-client.test.ts` only model `ok`, `status`, and `json`. A robust `_request` implementation will need headers and empty-body behavior, so “existing tests unchanged” is not a useful requirement.

### Integration-test holes and destructive-test risks

The lifecycle idea is reasonable, but it must be one isolated test or a fixture with a `try/finally`; a sequence of separately ordered tests will cascade after the first failure.

Cleanup must work when:

- create succeeds but the response is lost,
- create returns no body or ID,
- update fails,
- the stale-ETag assertion is wrong,
- the action changes or deletes the source entity.

Use a unique, searchable marker generated before creation. Cleanup should query by that marker and delete all leftovers with explicit wildcard ETags if necessary.

The plan should also test:

- the exact live action namespace from metadata,
- live status/code for stale ETag—expected BC28 result is 409/`Request_EntityChanged`,
- actual create and PATCH response statuses,
- whether `Prefer: return=representation` affects this endpoint,
- company override,
- a restricted user for 403 behavior,
- a no-write entity for 405/501 behavior,
- a long-running action or controlled timeout to establish indeterminate-outcome behavior.

A successful bound action should not casually use a posting action on shared CRONUS records. Create all prerequisites under a unique marker and document cleanup of both source and posted records. “CRONUS is disposable” does not justify tests that become non-repeatable or pollute subsequent assertions.

## 6. Scope decisions

### No filter-based delete

**Verdict: correct. Confidence: high.**

This is a good safety boundary for an LLM-facing tool.

### No upsert

**Verdict: correct. Confidence: high.**

Explicit create/update avoids entity-dependent PATCH-on-missing behavior and makes concurrency intent visible.

### No `$batch`

**Verdict: reasonable for the first implementation. Confidence: high.**

Batching adds multipart parsing, per-operation statuses, content IDs, dependencies, and uncertain partial outcomes. Deferring it is prudent.

However, the original motivation includes creating 200 customers and posting 40 invoices. Without batch or a bounded bulk operation, this still requires 200 or 40 MCP calls. The spec should temper its throughput claims and measure whether HTTP-call overhead remains acceptable.

### No unbound actions

**Verdict: reasonable. Confidence: high.**

Bound Standard API actions and unbound/codeunit services have sufficiently different routing and metadata to justify separate work.

### “Custom APIs are configuration only”

**Verdict: not a valid deliberate limit as written. Confidence: almost certain.**

Either explicitly limit the implementation to Standard API v2.0 or redesign `baseApiUrl` so publisher/group/version API roots are configurable.

## Recommended corrections before implementation

1. Change stale mapping to `409 + Request_EntityChanged`, with optional 412 fallback.
2. Define a safe key model: UUID-only for Standard API v2.0, or metadata-driven structured keys.
3. Define exact per-operation response unions, including status, optional row/value, ETag, and `Location`.
4. Require explicit company selection for writes unless exactly one company exists.
5. Make the input a real discriminated union.
6. Add an ETag policy for bound actions.
7. Add explicit indeterminate-outcome handling for timeout/network failures.
8. Replace status-only error mapping with status-plus-BC-code classification.
9. Correct the namespace evidence and close the `$metadata` gate before hard-coding.
10. Make destructive integration cleanup independent of receiving a successful create response.

## Top 3 concerns

1. **The stale-ETag contract is factually wrong for BC28:** BC throws 409 `Request_EntityChanged`, not 412.
2. **`key: string` makes URL construction unsafe and incorrect** for string, non-GUID, and composite keys.
3. **Timeouts and company selection can cause irreversible writes with unknown outcome or in the wrong company**, and the test plan does not exercise either risk.