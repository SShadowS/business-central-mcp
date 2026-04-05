# Phase 5: Production Readiness

**Date**: 2026-04-05
**Status**: Draft

## Goal

Make the BC MCP server production-grade: resilient to failures, capable of company switching, able to execute reports, and reliable for create/edit/delete workflows. Heavy emphasis on test coverage.

## Four Pillars

1. **Robustness & Error Recovery** -- session resilience, timeout handling, clear error messages
2. **Multi-Company** -- switch companies within a session, list available companies
3. **Report Execution** -- run reports, fill request page parameters, execute (output capture deferred to Phase 6)
4. **Write-Back Polish** -- improve existing create/delete/write flows, no new tools

---

## Pillar 1: Robustness & Error Recovery

### 1.1 Session Death Auto-Reconnect

**Problem**: When BC kills a session (InvalidSessionException, WebSocket disconnect), the server throws `SessionLostError` and the LLM must manually re-open all pages. The NTLM auth slot is held for ~15 seconds, so immediate reconnect fails.

**Design**:
- `SessionManager.getSession()` detects dead session via `session.isAlive`
- Instead of immediately throwing, attempt reconnect with exponential backoff: 1s, 2s, 4s, 8s (max 4 retries, ~15s total to cover NTLM slot hold)
- On successful reconnect: clear all page contexts, throw `SessionLostError` with impacted pageContextIds (LLM still needs to re-open pages, but the session is alive)
- On reconnect failure after all retries: throw `SessionLostError` with `reconnectFailed: true`

**Key detail**: We cannot silently re-open pages because BC page state (selected row, active tab, entered filter) is lost. The LLM must know pages were lost.

**Tests**:
- Unit: mock session.isAlive=false, verify retry timing and backoff
- Unit: verify all pageContextIds are invalidated on reconnect
- Unit: verify reconnectFailed=true after max retries exhausted
- Integration: kill session via protocol error, verify next call gets SessionLostError with valid new session
- Integration: verify second call after SessionLostError succeeds (session is alive)

### 1.2 Modal State Persistence Recovery

**Problem**: If the MCP server crashes without closing forms, BC retains modal dialog state server-side. New sessions for the same user get `LogicalModalityViolationException`. This clears after ~15 seconds.

**Design**:
- When `OpenSession` fails with `LogicalModalityViolationException`, treat it as a transient error
- Retry with same backoff as 1.1 (1s, 2s, 4s, 8s)
- Log a warning: "BC has stale modal state from previous session, waiting for cleanup"

**Tests**:
- Unit: mock OpenSession throwing LogicalModalityViolationException, verify retry behavior
- Integration: intentionally crash session without closeGracefully(), verify recovery on next connect

### 1.3 License Popup Auto-Dismiss

**Problem**: On fresh BC databases, the first session encounters a license notification dialog. This is a system-level dialog that blocks all operations.

**Design**:
- During session initialization (after OpenSession, during first page open), detect `DialogOpened` events
- Check dialog caption/content for license-related keywords ("license", "License Information", "evaluation", "trial")
- Auto-respond with OK to dismiss
- Log info: "Auto-dismissed license notification dialog"

**Tests**:
- Unit: mock DialogOpened event with license caption, verify auto-dismiss sends OK response
- Unit: verify non-license dialogs are NOT auto-dismissed
- Integration: (manual, on fresh database) verify license popup is dismissed and first page opens

### 1.4 Stale Page Context Detection

**Problem**: If the LLM passes an invalid/expired pageContextId, the error is a cryptic protocol failure instead of a helpful message.

**Design**:
- `PageContextRepo.get(id)` already returns undefined for missing IDs
- Every operation that takes pageContextId should check early and throw `InputValidationError`:
  ```
  Page context "abc123" does not exist. Open page contexts: ["def456" (Sales Orders), "ghi789" (Customer Card)]
  ```
- Include page name/ID in the listing so the LLM can self-correct

**Tests**:
- Unit: call each operation with invalid pageContextId, verify InputValidationError with open page list
- Unit: verify error message includes page names from remaining valid contexts
- Integration: open page, close it, try to read from old ID, verify clear error

