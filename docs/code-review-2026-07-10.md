# Codebase Review — 2026-07-10

Branch: `feat/lookup-odata-dims`. Scope: full `src/` tree (~9,600 lines) reviewed by 6 parallel agents split by cohesion: protocol form-tree/state, protocol wire/context, services, session lifecycle, operations+MCP, connection/core/odata/entry.

**Totals: 65 findings — 1 CRITICAL, 9 HIGH, 30 MED, 25 LOW.**

> **Resolution (2026-07-10):** All 10 CRITICAL+HIGH fixed. ~24 MED + 3 LOW fixed (incl. the newly-found OData `companies` scoping bug). Then the 5 deferred items were verified against decompiled BC28 source and resolved: event-decoder now decodes top-level `DataRow*` into a new `RowDelta` event (:51 — CONFIRMED, delta path emits them top-level); form-state applies `RowDelta` insert/update/remove + `currentRowOnly` upsert (:59/:101); section-resolver classifies factbox via `IsSubForm`/`IsPart` on the child `lf` root (:43 — lines set BOTH flags, so factbox = part AND not subform); ntlm-provider rejects the re-rendered login page on bad creds (:52). The init async-handler finding (:89) was a **verified false positive** — the license dialog and all init state arrive synchronously in the OpenSession response, nothing is missed; no change. Verified: `tsc` clean, 692 unit/protocol pass, 149/149 integration pass.

Cross-agent corroboration: the `SessionManager.getSession()` concurrency race was independently reported by both the session-lifecycle and connection/entry agents. High confidence.

Project is pre-release: breaking changes acceptable, no backwards-compat constraints.

---

## CRITICAL

### C1. `bc_execute_action` ignores row targeting — deletes/edits the wrong record
`src/operations/execute-action.ts:65`

`rowIndex`/`bookmark` are accepted by the schema and promised in the tool description ("Delete a row: `{ action: 'Delete', bookmark: ... }`") but never passed to `ActionService.executeAction(pageContextId, action, section)` — there is no row parameter. Row-targeting actions (Delete=20, Edit=40) fire against `{repeaterPath}/cr/c[0]` = whatever row is currently selected, silently mutating the WRONG record.

Fix: resolve `bookmark`/`rowIndex` and `selectRow()` before invoking, or reject the inputs with an explicit error.

---

## HIGH

### H1. Stale auth cookies brick session recovery
`src/connection/auth/ntlm-provider.ts:99`

`authenticated` is set true once and never reset; `ConnectionFactory.create` (`connection-factory.ts:17`) skips re-auth whenever `isAuthenticated()` is true. Every recovery reconnect reuses the original cookies. After BC web-client cookie expiry or a BC service restart, all backoff retries fail identically and the server is permanently bricked until process restart.

Fix: add `invalidate()` to `IBCAuthProvider` (clear cookies/csrfToken/authenticated), call it on WS connect failure — or always re-authenticate when creating a session during recovery.

### H2. `getSession()` concurrency race leaks sessions (reported x2)
`src/session/session-manager.ts:69` (also `server.ts:109`, `stdio-server.ts:114`)

No single-flight guard. Two concurrent callers seeing `session === null` (or dead) each run `createWithBackoff()`, creating two BCSessions/WebSockets. The second assignment overwrites the first, which is never closed — leaks its socket plus a scarce NTLM auth slot. Recovery path also double-clears page contexts.

Fix: memoize the in-flight creation/recovery promise; concurrent callers await the same promise.

### H3. Session timeout counts queue-wait — kills healthy sessions
`src/session/bc-session.ts:148`

`withTimeout` wraps `enqueue(...)`, so the timer starts at enqueue time and queue-wait counts against it. With a backlog (two invokes each legitimately ~25s under the 30s RPC default), a later invoke's timer fires while an earlier one is still healthily in flight, spuriously calling `markDead()`+`closeWs()` and killing the whole session.

Fix: start the timeout inside the enqueued fn — `enqueue(() => this.withTimeout(this.invokeUnqueued(...), ...))` — so it only times actual execution.

### H4. Ownerless `FormCreated` overwrites the source page
`src/protocol/page-event-router.ts:135`

