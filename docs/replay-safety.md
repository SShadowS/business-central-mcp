# Retries, `operationId` and `replaySafe`

The ten tools that change state (`bc_write_data`, `bc_execute_action`, `bc_respond_dialog`, `bc_wizard_navigate`, `bc_close_page`, `bc_switch_company`, `bc_run_report`, `bc_upload_file`, `bc_run_tests`, `bc_api_invoke`) accept an optional `operationId`: an idempotency key you generate.

| Retry with the same id | Result |
|------------------------|--------|
| same arguments, first call completed | the stored result, BC is not called again |
| different arguments | `OPERATION_ID_REUSED` |
| first call's outcome unknown (timeout, session loss) | `OPERATION_IN_DOUBT`: check the record before acting under a new id |

`OPERATION_IN_DOUBT` carries a `target` snapshot taken before the first call ran: company, page id and caption, section, the targeted rows' cell values, the dialog. You can find the record again even though the original `pageContextId` died with the session. Calls are recorded in `STATE_DIR/operations/`, so this survives a server restart.

Replay is time-limited. The server prunes the ledger at start and hourly: a completed entry is deleted after `BC_OPERATION_TTL` (default 24 hours), and after that the same id runs the call again, so check with `bc_get_operation` before a late retry. `sent`/`unknown` entries are kept for `BC_OPERATION_INDOUBT_TTL` (default 30 days). Download bytes are not stored: a replayed result lists each download's `fileName`, `contentType`, `sizeBytes` and `savedPath`, but not its `bytes`, and marks it `error.code: "NOT_REPLAYED"`.

## `replaySafe`

Every result from those tools (and its ledger entry) carries `replaySafe`. `true` means BC's response proved that running the same call again, even under a new `operationId`, cannot apply the change twice. `false` means a re-run may double-apply, or nothing in the response proved otherwise: read the record back first. The server only says `true` when it can prove it:

| Tool | `replaySafe: true` when |
|------|-------------------------|
| `bc_write_data` | BC echoed every written value (it echoes only a value that changed, and a write to a read-only field is silently dropped), and no dialog is pending |
| `bc_execute_action` | the action was Refresh, or BC closed the form the action ran on (a re-run on a closed form is rejected with `FormNotFoundException`) |
| `bc_respond_dialog` | BC closed the dialog form |
| `bc_wizard_navigate` | BC closed the wizard form (finish/cancel); next/back never |
| `bc_close_page` | no save/discard dialog blocked the close (closing a closed form is a no-op) |
| `bc_switch_company` | the session ends on the requested company (a switch to the current company is a no-op that keeps open pages) |
| `bc_api_invoke` | Modify (it needs the current `@odata.etag` as `If-Match`, so a repeat is refused) and Delete; never Create or a bound action |
| `bc_run_report`, `bc_upload_file`, `bc_run_tests` | never: a re-run reruns the report, the import or the tests |

`OPERATION_IN_DOUBT` is always `replaySafe: false`, and so is the first error response to an ambiguous failure (`TIMEOUT_ERROR`, `SESSION_LOST`, `CONNECTION_ERROR`, `PROTOCOL_ERROR`, `ABORTED_ERROR`, or an unclassified error), with or without an `operationId`. Definite failures (validation, business errors) carry no verdict, because nothing was applied.

## `bc_get_operation`

`bc_get_operation { operationId }` (read-only) returns the ledger entry: status, tool, timestamps, `replaySafe`, the stored result and the `target` snapshot.

When the status is not `completed` or `replaySafe` is false, it also reads the target back in the current session. It re-opens the page by page id on the recorded record bookmark and reads:

- the record's primary-key fields, by table field number from the page's own key metadata. A key field with no control on the page (a Sales Order's "Document Type") is decoded from the record bookmark and marked `source: "bookmark"`, an option as its ordinal. A key that no longer matches returns `readBackError: KEY_MISMATCH` without an `evidenceHash`;
- the written fields, or the targeted list row (`null` if it is gone);
- for a document header, its loaded `lines`, since a posting changes line state such as "Quantity Shipped" but not the header key.

It closes the page and returns that as `readBack` with `evidenceHash`, the SHA-256 of its sorted-key JSON.

It refuses rather than guess:

| `readBackError` | Why |
|-----------------|-----|
| `COMPANY_MISMATCH` | the session is on another company; it never switches for you |
| `MODAL_OPEN` | a dialog is open, and opening a page would cancel it. Answer it first |
| `NO_TARGET` | no recorded record bookmark; it never opens a page unkeyed |
| `RECORD_NOT_OPENED` | BC could not open the record, or landed on a different one (a deleted record opens the nearest one) |

A card in edit mode keeps a written value until the page closes or leaves the record, so a read-back taken while the original page is still open can show the old value.

## REST transport

The HTTP transport's REST API (`POST /api/v1/...`) uses the same ledger. Its three mutating routes take the key in an `Idempotency-Key` header and record it under the MCP tool name (`pages/write` = `bc_write_data`, `pages/action` = `bc_execute_action`, `pages/close` = `bc_close_page`), so a key means the same operation on both transports and `bc_get_operation` can look up a REST call.

| Case | HTTP status |
|------|-------------|
| success | `200` |
| replay of a completed call | `200` with the stored body and `Idempotent-Replayed: true` |
| `OPERATION_ID_REUSED` | `422` |
| `OPERATION_IN_DOUBT` | `409`, body `{ code, operationId, status, replaySafe: false, target, ... }` |
| definite failure (validation, business error) | `400` |
| sign-in required | `401` |
| `TIMEOUT_ERROR` | `504` |
| other ambiguous failure | `503` |
| unclassified error | `500` |

Ambiguous failures (`503`/`504`/`500`) of a mutating route carry `replaySafe: false`, with or without a key. Read-only routes ignore the header.
