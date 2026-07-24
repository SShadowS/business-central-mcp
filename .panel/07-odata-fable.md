## Adversarial review: OData Writes design

### 1. Claims about the existing codebase

- **"`ODataClient` exposes exactly one verb: `query` over a GET-only `_fetch`"** — TRUE. `query` at src/odata/odata-client.ts:150, `_fetch` at :220 does a bare `fetch` with only `Authorization`/`Accept` headers, no method/body support (odata-client.ts:220–235). The spec's cited line numbers (:145, :220) are approximately right (query's doc comment starts ~:140, `_fetch` at :220). Confidence: high.
- **`bc_query` is read-only** — TRUE (src/operations/query.ts, pure pass-through to `client.query`). Confidence: high.
- One inaccuracy the spec should have caught: **`query` special-cases the `companies` entity** (odata-client.ts:164–170) and validates entity names against `/^[A-Za-z][A-Za-z0-9_]*$/` (:159). The write design must replicate both (block or special-case writes to `companies` — `CompanyTableDataProvider.cs:166–182` throws `InsertCompanyNotSupported`/`ModifyCompanyNotSupported`/`BoundActionNotSupported` for all mutations) — the spec is silent on this. Confidence: high.

### 2. Claims about BC protocol behaviour

- **`Microsoft.NAV` namespace for `/api` bound actions** — CONFIRMED: `VocabularyAnnotationFactory.cs:14` `private const string ApiNamespace = "Microsoft.NAV"`. **Plain `NAV` for `/ODataV4`** — CONFIRMED: `NavODataV4V1CachedModelBuilder.cs:21` `DefaultNamespace = "NAV"`. The spec's verification gate is a sensible extra check. Confidence: high.
- **ETag exclusions** — CONFIRMED: `NavEdmModelAddEntitiesStrategy.cs:79–88` emits `ETagExcludesNonEditableFlowFields` / `ETagExcludesFieldsOutsideRepeater` annotations from `IMetaPage`. Confidence: high.
- **`ExpectedParameterBoundAction` → 400** — CONFIRMED: `CodeunitInvocationHelper.cs:86` throws `NavODataBadRequestException(...ExpectedParameterBoundAction...)`. Confidence: high.
- **`InvokeBoundAction` exists** — CONFIRMED at `GenericODataController.cs:379–422`. Note what the spec does NOT say: void-returning actions (the common case, e.g. `post`) return **204 No Content** (`GenericODataController.cs:405–412`). The spec's `invokeBoundAction(): Promise<unknown>` and integration test 14 ("assert a non-error result") gloss over the 204-vs-200 split.
- **Insert response** — `InsertItem` returns **201 Created** with the entity by default; `Prefer: return=no-content` flips it to 204 with `Preference-Applied` (`GenericODataController.cs:344–375`, `PrefersNoContentReturn`). So the spec's claim that `Prefer: return=representation` is what gets you the body is subtly wrong: representation is the **default**; sending the header is harmless but the design should assert on 201, not 200. `ModifyItem` (`:455–470`) always returns the entity. Minor but the unit tests as written encode a slightly wrong mental model. Confidence: high on the decompiled behaviour.

### 3. Design soundness

- **Single tool with `operation` discriminant**: sound. Four near-identical tools would bloat the tool list and the discriminant + Zod refinement gives better error messages. Agree.
- **URL construction**: company-scoped `companies({id})/{entity}({key})` matches the existing query path. But **key formatting is completely unspecified**. `key?: string` — is it inserted raw? Then:
  - GUID keys (Standard API v2.0 `id`) go unquoted — fine.
  - String/Code keys (any custom API, and the spec explicitly says custom APIs are "configuration, not code") need `'...'` quoting with embedded `''` escaping.
  - Composite keys need `Name=value,Name2=value2` syntax.
  - A raw key string is also a **URL injection vector** — the entity name is regex-guarded (odata-client.ts:159) but nothing guards the key. The spec doesn't mention any of this. This is the single biggest design hole.
- **`etag` per row in `bc_query`**: reasonable, but `@odata.etag` may be absent when `$select` is used depending on BC's behaviour — the spec doesn't say what happens then, and rows are `unknown[]` passed through, so "gains etag" implies row-shape mutation not designed.

### 4. Missed failure modes

