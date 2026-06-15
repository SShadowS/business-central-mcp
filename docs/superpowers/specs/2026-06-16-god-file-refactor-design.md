# God-File Refactor (Phase 2) — Design

**Date:** 2026-06-16
**Branch:** `feat/god-file-refactor`
**Nature:** Behavior-preserving restructuring. NO functional change. The reliable test suite (Phase 1) is the safety net.

## Safety protocol (applies to every task)
- **Preserve all observable behavior.** Public method signatures consumed elsewhere must keep working, or every consumer is updated in the same task. No backward-compat constraint on internal shapes — but external behavior (MCP outputs, protocol wire) is invariant.
- After each task: `npx vitest run` (all unit/protocol green) + `npx tsc --noEmit` clean + the integration tests that exercise that file green. Full integration suite at phase end (kill stale port 3456 first).
- One god-file per task, lowest-risk first: tool-registry -> page-context-repo -> page-service -> bc-session. Commit + verify each before the next.
- Refactors are judged by reviewers on: behavior preservation, clean seams (each new unit = one responsibility, well-defined interface), tests still green, no scope creep.

## Task 1 — tool-registry (`src/mcp/tool-registry.ts`, 255 lines)
**Smell:** central file holds every tool's MCP definition (name, description, inputSchema, zodSchema, execute wiring) far from the operation that implements it.
**Seam:** colocate each tool's MCP definition with its operation. Each `*Operation` class (or a sibling module per operation) exposes its own `ToolDefinition` (name, description, zod/input schema, execute closure). `tool-registry.ts` becomes a thin aggregator that imports each operation's definition and returns the array. The `ToolDefinition` type + `Operations`/`buildToolRegistry` contract stays; only the locus of each definition moves.
**Constraint:** the emitted MCP tool list (names, descriptions, input schemas) must be byte-identical — verify against `tests/unit/tool-descriptions.test.ts`. If that test asserts the current shape, it is the behavior lock.

## Task 2 — page-context-repo (`src/protocol/page-context-repo.ts`, 446 lines)
**Smell:** simultaneously a store (the `pages` Map + formId index) AND a complex event reducer with hardcoded BC routing quirks (factbox routing via root control paths, child-form repeater matching, modal-rooted page detection).
**Seam (CQRS):** split into three units:
- `PageContextStore` — pure storage/lookup (the Maps, get/create/delete/index). No event logic.
- `PageEventRouter` — given an event + page, decides WHICH form/target it applies to (the `findChildFormByRepeaterPath`, modal-rooted detection, factbox root-path routing logic).
- `FormStateReducer` — applies a routed event to produce new state (wraps the existing form-tree-mutator / projection calls).
The public `PageContextRepository` becomes a thin facade composing the three, preserving its current public API (`get`, `create`, `applyToPage`, `applyEvent`, etc.) so all consumers are unaffected. Keep `tests/protocol/page-context-repo-modal.test.ts` green as the behavior lock.

## Task 3 — page-service (`src/services/page-service.ts`, 383 lines)
**Smell:** orchestrates high-level intent (openPage, discoverAndLoadChildForms) while inlining low-level BC quirk sequences (select-row -> Refresh -> LoadForm to hydrate factboxes/cues on Role Centers).
**Seam:** extract each BC quirk sequence into a named strategy with a clear interface, e.g. `FactboxHydrationStrategy` (the select-row/refresh/LoadForm waterfall) and any cue/role-center hydration sequence. `PageService` calls `strategy.hydrate(...)`. The public PageService API stays. Behavior lock: `tests/integration/role-center.test.ts`, `multi-section.test.ts`, `phase4-features.test.ts`.

## Task 4 — bc-session (`src/session/bc-session.ts`, 481 lines) — HIGHEST RISK
**Smell:** the protocol core mixes RPC invocation, the serial invoke queue, modal-stack reconciliation, license auto-dismiss, dead-session detection/drain, graceful close, and report dispatch.
**Seam (middleware/interceptor pipeline):** the core `BCSession` keeps RPC invoke + sequence handling + the queue. Extract cohesive concerns into collaborators the session composes:
- license auto-dismiss (init-time) -> a small `LicenseDialogDismisser` helper.
- modal reconciliation (`reconcileModalStack`) -> already fairly self-contained; consider a `ModalReconciler` collaborator over the existing `ModalStack`.
- dead-session detection + drain-on-death + token classification -> keep close to the queue but factor the fatal-token classification into a pure helper (`isFatalRpcError(msg)`), unit-testable.
**HARD CONSTRAINTS (this file is the just-stabilized core):**
- The drain-on-death guard, the modal-violation retry path, the quiescence window, the invoke-queue serialization, and graceful close MUST behave identically. 
- `tests/unit/drain-on-death.test.ts`, `tests/unit/invoke-timeout.test.ts`, `tests/unit/bc-session-modal-tracking.test.ts`, `tests/unit/session-reconnect.test.ts`, and `tests/integration/modal-recovery.test.ts` are the behavior locks — all must stay green with NO test logic changes (only construction wiring may change if collaborators are injected).
- Prefer extraction over rewrite. If a clean extraction isn't possible without risking the queue/modal invariants, leave that concern in place and report it — partial extraction with preserved correctness beats a risky full rewrite.

## Definition of done (phase)
All four files decomposed per their seams (or partial with documented rationale for bc-session), full unit + integration suite green, tsc clean, no behavior change. Update the CLAUDE.md Architecture Overview to reflect the new unit boundaries.
