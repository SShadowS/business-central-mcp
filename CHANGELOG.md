# Changelog

All notable changes to `business-central-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OAuth / Microsoft Entra ID authentication.** A SaaS portal URL (or
  `BC_AUTH=OAuth`) acquires a Standard API token via device-code (built-in
  public client) and uses it as `Authorization: Bearer` for `bc_query`.
  Refresh tokens are cached under `STATE_DIR`. `BC_USERNAME` / `BC_PASSWORD`
  are not required in this mode.
- **SaaS URL parsing.** A portal URL such as
  `https://businesscentral.dynamics.com/7bcb54ae-…/DEV` is split into Entra
  tenant + environment. OData is derived as
  `https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}`.
- **`bc_query` no longer opens a `/csh` session.** The OData tool is
  independent of the web-client WebSocket, so SaaS OAuth works for bulk reads
  even when the first-party web-client cookie session cannot be established.
- **Device-code sign-in surfaces in chat.** When `bc_query` needs a sign-in it
  fails fast with `DEVICE_LOGIN_REQUIRED` whose message carries the
  https://microsoft.com/devicelogin URL and user code (instead of blocking the
  tool call and printing the code on stderr, which MCP clients never show).
  The pending sign-in is persisted in `STATE_DIR/oauth-pending.json`; retrying
  the tool polls once and resumes — same code, no re-prompt — then runs the
  query once sign-in is complete.

### Changed

- Config: new `BC_AUTH`, `BC_AAD_TENANT_ID`, `BC_ENVIRONMENT`, `BC_OAUTH_SCOPE`.
  `BC_USERNAME` / `BC_PASSWORD` are required only for `NavUserPassword`.

### Fixed

## [1.5.0] - 2026-07-25

### Added

- **Multi-row selection.** `bc_execute_action` accepts `bookmarks: string[]` to
  select N rows and invoke a selection-consuming action (Delete) over the whole
  set atomically (`SetCurrentRowAndRowsSelection` + `InvokeAction` in one queue
  entry). The anchor is `bookmarks[0]` and must be a member of the set. Only
  selection-consuming actions act on all rows; Edit/View/DrillDown/New are
  current-row-only and are rejected with `bookmarks[]`. A stale anchor returns
  `INVALID_BOOKMARK`; `BC_MAX_SELECTION` (default 100) caps the set.
- **Generic file download capture.** `bc_execute_action`, `bc_respond_dialog`,
  `bc_wizard_navigate`, and `bc_run_report` now return `downloads: Download[]`
  (inline base64 + optional disk write) and `externalUris[]` via a shared
  `DownloadService`. Only same-origin URLs under an allowlisted BC file path are
  fetched (SSRF/credential-leak guard); external and `mailto:` URIs are surfaced
  but never dereferenced. Per-file/aggregate/count caps and `BC_DOWNLOAD_DIR`
  are configurable.
- **Config.** `BC_MAX_SELECTION`; download limits `BC_MAX_DOWNLOAD_BYTES`,
  `BC_MAX_DOWNLOAD_TOTAL_BYTES`, `BC_MAX_DOWNLOADS`, `BC_DOWNLOAD_DIR`
  (falls back to `BC_REPORT_DIR`).

### Changed

- **BREAKING (`bc_run_report`):** the singular `download` field is replaced by
  `downloads: Download[]` for parity with the other download-capturing tools.
- Default client version / serverMajor now default to BC28.

### Fixed

- **BC 28.3 `/csh` 403.** The WebSocket upgrade now sends an `Origin` header, so
  BC 28.3's `RequestOriginValidationMiddleware` no longer rejects the connection.
  Same-origin only; a no-op on BC 28.0.
- **Multi-row action silent no-op.** A multi-row Delete on a page that forbids it
  (e.g. the Customer list) previously returned success with nothing deleted. BC
  disables such actions server-side (`Enabled=false`); `bc_execute_action` now
  detects that and returns `MULTI_ROW_ACTION_UNAVAILABLE` instead of a lying
  success. Where BC keeps the action enabled it deletes all selected rows.
- Download disk-write filenames are sanitized against path traversal.

## [1.4.0] - 2026-07-11

### Added