With a `targetPcId` hint (every `applyToPage` call), an ownerless `FormCreated` for a brand-new form is routed as `UpdateRootForm` into the target page. `applyRootControlTree` then overwrites the source page's `pageType`/`caption` and inserts the foreign form into its `forms` map. Reachable on every drill-down, every action-opens-page, cue drill-down, and post-via-dialog. Same unverified-trust problem in the `AddChildForm` branch (line 126).

Fix: when `targetPcId` is supplied, only `UpdateRootForm` if `formId === page.rootFormId` (or `page.forms.has(formId)`), only `AddChildForm` if `page.forms.has(event.parentFormId)`; else `Unmatched`.

### H5. Actions that open pages return unaddressable forms
`src/operations/execute-action.ts:94`

`openedPages` is only populated for pre-registered forms; nothing registers ownerless `FormCreated` events from plain actions (only `executeOnCue`/`drillDown` create pcIds). An action that opens a page ("Dimensions", "Ledger Entries", "New") returns `openedPages: []` — the new BC form is unaddressable/unclosable, and per H4 its `FormCreated` corrupts the source context.

Fix: mirror the registration loop in `action-service.ts:138-146` in the plain `executeAction` path.

### H6. Report request page never registered — documented workflow impossible
`src/operations/run-report.ts:56`

The request page dialog is returned (formId, fields) but never registered as a page context (no `repo.create`/`applyToPage`). The documented flow — "fill parameters using `bc_write_data`, execute with `bc_respond_dialog`" (`run-report.tool.ts:7`) — cannot work: `bc_write_data` can't resolve the dialog's fields from any pageContextId, and `bc_respond_dialog` requires an existing pageContextId.

Fix: register the request page as a page context and return its pageContextId.

### H7. `navigate action:"lookup"` is a silent no-op
`src/operations/navigate.ts:41`

`action: "lookup"` (advertised in `NavigateSchema` and `navigate.tool.ts:13`) falls through to `selectRow` — no lookup implemented in `NavigationService` — and the `field` parameter is never read (drillDown ignores it too). Callers get a cursor move instead of a lookup, with no error.

Fix: implement lookup/field targeting, or reject `action:"lookup"` and non-empty `field` with a clear error.

### H8. Tell Me form leaked on every `bc_search`
`src/services/search-service.ts:90`

The Tell Me form is opened via PageSearch=220; its `FormCreated` adds the formId to `session._openFormIds`, but `search()` never closes it. Every call leaks a server-side form and permanently grows `_openFormIds`, serialized into `openFormIds` on every subsequent request.

Fix: after extracting results, `CloseForm{formId:tellMeFormId}` (or `session.removeOpenForm`), as `LookupService` does with LookupCancel + removeOpenForm.

### H9. Stale `optionIndex` after SaveValue on option fields
`src/protocol/form-state.ts:73`

`applyPropertyChanged` never translates wire `CurrentIndex` → `optionIndex` (nor `Items` → `options`). After SaveValue on an option field the StringValue echo updates but the stale build-time `optionIndex` survives; `section-dto.ts:168-170` prefers a valid `optionIndex` over the stringValue fallback, so `selectedOption` reports the pre-change option, contradicting `value`, until rebuild.

Fix: `if (typeof changes.CurrentIndex === 'number') nodeChanges.optionIndex = changes.CurrentIndex` (mirror `Items` → `options`); or drop `optionIndex` when StringValue changes without a CurrentIndex.

---

## MEDIUM

### Missing business-error classification (silent success on real failures)
- `src/operations/respond-dialog.ts:77` — events never run through `classifyBusinessError`; a posting failure after "yes" (MessageToShow Error / ErrorDialog) returns `success: true`.
- `src/operations/switch-company.ts:41` — success claimed unconditionally after InvokeCompleted; invalid company still reports success, returns unconfirmed `newCompany`, and `clearAll()` destroys all contexts for nothing.
- `src/operations/wizard-navigate.ts:41` — finish/next events never classified; a wizard finish trigger error reports `success: true`.

