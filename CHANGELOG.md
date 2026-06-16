# Changelog

All notable changes to `business-central-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

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