- **MCP prompt workflows.** The server now implements the MCP `prompts/*`
  primitive (`prompts/list` + `prompts/get`), shipping 9 parameterized
  workflow templates that encode the correct multi-step tool choreography:
  `bc_find_page`, `bc_read_list`, `bc_edit_record`, `bc_create_document`,
  `bc_post_document`, `bc_set_dimensions`, `bc_report`, `bc_bulk_read`, and
  `bc_run_wizard`. The `prompts` capability is advertised on `initialize`.
- **`bc_query` pagination signal.** The result now surfaces `hasMore` (and the
  raw `@odata.nextLink`) so a caller can tell when `top` exceeded BC's server
  page size and rows were truncated, instead of silently losing data.

### Changed

- **`bc_read_data` rejects an unknown `tab`** with an error listing the
  available tabs, instead of silently returning all header fields.
- **`bc_write_data` rejects an empty `fields` object** instead of reporting a
  vacuous success.

### Fixed

- **Drill-down loads document lines.** A document reached via
  `bc_navigate(drill_down)` (or opened by an action) now exposes its `lines`
  section and FactBoxes, not just `header`. Child-form discovery was extracted
  into a shared `ChildFormHydrationStrategy` and is now run on the drill-down
  and action-opened targets, not only on `bc_open_page`.
- **Tool descriptions synced with current behavior.** Refreshed the
  bc_navigate (dropped the removed `lookup`/`field`), bc_run_report (documents
  `requestPage.pageContextId`/`formId`), bc_respond_dialog, bc_open_page,
  bc_read_data, bc_search_pages, and bc_query tool descriptions to match the
  shipped schema and outputs.
- **Robustness cleanup (low-severity review findings).** Recovery re-auth picks
  the antiforgery cookie by name (not the shared `CfDJ8` prefix); a WebSocket
  send failure fast-fails the pending RPC instead of hanging to timeout; log
  streams handle write errors instead of crashing; the HTTP transport returns
  202 (no body) for JSON-RPC notifications; wizard-step transitions bump the
  page generation; the router prefers the lines section when repeater paths
  collide; report save filenames use the correct extension for excel/word.
  `DataRowPropertyChange` events are now explicitly ignored (verified against
  decompiled BC28: they carry only row-level Selected/Expanded/Draft, never a
  cell), and MessageToShow types are normalized so a casing variant can't slip
  a real error past classification.

## [1.3.0] - 2026-07-10

### Added

- **`bc_query` OData tool.** Bulk, structured reads via BC's Standard API v2.0
  (customers, items, salesOrders, generalLedgerEntries, …) with `$filter`,
  `$select`, `$orderby`, `$top`, and `$expand`. Company-scoped automatically,
  with a per-query `company` override.
- **`lookupCustom` field flag.** Field DTOs surface `lookupCustom` for AL
  `OnLookup` fields so an agent knows a field needs the custom lookup path.
- **Incremental repeater rows.** `bc_read_data` now reflects live row
  inserts/updates/deletes on document lines. BC's top-level `DataRow*` change
  events (previously dropped) are decoded and applied, so reads after New /
  Delete / recompute no longer serve stale or deleted rows.
- **Report request page is addressable.** `bc_run_report` returns a
  `pageContextId` for the request page, so parameters can be filled with
  `bc_write_data` and the report run with `bc_respond_dialog` — the documented
  flow now actually works.

### Changed

- **Stricter input validation.** Page/report IDs must be numeric; `range`
  offset/limit and `rowIndex` are bounded non-negative integers; REST bodies
  are zod-validated and size-capped; the API token is compared in constant
  time. Malformed inputs are rejected up front instead of producing opaque BC
  failures.
- **`bc_navigate`** no longer advertises the non-functional `action: "lookup"`
  / `field` inputs (they were silent no-ops); use `bc_lookup` for field
  lookups.

### Fixed

- **Row-scoped actions target the intended row.** `bc_execute_action` with a
  `bookmark`/`rowIndex` now positions that row before Delete/Edit, instead of
  acting on whatever row was selected.
- **FactBox sections classify correctly.** ListPart/CardPart FactBoxes are no
  longer misclassified as document lines (and no longer flip a Card page to
  Document); verified via `IsSubForm`/`IsPart` on the child form.
- **Silent-success bugs.** `bc_switch_company`, `bc_respond_dialog`, and
  `bc_wizard_navigate` now surface BC posting/validation errors instead of
  reporting success; `bc_respond_dialog` applies close-path events.
