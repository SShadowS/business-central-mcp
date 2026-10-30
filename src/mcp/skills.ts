// src/mcp/skills.ts
//
// MCP Skills extension (SEP-2640, io.modelcontextprotocol/skills). A skill is a
// SKILL.md served over the Resources primitive: skills/list + skills/get return
// its manifest, resources/read returns its bytes. The content is embedded here
// and its digest/size are computed at load, so the manifest can never go stale.

import { createHash } from 'node:crypto';

export interface SkillResourceManifest {
  readonly uri: string;
  readonly digest: string; // "sha256:<hex>"
  readonly size: number;   // raw UTF-8 byte length
}
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}
export interface SkillEntry {
  readonly uri: string;
  readonly frontmatter: SkillFrontmatter;
  readonly resources: SkillResourceManifest[];
}
export interface SkillDefinition {
  readonly entry: SkillEntry;
  readonly content: string; // full SKILL.md (frontmatter + body) — the bytes served
}

/** SEP-2640 cache fields: freshness hints only, not integrity. */
export const SKILL_TTL_MS = 300_000;
export const SKILL_CACHE_SCOPE = 'public';

/** Assemble a single-file skill, deriving uri/digest/size from the served bytes. */
function defineSkill(name: string, description: string, body: string): SkillDefinition {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.replace(/^\n+/, '')}`;
  const bytes = Buffer.from(content, 'utf8');
  const uri = `skill://${name}/SKILL.md`;
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  return { content, entry: { uri, frontmatter: { name, description }, resources: [{ uri, digest, size: bytes.byteLength }] } };
}

const RECOVERY_BODY = `
# Recovering from a failed Business Central UI action

This server drives the BC web client. Mutating tools — \`bc_execute_action\`,
\`bc_write_data\`, \`bc_respond_dialog\`, \`bc_wizard_navigate\`, \`bc_close_page\`,
\`bc_switch_company\`, \`bc_run_report\`, \`bc_upload_file\`, \`bc_run_tests\` — can fail mid-flow.
Follow the rules below instead of blindly retrying; a blind retry on a mutating
call can double-post.

## 1. Make every mutating call idempotent

Pass an \`operationId\` (a UUID you generate and keep) on every mutating call.
A retry with the same \`operationId\` and the same arguments replays the first
call's result without touching BC. Each result carries \`replaySafe\`: \`true\`
means BC proved a re-run cannot double-apply (the write was echoed, or the form
it acted on is now closed); \`false\` means read the record back before retrying.

## 2. Confirm and choice dialogs

\`bc_execute_action\` (e.g. a Post) often opens a dialog instead of finishing.
The result then carries \`requiresDialogResponse: true\` and the dialog's
\`dialogFormId\`, and the new form appears in \`openedPages\`. Answer it:

    bc_respond_dialog { dialogFormId: "<from the result>", response: "yes" }

\`response\` is one of \`"yes"\`, \`"no"\`, \`"ok"\`, \`"cancel"\`. A posting-choice
dialog ("Ship / Invoice / Ship and Invoice") needs the choice selected before
you confirm. After answering, re-read with \`bc_read_data\`; a \`BUSINESS_ERROR\`
means BC rejected the operation — surface the message, do not retry the post.

## 3. A dropped or dead session (SESSION_LOST)

A session-killing error returns code \`SESSION_LOST\` with
\`impactedPageContextIds\` (now dead) and \`reconnectFailed\`. The server already
reconnected with backoff; you do NOT reconnect yourself. Instead:

1. Treat every \`pageContextId\` you held as invalid — re-open the pages you need
   with \`bc_open_page\` (and re-\`bc_navigate\` / re-drill to the record).
2. If the lost call was a mutation, go to section 5 before repeating it.
3. \`reconnectFailed: true\` means the server could not get back in — stop and
   report; do not loop.

A stale modal from a crashed session is reconciled by the server automatically
(it closes leftover dialogs). You only retry the original call once the new
session is up.

## 4. Multi-row actions, card stubs, company names

- \`MULTI_ROW_ACTION_UNAVAILABLE\`: the action (usually Delete) is disabled by BC
  for a multi-row selection on this page. Do not retry the set — act one row at
  a time, or reduce the selection.
- \`CARDPART_STUB\` (code \`CARDPART_STUB\`): a CardPart opened standalone returned
  an empty shell. Reach it through its host page named in the error's
  \`hostHint\`, not directly.
- \`COMPANY_NOT_FOUND\` from \`bc_switch_company\`: company names are
  case-SENSITIVE and the session is untouched (still on the old company). Fix
  the name (list valid ones with \`bc_list_companies\`) and retry.

## 5. An in-doubt write — did it land?

A \`TIMEOUT\`, \`SESSION_LOST\`, or \`OPERATION_IN_DOUBT\` on a mutating call means
the outcome is unknown: BC may have committed. Before retrying under a NEW
\`operationId\`, read the record back:

    bc_get_operation { operationId: "<the same id>" }

It re-opens the target by page id and record bookmark, reads the key fields and
(for a document) its lines, and returns \`readBack\` plus an \`evidenceHash\`. Use
that to decide: if the change is already present, do not re-run; if it is
absent and \`replaySafe\` was false, run the call again under a fresh
\`operationId\`. Never retry an in-doubt post without this check.
`;