### Event-apply / state-mutation gaps
- `src/operations/respond-dialog.ts:46` — the "close" path never calls `applyToPage`; FormClosed/PropertyChanged dropped, `changedSections` computed against stale state, generation not bumped (defeats `expectedStateVersion` guard).
- `src/protocol/page-context-repo.ts:247` — `addChildForm` has no already-registered guard; a repeated `FormCreated` (factbox reload, `isReload` FormToShow) resets child FormState (drops loaded rows), creates duplicate sections, re-appends formId, can flip `pageType` to 'Document'.
- `src/protocol/page-context-repo.ts:322` — `markFormClosed` only invalidates sections; closed form stays in `forms`/`dialogs`/`ownedFormIds`, `formIdIndex` never deindexed. Long-lived contexts (Role Center) accumulate every dialog/child ever opened; reports closed dialogs as open.
- `src/protocol/page-context-repo.ts:255` — `addChildForm` guards with `tryBuildFormTree` then passes the same raw controlTree to `deriveSection` → unguarded `buildFormTree` throws on exactly the tolerated inputs, aborting the batch mid-way and leaving the page half-updated.

### Row / section correctness
- `src/protocol/section-resolver.ts:43` — `deriveSection` can never return `'factbox'`; any repeater-bearing child classified `'lines'`. ListPart FactBoxes misclassified as the document's lines section (also forces `pageType='Document'`), so `bc_read_data` lines returns factbox rows.
- `src/protocol/event-decoder.ts:51` — silently drops resolved `DataRowInserted`/`DataRowUpdated`/`DataRowRemoved`/`DataRowPropertyChange` (+ `ChildInserted`/`Removed`/`Moved`); incremental row updates outside a full `DataRefreshChange` never reach `FormState.rows`, so `bc_read_data` serves deleted/stale rows.
- `src/protocol/form-state.ts:59` — `currentRowOnly` merge can only update existing bookmarks; a `DataRowInserted` for a new bookmark (fresh draft after New) is dropped, and when `existing` is empty the whole event is lost.
- `src/protocol/form-state.ts:101` — `extractRows` ignores `DataRowRemoved`; a delete-only `DataRefreshChange` with `currentRowOnly:false` wipes surviving rows; viewport index `rowData[0]` ignored, so partial chunks replace the full set instead of splicing.
- `src/services/data-service.ts:252` — `writeLineCell` reports `newValue: value` (raw input) instead of BC's echoed cell value; a silently reverted/reformatted line write is misreported (the card-field path reads it back correctly).

### Session robustness
- `src/session/bc-session.ts:89` — the 150ms init quiescence collects nothing: no `ws.onMessage` handler is registered, so async events during OpenSession (async license dialog, form-tracking) never reach `updateFormTracking`/`findLicenseDialog`, leaving an undismissed modal that later triggers LogicalModalityViolation.
- `src/session/rpc-error-classifier.ts:16` — `message.includes('"code":1')` substring-matches `"code":10`, `100`, `15041`… misclassifying non-fatal errors as fatal (kills alive session); also misses `"code": 1` with whitespace. Use `/"code":\s*1(?=[,}\s])/`.
- `src/session/report-downloader.ts:48` — `decodeURIComponent(fnMatch[1])` unguarded on plain `filename="..."`; a literal `%` (e.g. `"100% Done.pdf"`) throws URIError and fails an otherwise-fetchable download. Only decode the `filename*=UTF-8''` form, wrap in try/catch.
- `src/session/report-downloader.ts:31` — `fetch()` has no timeout/AbortSignal; a stalled `DynamicFileHandler.axd` GET hangs the MCP call indefinitely. Pass `signal: AbortSignal.timeout(ms)`.
- `src/session/bc-session.ts:108` — license-dialog fallback deletes formId from `_openFormIds` only, never from `modalStack`; a stale entry sits at stack top for the session lifetime and a later `reconcileModalStack` Aborts a dead formId. Call `removeOpenForm(licenseDialog.formId)`.
- `src/session/session-factory.ts:37` — if `initialize()` throws (e.g. `decoder.decode` on malformed OpenSession), `create()` propagates without `session.close()`, leaking the WebSocket + NTLM slot. Wrap in try/catch(+close).