- **OData `companies` entity.** `bc_query("companies")` no longer wrongly
  company-scopes the top-level entity (it previously always failed).
- **Session robustness.** Recovery re-authenticates instead of reusing dead
  cookies; concurrent first requests share one session (no leak); the invoke
  timeout clocks execution rather than queue wait; the Tell Me search form is
  closed after use.
- **Line-cell writes** report BC's echoed/validated value, not the raw input.
- **Sign-in** rejects bad credentials up front instead of failing later at the
  WebSocket handshake.

See `docs/code-review-2026-07-10.md` for the full list of resolved findings.

## [1.2.0] - 2026-06-16

### Added

- **Option/enum values on field output.** `bc_open_page` and `bc_read_data`
  now expose `options` (the allowed `{text, value}` choices) and
  `selectedOption` for option/enum and boolean fields, so an agent picks a
  valid value instead of guessing and tripping a validation error. Covers
  card fields and list option-columns (where BC includes them in the list
  payload). These values were already on the wire; they are now surfaced.
- **`bc_read_data` `sort`.** Sort an open list by a column: `sort: { column,
  direction: "asc" | "desc" }`. Resolves the repeater column header and issues
  BC's SortColumn action; errors clearly (with `availableColumns`) when the
  column is missing or not sortable.
- **`bc_read_data` `clearFilters`.** `clearFilters: true` clears
  agent-applied filters and restores the page to its default/native filtered
  state (page-defined `SourceTableView` filters remain) before any filters in
  the same call are applied.

## [1.1.0] - 2026-06-16

### Added

- **Report output capture.** `bc_run_report` with `format: "pdf"` returns the
  rendered report bytes (base64) plus `contentType` and `fileName`, and can
  save to disk via the `BC_REPORT_DIR` env var. Verified end-to-end against
  live BC28 (Trial Balance report). Other formats return a clear error.
- **Page staleness guard.** `bc_open_page` and `bc_read_data` now return a
  `stateVersion`; `bc_write_data` and `bc_execute_action` accept an optional
  `expectedStateVersion` and reject drifted state with a `STALE_CONTEXT`
  error before sending anything to BC. Opt-in — omitting it preserves prior
  behavior.
- **Actionable error taxonomy.** BC field-validation and business errors now
  surface as typed MCP errors (`VALIDATION_ERROR`, `BUSINESS_ERROR`,
  `STALE_CONTEXT`, and others) with next-step hints, instead of raw protocol
  strings or silent successes. The server now decodes BC `MessageToShow`
  events and `PropertyChanged.ValidationResults` (previously dropped).
- **`BC_APPLICATION_ID` env var** (default `FIN`; set `NAV` for some on-prem
  BC27 containers that reject `FIN` with `NavCancelCredentialPromptException`).
- **`BC_REPORT_DIR` env var** for report output capture.

### Changed

- The WebSocket client now dispatches inbound JSON-RPC requests (enables the
  report-download flow; previously inbound requests were dropped).
- Internal: decomposed four large modules — `tool-registry` (definitions
  colocated with operations), `page-context-repo` (CQRS: Store / EventRouter /
  FormStateReducer), `page-service` (factbox/role-center hydration strategies),
  and `bc-session` (extracted pure helpers). Behavior-preserving; no public
  API change.
- Internal: integration test suite reworked for deterministic, back-to-back
  runs (user-rotation session pool, single-process serial). Substantial new
  unit coverage across operations, session, protocol, MCP handler, and the
  REST API layer.

### Fixed

- Dead sessions now fast-fail queued invokes immediately instead of each
  invoke waiting a full 30-second timeout (drain-on-death), eliminating
  cascade hangs after a session-killing protocol error.
- Idempotent session teardown with guaranteed server-side reap; `bc_close_page`
  always frees its page context even when the close errors.

## [1.0.2] - 2026-05-01

Install ergonomics across the three primary MCP hosts. Documentation, build
pipeline, and release automation only — no protocol or runtime changes.

### Added

- **Claude Desktop Extension (`.dxt`).** New `manifest.json` declaring the
  server with four prompted `user_config` fields (`bc_base_url`,
  `bc_username`, `bc_password` (sensitive), `bc_profile` (optional)). Manifest
  validates against `@anthropic-ai/dxt`. Wraps `npx -y business-central-mcp`
  rather than bundling `dist/`, so the `.dxt` tracks the latest npm version
  automatically.