// Every AL example and syntax rule below was compiled and run against BC 29.1
// (Cronus291, 2026-10-30), including the FlowField filter (AL0672) and
// TopNumberOfRows-vs-top behaviour.
const DATA_QUERY_BODY = `
# Querying Business Central data with AL queries

\`bc_data_query\` compiles an AL \`query\` object you write and runs it against
any table the user can read: tables with no API page, extension tables,
ledger entries. BC compiles it as a dynamic object (nothing is published) and
always runs it read-only with the user's permissions and security filters.
It needs BC 29+ with "Data Query Tools (Preview)" enabled in BC's MCP Server
Configuration; otherwise every \`bc_data_*\` tool returns
\`BC_MCP_UNAVAILABLE\` (use \`bc_query\` for Standard API entities instead).

## 1. Workflow

1. \`bc_data_find_tables\` with \`searchMode: "keyword"\` and comma-separated
   name fragments ("customer, ledger entry") to get table IDs. \`"semantic"\`
   takes plain language but can come back empty on-prem; then use keyword.
2. \`bc_data_get_table_schema\` for EVERY table you use. Field names vary by
   version and extensions, and a wrong name is a compile error. Use
   \`nameContains\` on wide tables. FlowFields show their formula.
3. \`bc_data_get_table_relations\` (\`direction: "outgoing"\`, optionally
   \`relatedToTableIds\`) to find the field that links two tables.
4. \`bc_data_query\` without \`returnData\` to compile and check the columns,
   then with \`returnData: true\` to get rows.

## 2. Query shape

    query 50100 CustomerList
    {
        elements
        {
            dataitem(Cust; Customer)
            {
                column(No; "No.") { }
                column(Name; Name) { }
                column(City; City) { }
            }
        }
    }

- Exactly one \`query\` object per call. Any ID and name work.
- \`dataitem(<alias>; <table name>)\`, \`column(<column name>; <field>)\`.
  Quote names with spaces or dots: \`"No."\`, \`"Cust. Ledger Entry"\`.
- Column names must be unique across the whole query and are what the
  result's \`columns\` array reports.

## 3. Let BC aggregate

Prefer one aggregating query over paging through raw rows.

    query 50101 OpenInvoicesByCustomer
    {
        OrderBy = descending(Amount);
        elements
        {
            dataitem(CLE; "Cust. Ledger Entry")
            {
                DataItemTableFilter = "Document Type" = const(Invoice), Open = const(true);
                column(CustomerNo; "Customer No.") { }
                column(Amount; "Remaining Amount") { Method = Sum; }
                column(Entries) { Method = Count; }
            }
        }
    }

- \`Method = Sum | Average | Min | Max | Count\`. A \`Count\` column has no field.
  Non-aggregated columns become the grouping.
- \`DataItemTableFilter\` filters rows on NORMAL fields: \`Field = const(Value)\`
  for one value, \`Field = filter(<BC filter>)\` for ranges and lists, e.g.
  \`"Sales (LCY)" = filter(>1000)\`, \`"No." = filter('10000|20000')\`.
- A FlowField (the schema shows "FlowField: ...") cannot go in
  \`DataItemTableFilter\` (error \`AL0672\`). Filter it with \`ColumnFilter\` on
  its column, \`column(Amount; Amount) { ColumnFilter = Amount = filter(>1000); }\`,
  or, to filter without returning it, a filter element:
  \`filter(AmountFilter; Amount) { ColumnFilter = AmountFilter = filter(>1000); }\`.
- \`OrderBy = descending(<column>)\` (or \`ascending\`), comma-separated for
  several. It names COLUMNS, not fields.
- Limit rows with the tool's \`top\`, not \`TopNumberOfRows\`: \`top\` (default 10)
  decides how many rows come back, while \`TopNumberOfRows\` only changes
  \`totalCount\`.

## 4. Joins

Nest the child dataitem and link it with \`DataItemLink\`:

    query 50102 CustomerSales
    {
        OrderBy = descending(Sales);
        elements
        {
            dataitem(Cust; Customer)
            {
                column(No; "No.") { }
                column(Name; Name) { }
                dataitem(CLE; "Cust. Ledger Entry")
                {
                    DataItemLink = "Customer No." = Cust."No.";
                    SqlJoinType = InnerJoin;
                    DataItemTableFilter = "Document Type" = const(Invoice);
                    column(Sales; "Sales (LCY)") { Method = Sum; }
                }
            }
        }
    }

- \`DataItemLink = <child field> = <parent alias>.<parent field>\`. Get the
  pair from \`bc_data_get_table_relations\`.
- \`SqlJoinType\`: \`LeftOuterJoin\` (default: parents without children
  still appear), \`InnerJoin\` (only matches), \`RightOuterJoin\`,
  \`FullOuterJoin\`, \`CrossJoin\`.

## 5. Dates

    column(PostingYear; "Posting Date") { Method = Year; }

\`Method = Year | Month | Day\` turns a date column into a number you can
group by, e.g. sales per year with a \`Sum\` column next to it.

## 6. Results and paging

- \`returnData: true\` returns \`columns\` (names) and \`rows\` (arrays in column
  order). Dates come back as ISO strings, decimals as numbers, and Year/Month/Day
  columns as numbers.
- \`top\` is 1-50 (default 10). \`skip\` pages forward (max 100000).
  \`totalCount\` comes only with the first page (\`skip: 0\`); \`hasMore\` says
  whether another page exists.
- If BC answers "Pagination not supported for this query shape", add an
  \`OrderBy\` so the order is deterministic.
- \`company\` runs the query in another company (exact, case-sensitive name).

## 7. Errors

- \`DATA_QUERY_ERROR\` with "Compilation failed" lists AL diagnostics with
  (line,column) positions in your text. \`AL0345\` is an unknown field or a
  field on the wrong table: check \`bc_data_get_table_schema\` and fix it.
  Do not guess field names; read the schema.
- \`BC_MCP_UNAVAILABLE\` has \`details.reason\`: \`endpoint-missing\`
  (BC < 29), \`mcp-disabled\` (MCP Server capability off) or
  \`tools-disabled\` (Data Query Tools off). An admin has to fix it in BC;
  retrying does not help.
`;