### 1.5 Invoke Timeout with Session Kill

**Problem**: BC can hang indefinitely on certain operations (confirmed Bug 1 -- legitimate session hangs forever). The current invoke queue has no timeout, so the MCP server hangs too.

**Design**:
- Add `invokeTimeout` config option (default: 30 seconds)
- Wrap each invoke call in `Promise.race([invoke, timeout])`
- On timeout:
  1. Log error: "Invoke timed out after 30s, killing session"
  2. Kill the WebSocket connection (force close)
  3. Mark session as dead
  4. Throw `TimeoutError("BC did not respond within 30s. Session has been killed and will reconnect on next request.")`
- Next request triggers auto-reconnect (1.1)

**Tests**:
- Unit: mock invoke that never resolves, verify TimeoutError after configured timeout
- Unit: verify session is marked dead after timeout
- Unit: verify configurable timeout value
- Integration: (if reproducible) trigger known hang scenario, verify timeout and recovery

---

## Pillar 2: Multi-Company

### 2.1 New Tool: `bc_switch_company`

**Protocol** (verified from decompiled `ChangeCompanyAction`, `NavSystemCodeunitSystemActionTriggers`):
- `InvokeCodeUnit(2000000006, "ChangeCompany", companyName)` -- system codeunit
- This maps to an `InvokeSessionAction` or a dedicated RPC call -- needs protocol investigation during implementation to determine exact wire format
- Server updates session context: CompanyName, CompanyDisplayName, CompanyTableId
- All server-side page state is reset
- The `SessionSettingsChangedHandler` response may carry the new company info

**Tool definition**:
```typescript
{
  name: 'bc_switch_company',
  description: 'Switch to a different company within the current BC session. All open pages will be invalidated -- you must re-open any pages you need after switching. Use bc_list_companies to see available companies.',
  inputSchema: {
    companyName: { type: 'string', description: 'Exact company name to switch to' }
  }
}
```

**Behavior**:
1. Send `InvokeCodeUnit` interaction for company switch
2. Invalidate ALL page contexts in PageContextRepo
3. Update session.company to new company name
4. Return: `{ previousCompany, newCompany, invalidatedPageContextIds }`

**Error cases**:
- Company name doesn't exist: BC returns an error -- surface it clearly
- No pages open: clean switch, no invalidation needed

**Tests**:
- Unit: verify all page contexts invalidated after switch
- Unit: verify return value includes previous and new company
- Integration: switch from CRONUS to another company (if available), verify session.company updated
- Integration: open page, switch company, verify old pageContextId gives stale context error
- Integration: switch to non-existent company, verify clear error message

### 2.2 New Tool: `bc_list_companies`

**Design**: Open the Companies system page (page 357), read the list, close the page. This is a simple wrapper around existing tools but exposed as its own tool for LLM discoverability.

**Tool definition**:
```typescript
{
  name: 'bc_list_companies',
  description: 'List all companies available in the current BC environment. Returns company names that can be used with bc_switch_company. Use this before switching to verify the target company exists.',
  inputSchema: {}  // no parameters
}
```

**Behavior**:
1. Open page 357 (Companies)
2. Read all rows (company names)
3. Close the page
4. Return: `{ currentCompany, companies: [{ name, displayName }] }`

**Tests**:
- Integration: list companies, verify current CRONUS company is in the list
- Integration: verify return format includes currentCompany field

### 2.3 Implementation Location

- New file: `src/operations/switch-company.ts`
- New file: `src/operations/list-companies.ts`
- New interaction type: `InvokeCodeUnitInteraction` in `src/protocol/types.ts`
- New encoder entry in `src/protocol/interaction-encoder.ts`
- Register both tools in `src/mcp/tool-registry.ts`
- Add schemas in `src/mcp/schemas.ts`

---

## Pillar 3: Report Execution

### 3.1 New Tool: `bc_run_report`