- **`scripts/build-dxt.ts`** that produces `dist-dxt/business-central-mcp.dxt`:
  syncs `manifest.json` version from `package.json`, validates the manifest,
  zips manifest + icon + README + LICENSE via `archiver`. Three vitest tests
  cover artifact existence, size, and version sync.
- **`.github/workflows/release.yml`** triggered on `v*` tag pushes. Builds
  the `.dxt` and attaches it to the GitHub Release with auto-generated notes.
  Hardened with explicit artifact-existence check and
  `fail_on_unmatched_files`.
- **`ROADMAP.md`** capturing deferred work: OAuth/AAD auth, Windows auth,
  Cursor support, interactive `init` wizard, host auto-detection, more tools,
  BC29+ wire-compat verification, `.dxt` signing, MCP marketplace publication,
  the `manifest.json` `entry_point` schema/runtime gap, and the VSCode
  one-click `inputs` opportunity.
- **`icon.png`** (512×512, BC monogram on dark background) for the `.dxt`.
- **`build:dxt` and `validate:dxt` npm scripts.** `archiver` and
  `@types/archiver` added as devDependencies.

### Changed

- **`README.md` rewritten** following readme-design guidelines. New sections:
  Overview table (language, npm, BC versions, auth, tools, tests, license);
  Install with three host-specific subsections (VSCode one-click badge plus
  manual `.vscode/mcp.json`, Claude Code one-line `claude mcp add -e ...`,
  Claude Desktop `.dxt` download plus manual `claude_desktop_config.json`
  with per-OS paths); Configuration table covering 13 env vars
  (including `BC_INVOKE_TIMEOUT`, `BC_RECONNECT_MAX_RETRIES`,
  `BC_RECONNECT_BASE_DELAY` that previously had no documented home);
  ASCII protocol-flow diagram; Key files table; Roadmap section linking to
  `ROADMAP.md`; author/license footer. Old `## Quick start` JSON-paste
  section removed.

## [1.0.1] - 2026-04-28

First stable release of the v2 codebase. Declares the MCP tool output shapes
(`Section[]`) and env var contract as the public API surface — subsequent
breaking changes require a major version bump per semver.

(Note: version `1.0.0` was historically published on 2026-03-04 from the
prior codebase and unpublished; npm forbids version-number reuse, so the
v2 line starts at `1.0.1`.)

### Added

- `Section`-based MCP output shape: `bc_open_page` and `bc_navigate` now return
  a uniform `sections: Section[]` array. Each section carries its own
  `fields[]`, `rows[]`, `actions[]`, `cues[]`, `totalRowCount` as appropriate
  to its kind (header / lines / factbox / subpage / requestPage). FactBox
  contents are now first-class section entries, addressable by `sectionId`.
- `bc_read_data` returns a single refreshed `Section` for the requested
  section id (defaults to `"header"`).
- `BC_PROFILE` env var plumbed into BC's `OpenSession` `profile` field. Selects
  which profile (and therefore which Role Center / Tell Me index) the session
  loads. Verified against decompiled
  `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs`.
- Auto-recovery on `LogicalModalityViolationException` mid-session: the
  session walks an internal modal stack (DialogOpened-pushed,
  FormClosed-popped), sends `Abort=320` to each, then retries the original
  interaction once. Falls back to `ModalReconcileError` + session reset when
  reconciliation can't clear server-side state.
- Role Center cuegroup support: hosted CardParts surface as sections with
  `cues: SectionCue[]` populated from the new `stackgc`/`stackc` wire types.
  `bc_execute_action { section, cue }` drills down into the underlying list.
- `CardPartStubError` (code `CARDPART_STUB`): structured error when a
  CardPart opens standalone and BC returns a placeholder shell. Tells the
  caller to reach the part through its host page.
- Live wire fixtures committed under `src/protocol/captures/`: Tell Me
  results (`tell-me-result-2026-04-28.json`), Role Center cuegroups
  (`cuegroup-rolecenter-2026-04-28.json`), CardPart standalone
  (`cuegroup-cardpart-standalone-2026-04-28.json`).