### Auth / transport / input validation
- `src/connection/auth/ntlm-provider.ts:52` — POST /SignIn status never checked; wrong creds re-render the login page (200) with a matching antiforgery cookie, so `authenticate()` returns success and fails later as an opaque WS handshake error. Verify 302 redirect / auth session cookie.
- `src/api/middleware.ts:6` — `parseJsonBody` buffers with no size limit; any client can OOM the process. Enforce a max (e.g. 5 MB), destroy + reject when exceeded.
- `src/api/routes.ts:11` — REST handlers cast raw body straight to the op input type with no zod (the MCP path safeParses); malformed bodies reach the protocol layer / crash as 500s. Run the `src/mcp/schemas.ts` schemas first.
- `src/stdio-adapter.ts:19` — writes the raw HTTP body to stdout verbatim; a 401/500 `{"error":...}` or a notification reply (no `id`) corrupts the JSON-RPC stream. Validate it's a JSON-RPC message with `id` before writing; add API_TOKEN header support.
- `src/mcp/schemas.ts:10` — `pageId` accepts any string; page-service interpolates it raw into `page=${pageId}&tenant=...`, so `"customer list"` yields an opaque failure and a value with `&` injects extra query params. Add `.regex(/^\d+$/)` (same for `reportId` at line 83).
- `src/operations/run-report.ts:41` — `parseInt(input.reportId, 10)` unchecked; `"abc"` → `report=NaN`, `"12abc"` → silently report 12. Validate `Number.isInteger`.
- `src/mcp/schemas.ts:29` — `range.offset/limit` unconstrained `z.number()`; a negative offset hits `Array.slice` negative-index semantics (`read-data.ts:138`) returning wrong rows; fractionals accepted. Use `.int().min(0)` / `.int().min(1)` (also `rowIndex`).
- `src/operations/open-page.ts:52` — the `CardPartStubError` early-return leaks the just-opened page (registered + opened on BC, pcId never returned/closed). `await pageService.closePage(ctx.pageContextId)` first.
- `src/operations/open-page.ts:40` — `tenantId` defaults to literal `'default'` (`page-service.ts:84`) while the schema promises "server-configured tenant"; with `BC_TENANT_ID != "default"`, `bc_open_page` without tenantId opens against the wrong tenant. Thread the configured tenant as default.
- `src/operations/list-companies.ts:36` — company name taken as the first string-typed cell instead of the "Name" column; iteration order can surface "Display Name" first, feeding `bc_switch_company` a rejected name. Read `cells["Name"]` by caption with heuristic fallback.
- `src/services/page-service.ts:332` — `closePage()` unconditionally `repo.remove()` in finally; when `discardChanges` is falsy and a "save changes?" DialogOpened appears, the context is deleted but the modal is stranded (no pcId to answer). Keep the context when a blocking dialog appears and `discardChanges` is false.
- `src/protocol/decompression.ts:8` — `gunzipSync` only accepts gzip; a zlib/deflate payload fails with ProtocolError, and there's no `maxOutputLength` cap. Use `unzipSync` with `{ maxOutputLength }`.
- `src/protocol/interaction-encoder.ts:130` — `getTimezoneInfo` hardcodes EU DST rules regardless of host tz; non-EU zones get wrong DST periods, shifting datetimes by an hour part of the year. Derive DST by comparing Jan vs Jul `getTimezoneOffset()`.

---

## LOW