**Protocol** (verified from decompiled `RunReportAction`, `PerformReportAction`, `NavReport`):
- `IService.RunReport(reportId)` triggers report execution
- If the report has a request page, BC opens it as a dialog (FormCreated/DialogOpened events)
- The request page has filter controls and option fields
- User fills parameters, sends OK to execute
- Report runs server-side
- Output delivery (PDF/Excel stream via FileActionDialog) deferred to Phase 6

**Tool definition**:
```typescript
{
  name: 'bc_run_report',
  description: 'Execute a BC report by ID. If the report has a request page (parameter dialog), it will be returned as a dialog -- use bc_write_data to fill parameters and bc_respond_dialog to execute. The report runs server-side. Output capture (PDF/Excel) is not yet supported -- use this for reports that perform actions (batch posting, adjustments) or to fill and execute request pages. Common reports: 1306 (Customer Statement), 120 (Aged AR), 6 (Trial Balance).',
  inputSchema: {
    reportId: { type: 'number', description: 'BC report ID to execute' }
  }
}
```

**Behavior**:
1. Send `RunReport` interaction with reportId
2. If request page opens: return it as a structured dialog (fields, filters, options) -- same format as `bc_respond_dialog` returns for other dialogs
3. LLM fills parameters via `bc_write_data` on the request page context
4. LLM sends OK via `bc_respond_dialog` to execute
5. After execution: return success/failure + any triggered dialogs
6. If no request page: report executes immediately, return success/failure

**Request page handling**: A report request page is essentially a dialog with filter controls. The existing dialog infrastructure (DialogOpened events, respond-dialog operation) should handle it. The request page form has `containerType: RequestPageFilters (3)` -- use this to identify it.

**Phase 6 scope** (NOT in Phase 5): Intercepting the `FileActionDialog` callback and capturing the report output stream (PDF/Excel/Word). This requires understanding how `BrowserDownloadFileRequest` maps to WebSocket events and potentially hitting a separate HTTP endpoint.

**Tests**:
- Unit: mock RunReport response with request page dialog, verify structured return
- Unit: mock RunReport response with no request page, verify immediate success
- Unit: verify containerType detection for request pages
- Integration: run report 1306 (Customer Statement), verify request page fields returned
- Integration: fill request page parameters, execute, verify success response
- Integration: run a simple report without request page, verify direct execution
- Integration: run report with invalid ID, verify clear error message

### 3.2 Implementation Location

- New file: `src/operations/run-report.ts`
- New interaction type: `RunReportInteraction` in `src/protocol/types.ts`
- New encoder entry in `src/protocol/interaction-encoder.ts`
- Register tool in `src/mcp/tool-registry.ts`
- Add schema in `src/mcp/schemas.ts`
- Potentially extend event-decoder.ts to handle report-specific events

---

## Pillar 4: Write-Back Polish

No new tools. Improvements to existing operations.

### 4.1 Execute Action: New Record Detection

**Problem**: `bc_execute_action("New")` creates a record and may open a card page, but the LLM doesn't get the new pageContextId back automatically.

**Design**:
- In `execute-action.ts`, after sending New action, check for `FormCreated` events in the response
- If a new page opened: auto-register it in PageContextRepo, include `newPageContextId` in the return value
- Return: `{ success, newPageContextId?, pageType?, dialogsOpened? }`

**Tests**:
- Integration: execute New on Customer List, verify newPageContextId returned
- Integration: verify new page context is usable for bc_write_data
- Integration: execute New on a page where no card opens (line item), verify no newPageContextId

### 4.2 Execute Action: Delete Clarity

**Problem**: Delete with no row selected gives an unclear error.

**Design**:
- Before sending Delete action, check if a repeater row is selected (currentBookmark exists)
- If no row selected: throw `InputValidationError("Cannot delete: no row is selected. Use bc_navigate to select a row first.")`
- Return clear confirmation dialog info so the LLM knows to respond

**Tests**:
- Unit: mock no currentBookmark, verify InputValidationError
- Integration: try delete without selecting a row, verify clear error
- Integration: select row, delete, respond to confirmation, verify deletion

### 4.3 Write Data: Validation Dialog Detection

**Problem**: Some field writes trigger validation dialogs (e.g., "Customer has overdue balance, continue?"). These may get lost in async timing.