// Verified against BC 29.1 (Cronus291, 2026-10-30) with customers API page
// 30009 enabled for writes in the MCP configuration.
const API_ACTIONS_BODY = `
# Reading and changing Business Central data through its APIs

The \`bc_api_*\` tools use the API tools of Business Central's own MCP server
(BC 29+). They reach every installed API page and API query the user can
read: Microsoft's standard APIs, ISV and custom extension APIs.

## 1. Action names

\`bc_api_search\` returns names of the form \`<Verb>_<EntitySet>_<PAG|QRY><id>\`:

- \`List_Customers_PAG30009\` reads the customers API page (object 30009).
- \`List_CustomerLedgerEntries_QRY30302\` reads an API query.
- \`Create_Customer_PAG30009\`, \`Modify_Customer_PAG30009\`,
  \`Delete_Customer_PAG30009\` write (note the singular entity name).
- Bound actions (e.g. posting a document) use the action's name as the verb.

Search by entity words ("customer", "sales invoice", "ledger"). Pass
\`actionTypes: ["List"]\` to find readable data only.

## 2. Who can do what

- Reads: every API the user has permission to read is listed, with no setup.
- Writes: Create/Modify/Delete/bound actions are listed ONLY for API objects
  an admin added to BC's MCP Server Configuration with those permissions. If
  a write action is missing from the search, that is why. Tell the user;
  do not try to work around it.

## 3. Reading: bc_api_list

1. \`bc_api_describe\` the List action. Its \`schema.properties._availableFields\`
   lists each field with type and option values, and which are filterable.
   The schema only has \`orderby\` when the API allows sorting.
2. \`bc_api_list\` with \`filter\`, \`select\`, \`orderby\`, \`top\` (default 10) and
   \`skip\`. Read \`totalCount\` and \`hasMore\` for paging.

Filter rules (BC's): operators \`eq ne lt le gt ge and or\`; functions
\`contains startswith endswith tolower toupper\`. \`or\` only on the SAME field,
\`and\` across fields; no \`not\` (use \`ne\`); no arithmetic or date functions.
Case-insensitive search: \`contains(tolower(displayName),'contoso')\`.
Strings take single quotes, GUIDs and numbers none: \`id eq 99c9a42c-...\`.

## 4. Changing data: bc_api_invoke

Always \`bc_api_describe\` the action first and send exactly its properties in
\`parameters\`.

- Create: the field values, e.g. \`{ "displayName": "Contoso" }\`. Returns the
  new record with its \`id\` and \`@odata.etag\`.
- Modify: \`{ "id": "<id>", "If-Match": "<current @odata.etag>", ...fields }\`.
  Read the etag with \`bc_api_list\` (or take it from the Create/Modify result).
  A stale etag fails with \`API_ACTION_ERROR\` and \`odataCode\`
  \`Request_EntityChanged\`: re-read the record and retry with the new etag.
  Returns the record with its new etag.
- Delete: \`{ "id": "<id>" }\`. Returns no result. A record that is already gone
  fails with \`BadRequest_ResourceNotFound\`.

BC runs its normal validation and business logic. A rejection is
\`API_ACTION_ERROR\` with BC's message, and nothing was changed.

## 5. Retries

Pass an \`operationId\` (a UUID you keep) on every \`bc_api_invoke\`. A retry
with the same id replays the first result without calling BC. \`replaySafe\`:

- \`true\` for Modify and Delete: a repeat is refused by BC (stale etag, or the
  record is gone), so it cannot apply twice.
- \`false\` for Create and bound actions: a repeat would create or post again.
  After a timeout or lost connection, check with \`bc_api_list\` whether the
  record exists before running it again under a new id.

## 6. Which tool for what

- Data behind an API: \`bc_api_list\`.
- Tables with no API, or totals and joins: \`bc_data_query\` (AL query, see the
  bc-data-query skill).
- Changes that need the UI's dialogs or pages: \`bc_open_page\`,
  \`bc_write_data\`, \`bc_execute_action\`.
- Before BC 29 (\`BC_MCP_UNAVAILABLE\`): \`bc_query\` for Standard API entities.
`;