- `src/mcp/page-context-validator.ts:5` — `validatePageContextId` is dead code (no importer); every op returns a bare `PROTOCOL_ERROR` instead of the helpful diagnostic. Wire it in or delete.
- `src/session/bc-session.ts:513` — `invokeRaw`'s try/catch is dead code (not async, `withTimeout` rejects asynchronously); the TimeoutError→Result conversion never runs. Make `invokeRaw` async and `await`.
- `src/session/license-dialog.ts:23` — `(tree.Caption ?? ...) as string` unchecked; a non-string Caption/Message throws in `.toLowerCase()`, failing session init. Guard `typeof === 'string'`.
- `src/odata/odata-client.ts:169` — `@odata.nextLink` ignored; when `top` exceeds BC's server max page size (default 20000), rows silently truncated with no signal. Surface `nextLink`/`hasMore`.
- `src/odata/odata-client.ts:165` — `entity`/`companyId` interpolated into the URL unescaped; `?`/`#`/`&`/`/` rewrites the query string (drops `$top`/`tenant=`). Validate `entity` against `/^[A-Za-z][A-Za-z0-9_]*$/` inside `query()`.
- `src/connection/auth/ntlm-provider.ts:88` — CSRF token chosen as the first cookie whose value starts with `CfDJ8`, but every ASP.NET data-protection cookie shares that prefix; ordering decides the winner. Match by cookie name (`Antiforgery`).
- `src/connection/bc-websocket.ts:268` — `ws!.send(payload)` passes no completion callback; a socket write failure (EPIPE) only logs, and the pending RPC hangs the full timeout. Pass a callback, reject/delete the pending entry on error.
- `src/core/logger.ts:20` — the two `createWriteStream`s have no `'error'` listeners (a post-startup write failure crashes the server) and are never flushed/closed before `process.exit(0)`, dropping tail entries. Attach handlers + end streams on shutdown.
- `src/server.ts:169` — the catch calls `res.writeHead(500)` without checking `res.headersSent`; a throw after headers written produces an unhandled rejection that kills the process. Guard `if (!res.headersSent)`.
- `src/api/middleware.ts:20` — API token compared with `===`, not constant-time. Use `crypto.timingSafeEqual` over equal-length buffers.
- `src/protocol/event-decoder.ts:114` — `messageType` cast unvalidated to the enum-name union; a numeric ordinal or unexpected casing makes `classifyBusinessError` miss real errors and report success. Normalise at decode time.
- `src/protocol/page-context-repo.ts:113` — `advanceWizardStep` mutates the root tree via `store.set` without bumping `generation`; the `expectedStateVersion` staleness guard misses wizard-step transitions. Increment `generation`.
- `src/protocol/page-event-router.ts:221` — `findChildFormByRepeaterPath` matches by child-relative controlPath, but all child trees root at `server:`, so paths collide; first repeater-bearing child by insertion order wins. On a Document with lines subpage + ListPart factbox both owning `server:c[0]`, rows can seed the wrong form. Prefer the `kind:'lines'` child or require a unique match.
- `src/protocol/form-state.ts:103` — `rowData[1]` cast to `Record<string,unknown>` after only a length check; a malformed row throws a TypeError, aborting the whole batch. Guard `typeof === 'object' && !== null`.
- `src/protocol/form-state.ts:101` / `tell-me-extractor.ts:51` — key off full-name `DataRowInserted`/`Updated` only, while wire-types maps abbreviated `drich`/`druch`; if BC27 emits abbreviated tags, rows silently dropped. Resolve `t` via `resolveChangeType`, read both key forms.
- `src/protocol/row-mapping.ts:22` — caption disambiguation can collide with a natural caption (`Qty`, `Qty#2`, `Qty` → third maps to `Qty#2` colliding with the second). Loop the suffix until absent from all assigned captions.
- `src/protocol/form-state.ts:84` — when an event carries only untracked props (`ValidationResults`, `ShowMandatory`, `Items`), `nodeChanges` is `{}` yet `applyPropertyChange` still allocates a new node/root, violating the reducer's "same reference if no change" contract and invalidating every WeakMap view per event. Early-return `form` when `nodeChanges` is empty.
- `src/operations/read-data.ts:105` — an unknown/typo tab name is silently ignored and ALL header fields returned. Return an error listing available tab captions.
- `src/mcp/schemas.ts:37` — `WriteDataSchema.fields` accepts `{}`; `bc_write_data {}` returns `allSucceeded: true` (vacuous `every`) having written nothing. `.refine(len > 0)`.
- `src/operations/run-report.ts:91` — fallback save filename hardcodes `.pdf` even for excel/word. Derive extension from format.
- `src/operations/run-report.ts:104` — `executeWithDownload` hardcodes `requiresDialogResponse: false` while returning already-closed dialogs in `dialogsOpened`; agents may `bc_respond_dialog` against stale formIds. Return `dialogsOpened: []`.
- `src/mcp/handler.ts:58` — `notifications/initialized` gets a response with `id: undefined`; the HTTP transport (`server.ts:149`) sends an invalid JSON-RPC response to a notification. Return a sentinel the transports translate to 202/no-body.

---

## Clean files (agents confirmed no defects)
`form-node.ts`, `form-tree-builder.ts`, `form-tree-mutator.ts`, `form-tree-walk.ts`, `form-views.ts`, `form-state-reducer.ts`, `visibility.ts`, `cue-detection.ts`, `wizard-classify.ts`, `mutation-result.ts`, `handler-types.ts`, `wire-types.ts`, `page-context.ts`, `page-context-store.ts`, `section-dto.ts`, `mcp-adapters.ts`, `types.ts`, `error-classifier.ts`, `modal-stack.ts`, `report-format-resolver.ts`, `core/result.ts`, `core/abort.ts`, `core/errors.ts`, `core/config.ts`, `src/index.ts`, `connection/auth/auth-provider.ts`, and all `.tool.ts` definition modules + `tool-registry.ts` (14 tools wired once, correct handlers, no duplicates).