- Capture utility scripts: `scripts/capture-tell-me.ts` and
  `scripts/capture-rolecenter.ts`.
- GitHub Actions CI: typecheck, build, and unit/protocol tests on Node 20,
  22, 24.

### Fixed

- **Tell Me search returned empty results.** The original `SearchService` sent
  `SaveValue` against `server:c[0]` (the `gc` container) instead of
  `server:c[0]/c[0]` (the actual `sc` text input). BC accepted the wrong
  path silently, returning `InvokeCompleted` with no `DataLoaded` events.
  Verified by live capture (BC28 BUSINESS MANAGER profile, query `customer`):
  the corrected path returns 23 page rows + 32 report rows. Root cause of
  limits.md #5.
- **Stale `ctx` in `bc_read_data` after filter / range operations.** The
  operation captured `PageContext` before invoking `applyFilters` /
  `scrollRepeater`, both of which produce immutable updates that replace the
  context entry. `buildSection` then projected pre-filter state. Range
  queries with `offset + limit` exceeding the initial viewport silently
  returned empty slices. Now re-fetches the context before building the
  output Section. Regression test added.
- **Promise-queue deadlock during modal recovery.** `reconcileModalStack`
  called `BCSession.invoke` recursively while running inside an
  already-enqueued task, blocking the queue. Split `invoke` into a public
  enqueueing entry point and a private `invokeUnqueued` work function;
  `reconcileModalStack` now uses the unqueued path. Race-against-deadlock
  regression test added.
- Architectural layering restored: `mapRowCellKeys` moved from
  `services/data-service.ts` to `protocol/row-mapping.ts` so `protocol/`
  no longer imports from `services/`.
- Deduplicated `classifyWizardNav` (was four byte-identical copies across
  `services/action-service.ts`, `operations/open-page.ts`,
  `operations/wizard-navigate.ts`, and `protocol/section-dto.ts`) into
  `protocol/wizard-classify.ts`.
- Empty FactBox sections (BC stub responses) are now invalidated after the
  factbox refresh pass so they don't pollute MCP output with empty content.

### Documentation

- `limits.md` items 1–5 updated with verified-fix status:
  - #1 (cuegroup placeholder) — resolved via Role Center cuegroup support.
  - #2 (FactBox invisible) — resolved via section-first-class output.
  - #3 (ApplicationArea filter) — documented as server-side BC behavior; no
    client override exists. Diagnosis and remediation flow via existing
    tools (page 9178 + `bc_open_page` + `bc_write_data`).
  - #4 (stuck modal) — partially resolved with two-stage recovery
    (transparent retry; degraded fallback to session reset).
  - #5 (Tell Me empty) — resolved (controlPath fix + structured extractor +
    optional `BC_PROFILE` for profile-scoped envs).
- `CLAUDE.md` adds protocol notes for Tell Me search (`server:c[0]/c[0]`
  controlPath, profile scoping), cuegroups (`stackgc`/`stackc` wire types),
  and `BC_PROFILE` env var.
- `README.md` documents the new sections-based output shape under "Page
  output shape".
- `.env.example` documents `BC_PROFILE`.
- `src/protocol/captures/README.md` records every empirical wire-format
  finding.

### Internals

- New `FormNode` variants: `StackGroupNode` (cuegroup container) and
  `CueFieldNode` (cue tile).
- New memoised view: `cues(root)` collects cuegroup tiles across the tree.
- New error class: `ModalReconcileError` (code `MODAL_RECONCILE_ERROR`,
  extends `ProtocolError`).
- New `SystemAction.CloseOk = 350` (verified against decompiled
  `Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs`).
- 281 unit + protocol tests, 111 integration tests against BC28.

### Internal architecture (informational)

- 5 implementation plans under `docs/superpowers/plans/` documenting the
  design and execution of this body of work:
  - `2026-04-28-section-first-class.md` (Plan A)
  - `2026-04-28-modal-stack-reconciliation.md` (Plan B)
  - `2026-04-28-rolecenter-cuegroup.md` (Plan C)
  - `2026-04-28-tell-me-extraction.md` (Plan D)
  - `2026-04-28-application-area-diagnostics.md` (Plan E — superseded by
    docs-only resolution; kept for historical context).

## [0.1.0] — Initial development version

Pre-release, in active development. Tagged version in `package.json` but
not yet published to npm.