**Design**:
- After `SaveValue` completes, explicitly check for `DialogOpened` events in the response
- If a validation dialog opened: include it in the write result alongside the field values
- Return: `{ fields: FieldWriteResult[], dialogOpened?: DialogInfo }`

**Tests**:
- Integration: write a field value that triggers a validation dialog, verify dialog returned in result
- Integration: respond to validation dialog, verify field value is saved
- Unit: mock SaveValue response with DialogOpened event, verify structured return

### 4.4 Tool Description Updates

Update all 8 existing tool descriptions to follow Anthropic 2026 best practices:
- Document create/edit/delete workflow patterns in bc_execute_action description
- Document dialog chaining in bc_respond_dialog description
- Cross-reference related tools (e.g., "after bc_execute_action('New'), use bc_write_data to fill fields")
- Add `input_examples` for complex tools

**Tests**:
- Unit: verify all tool descriptions are >= 3 sentences
- Unit: verify all tools have inter-tool relationship documentation

---

## Testing Strategy

**Integration-first**: Verify against real BC27/BC28, then codify as unit tests.

### Test File Organization

```
tests/
  unit/
    session-reconnect.test.ts        -- 1.1, 1.2 retry/backoff logic
    license-dismiss.test.ts          -- 1.3 auto-dismiss logic
    stale-context.test.ts            -- 1.4 validation errors
    invoke-timeout.test.ts           -- 1.5 timeout handling
    company-switch.test.ts           -- 2.1 context invalidation
    report-execution.test.ts         -- 3.1 request page parsing
    execute-action-new.test.ts       -- 4.1 new record detection
    execute-action-delete.test.ts    -- 4.2 delete validation
    write-data-dialogs.test.ts       -- 4.3 validation dialog detection
    tool-descriptions.test.ts        -- 4.4 description quality checks
  integration/
    session-recovery.test.ts         -- 1.1, 1.2 real reconnect scenarios
    license-popup.test.ts            -- 1.3 (manual, fresh database)
    stale-context.test.ts            -- 1.4 real stale context errors
    invoke-timeout.test.ts           -- 1.5 real timeout scenarios
    multi-company.test.ts            -- 2.1, 2.2 company switch + list
    report-execution.test.ts         -- 3.1 real report runs
    write-back-workflows.test.ts     -- 4.1, 4.2, 4.3 create/delete/validate flows
```

### Test Coverage Targets

Each pillar should have:
- **Happy path**: the normal successful flow
- **Error path**: invalid input, BC errors, timeouts
- **Edge cases**: concurrent operations, empty states, boundary conditions
- **Cross-pillar**: e.g., company switch during report execution, timeout during write-back

### Cross-Pillar Integration Tests

```
tests/integration/
  phase5-cross-pillar.test.ts
```

Scenarios:
- Open page, switch company, verify old context invalid, open new page in new company
- Start report, session dies mid-execution, verify recovery
- Write field, get validation dialog, session times out, verify clean recovery
- Switch company, run report in new company, verify correct company context
- Delete record, get confirmation dialog, switch company before responding (should error cleanly)

---

## Implementation Order

1. **Pillar 1: Robustness** (foundation -- everything else benefits from resilient sessions)
2. **Pillar 4: Write-Back Polish** (improves existing tools, low risk)
3. **Pillar 2: Multi-Company** (new tools, simple protocol, verified from decompiled source)
4. **Pillar 3: Reports** (new tool, most protocol unknowns)

Each pillar is independent and can be merged separately.

---

## Configuration

New environment variables:
```env
BC_INVOKE_TIMEOUT=30000        # Invoke timeout in ms (default: 30s)
BC_RECONNECT_MAX_RETRIES=4     # Max reconnect attempts (default: 4)
BC_RECONNECT_BASE_DELAY=1000   # Base delay for exponential backoff in ms (default: 1s)
```

---

## Out of Scope (Phase 6+)

- Report output capture (PDF/Excel stream via FileActionDialog)
- Multi-session (multiple simultaneous companies)
- OData hybrid read path
- Batch/bulk operations
- Role Center pages