1. **Key quoting/escaping/composite keys** — see above. Missed entirely.
2. **Timeout**: the client default is 30 s (odata-client.ts:78). Posting an invoice via a bound action or a PATCH that triggers heavy AL can easily exceed that. No per-operation timeout override in the design; a timeout mid-write is also **not idempotent** (the write may have committed) — no guidance at all.
3. **`company` override on writes**: `_resolveCompanyByName` (odata-client.ts:195) re-fetches `/companies` on every call and never caches; also, staleness of the cached default company id across company rename/recreate isn't addressed for writes, where hitting the wrong company is destructive.
4. **Writes to `companies` / entities with no data provider support** — must be guarded or mapped from `NavODataNotImplementedException` (likely 501, which the error table doesn't map at all — it jumps from 412 to 5xx; 501 would land in `ODATA_SERVER_ERROR`, misleading the caller into thinking BC is broken).
5. **204 vs 200/201**: `_request` returns `body: T | undefined` so it's representable, but the tool output shape `{ row? }` for a bound action that returns 204 vs a scalar vs an entity isn't specified.
6. **BC errors inside 200**: I found no evidence of this outside `$batch` in the decompiled controller — since `$batch` is out of scope, this is a non-issue, and I'd push back on the reviewer prompt here.
7. **Permission/licence errors**: `NavPermissionException` exists (`GenericODataController.cs:575`, restricted S2S apps). The spec's 401/403 row says "distinguish by BC code" but names no codes and adds no test. Weak, not wrong.
8. **Deep-insert / parent-scoped entities** (e.g. `salesInvoiceLines` need the parent id in the body or a nested path) — unaddressed; a flat `companies({id})/salesInvoiceLines` POST fails without `documentId`. Arguably caller's problem, but the tool description should say so.

### 5. Test plan

Decent unit coverage; the byte-identical `query` regression lock (test 9) is the right move. Holes:
- No test for **string/composite key formatting** (consistent with the design hole).
- No test for **bound action returning 204** (void action) — test 14's "non-error result" is too weak.
- No test for **missing action parameter → 400** despite citing that exact BC behaviour as evidence.
- No test for the **`company` override** on any write.
- Test 16 (invalid create) has no assertion that nothing was created — on a destructive CRONUS run, half-created records poison later runs. "Must clean up even on failure" is asserted for 11–15 but delete requires an etag/key that a failed step may not have; cleanup should be a filter-based query + delete in `afterAll`, which the spec doesn't design.
- 201 vs 200 assertion for create (see §2).

### 6. Scope

- **No `$batch`**: correct call; the per-item error surface is real (multipart/JSON batch bodies with per-part statuses).
- **No filter-based delete**: correct and well-argued.
- **No upsert**: correct; BC's PUT/PATCH-on-missing behaviour does vary and the claim is plausible (not verified in decompiled source — stated as unverified).
- Excluding unbound actions is fine but note `InvokeUnboundAction` exists (`GenericODataController.cs:425`) and would be the natural next spec.

### Top 3 concerns

1. **Key formatting/quoting/escaping/composite keys is entirely unspecified and is an injection vector** — the one place URL construction can actually go wrong, and it's a blank.
2. **Timeout vs. long-running AL on writes**: 30 s default, no override, no guidance on non-idempotent timeout ambiguity (did the post commit?).
3. **Response-status model is slightly wrong** (201 for create, 204 for void bound actions, PATCH always returning the entity, unmapped 501) — the unit tests as written would lock in the wrong expectations.

```json evidence
{
  "files_checked": [
    "U:/Git/bc-mcp/docs/superpowers/specs/2026-07-24-odata-writes-design.md",
    "U:/Git/bc-mcp/src/odata/odata-client.ts",
    "U:/Git/bc-mcp/src/operations/query.ts",
    "U:/Git/bc-mcp/src/core/errors.ts",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4/GenericODataController.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4/VocabularyAnnotationFactory.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4.Modeling/NavEdmModelAddEntitiesStrategy.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4/CodeunitInvocationHelper.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4/NavODataV4V1CachedModelBuilder.cs",
    "U:/Git/bc-mcp/reference/bc28/decompiled/Microsoft.Dynamics.Nav.Service.OData.V4/Microsoft.Dynamics.Nav.Service.OData.V4/CompanyTableDataProvider.cs"
  ],
  "searches_performed": [],
  "confidence": "high"
}
```

Note: I did not open `query.tool.ts`, `error-classifier.ts`, `CLAUDE.md`, or the gap-analysis index — the review's code claims stand on the files listed above. The upsert-variability claim and 401-vs-403 BC codes remain unverified against source.