export const SKILLS: SkillDefinition[] = [
  defineSkill(
    'bc-ui-recovery',
    'Recover from failures of the mutating Business Central UI tools (bc_execute_action, bc_write_data, bc_respond_dialog, bc_wizard_navigate, bc_close_page): answer confirm/choice dialogs, reconnect after a dropped session, and decide whether an in-doubt write landed before retrying. Read this before driving any posting, deletion, or multi-step document flow.',
    RECOVERY_BODY,
  ),
  defineSkill(
    'bc-data-query',
    'Write and run AL query objects with bc_data_query (BC 29+) to read, aggregate and join any Business Central table, including tables without an API page: the find-tables -> schema -> relations -> query workflow, AL query syntax for filters, aggregations, joins and date grouping, paging, and fixing compile errors. Read this before the first bc_data_query call.',
    DATA_QUERY_BODY,
  ),
  defineSkill(
    'bc-api-actions',
    'Find, read and change Business Central data through any installed API page or query (BC 29+) with bc_api_search, bc_api_describe, bc_api_list and bc_api_invoke: action names, which writes an admin must enable, OData filter rules, the If-Match etag flow for Modify, and safe retries. Read this before the first bc_api_invoke.',
    API_ACTIONS_BODY,
  ),
];

/** The SKILL.md resource for a resources/read uri, or undefined. */
export function findSkillResource(skills: SkillDefinition[], uri: string): { text: string } | undefined {
  const hit = skills.find(s => s.entry.uri === uri);
  return hit ? { text: hit.content } : undefined;
}
