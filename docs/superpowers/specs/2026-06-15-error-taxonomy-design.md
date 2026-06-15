# Error Taxonomy (Phase 1b) — Design + Plan

**Date:** 2026-06-15
**Status:** Approved (autonomous execution authorized)
**Branch:** `feat/error-taxonomy`
**Depends on:** the decode foundation (commits `4287b00`, `71fc33e`) — `MessageToShowEvent`, `ValidationResultItem`, `extractValidationErrors`, all verified against live BC28.

## Problem
BC tool calls that fail business logic (field validation, AL `Error()`, posting errors) currently surface to the LLM as either a raw protocol string or — worse — as a silent success, because the rejection signal (`PropertyChanged.ValidationResults`, `MessageToShow` Error/Fatal, error `DialogOpened`) was either dropped or buried in a success payload. An LLM caller cannot reliably tell a write was rejected, nor what to do next.

## Verified facts (live BC28)
- Field validation arrives as `PropertyChanged.changes.ValidationResults[]` (deduped by `Id`). Item shape: `{ Id:number, Description:string, DescriptionShort?:string, Severity:'Error'|'Warning'|'Info', IsLocal?:boolean, OriginatingControl?:{controlPath,formId}, ExceptionType?:number }`. `Severity:'Error'` = value rejected/not committed.
- AL `Message()` / non-blocking notices arrive as `MessageToShow` with `messageType` in `None|Warning|Info|Error|Fatal|Confirm|Permission`.
- Modal errors arrive as `DialogOpened` (already decoded) — distinguishable by error MappingHint/DialogType.
- `ActionResult.events: BCEvent[]` and `WriteDataOperation` both have the raw event stream available to classify.

## Design

### New error types (`src/core/errors.ts`)
- `BusinessValidationError extends BCError` (code `VALIDATION_ERROR`): `fieldErrors: Array<{ field?: string; description: string; descriptionShort?: string }>`. `message` = the joined `description`s. `toJSON` includes `fieldErrors`.
- `BusinessError extends BCError` (code `BUSINESS_ERROR`): `bcText: string`, `severity: string`, `source: 'message' | 'dialog'`. For Error/Fatal `MessageToShow` and error dialogs.
- `errorHint(code: string): string | undefined` — central code→next-step map:
  - `VALIDATION_ERROR` → "Correct the field value(s) and retry with bc_write_data."
  - `BUSINESS_ERROR` → "BC rejected the operation. Read the message, adjust inputs, and retry."
  - `SESSION_LOST` → "The session was reconnected. Re-open any pages with bc_open_page, then retry."
  - `MODAL_RECONCILE_ERROR` → "A stuck modal was cleared by resetting the session. Re-open the page and retry."
  - `TIMEOUT_ERROR` → "BC did not respond in time. Retry; if it persists the operation may be too heavy."
  - `CARDPART_STUB` → use the error's `hostHint` (already present in context).
  - default → undefined.

### Shared classifier (`src/protocol/error-classifier.ts`, new)
`classifyBusinessError(events: BCEvent[]): BusinessValidationError | BusinessError | null`
- If any `ValidationResults` item with `Severity === 'Error'` (via `extractValidationErrors`): return `BusinessValidationError` built from those items (`field` from `OriginatingControl.controlPath`, `description`, `descriptionShort`).
- Else if any `MessageToShow` with `messageType` `Error` or `Fatal`: return `BusinessError({ bcText: text, severity, source: 'message' })`.
- Else if any error `DialogOpened` (controlTree `MappingHint === 'ErrorDialog'`, or DialogType indicating error): return `BusinessError({ bcText: <caption/message>, severity: 'Error', source: 'dialog' })`.
- Else `null`.
Non-error validation items (Warning/Info) are NOT errors — they remain data.

### Operation wiring
- `WriteDataOperation.execute`: after collecting `events`, call `classifyBusinessError(events)`; if non-null, return `err(it)`. Otherwise return `ok` with `validationWarnings: ValidationResultItem[]` (the non-Error items; rename the old `validationErrors` output field to `validationWarnings` since Errors now short-circuit to `err`).
- `ExecuteActionOperation.execute`: same — classify `ar.events`; non-null → `err(it)`.

### MCP boundary (`src/mcp/handler.ts`)
When a tool result is `err` (or throws) and the error is a `BCError`, format the content as:
```
Error [<code>]: <message>
Hint: <hint>            (omitted if no hint)
```
plus `isError: true`. Keep the existing `SessionLostError` special-case behavior (it is now just one code in the same formatter). Non-BCError throwables keep the current generic "Tool error:" rendering. Add a small pure helper `formatBcError(err): string` so it is unit-testable without the JSON-RPC envelope.

## Plan (TDD, subagent-executed)

### Task A — error types + classifier (pure, no live BC)
- `src/core/errors.ts`: add `BusinessValidationError`, `BusinessError`, `errorHint`.
- `src/protocol/error-classifier.ts`: `classifyBusinessError`.
- Unit tests `tests/unit/error-classifier.test.ts`: Error-validation → BusinessValidationError; Warning-only → null; Error/Fatal MessageToShow → BusinessError; error dialog → BusinessError; clean events → null; precedence (validation before message before dialog).
- Unit tests `tests/unit/error-hint.test.ts`: each code maps to expected hint; unknown → undefined.

### Task B — wire into operations + handler (depends on A)
- `WriteDataOperation`: classify → `err`; rename output `validationErrors`→`validationWarnings` (non-error only). Update `WriteDataOutput`.
- `ExecuteActionOperation`: classify `ar.events` → `err`.
- `src/mcp/handler.ts`: add `formatBcError`, route BCError (from `err` results AND thrown) through it with hint + `isError`.
- Unit tests `tests/unit/mcp-error-format.test.ts`: a BCError result renders `Error [CODE]` + Hint + isError; a plain error keeps generic format; a success is unaffected.
- Integration `tests/integration/validation-errors.test.ts`: add an assertion that a rejected write THROUGH `WriteDataOperation` (Edit page 21 → invalid Credit Limit "notanumber$$") returns `isErr` with code `VALIDATION_ERROR` and a `fieldErrors` description containing the BC text. (Keep the existing mechanism-confirmation tests.)

### Verification
- `npx vitest run` (unit/protocol) green; `npx tsc --noEmit` clean.
- `npx vitest run --config vitest.integration.config.ts tests/integration/validation-errors.test.ts` green.
- Full integration suite remains green (run once at phase end).

## Out of scope
- Mapping every BC exception subtype to bespoke codes (only validation + generic business error here).
- Confirm/permission `MessageToShow` interactive handling (those are `Confirm`/`Permission` types — left as data).
