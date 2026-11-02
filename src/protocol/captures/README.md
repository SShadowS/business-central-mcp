# Wire-format captures

Frozen wire payloads used as test fixtures. Each file is sanitised: any session
keys / IDs replaced with `"REDACTED"`. Captured via `scripts/capture-tell-me.ts`.

## Files

| File | Source | Date |
|---|---|---|
| `tell-me-result-2026-04-28.json` | BC28, `BC_PROFILE="BUSINESS MANAGER"`, Tell Me query `customer` | 2026-04-28 |
| `cuegroup-rolecenter-2026-04-28.json` | BC28, `BC_PROFILE="BUSINESS MANAGER"`, default Role Center (16 hosted forms) | 2026-04-28 |
| `cuegroup-cardpart-standalone-2026-04-28.json` | BC28, standalone OpenForm of pages 1310 / 9061 / 9152 (CardParts) | 2026-04-28 |
| `error-messages-page-2026-11-02.json` | BC 29.1 (cronus291), the page 700 "Error Messages" handlers (FormToShow + its rows) from the Yes response to "Do you want to post the invoice?" on a Sales Invoice whose only line has Quantity 0 (#53, `scripts/probe-post-error.ts`) | 2026-11-02 |

## Tell Me wire shape (verified 2026-04-28 against BC28 BUSINESS MANAGER profile)

### Form structure

`SystemAction.PageSearch=220` opens the Tell Me search form as a regular
`FormCreated` event (NOT a `DialogToShow` — Tell Me is non-modal on BC28). The
form caption is `"Tell me what you want to do"`, with `MappingHint:
"PageSearchForm"` and `Name: "PageSearchForm"`.

The search form's children are:

```
server:c[0]   gc (container)
server:c[0]/c[0]   sc (text input, the actual search field)   <-- SaveValue here
server:c[1]   rc (primary results repeater — pages and lists)
server:c[2]   rc (secondary results repeater — reports and other run-targets)
```

**Critical:** the search input is at `server:c[0]/c[0]`, NOT `server:c[0]`.
SaveValue against the gc container at `server:c[0]` returns `InvokeCompleted`
only — no `DataLoaded`, no rows. This is the limits.md #5 root cause for the
default-profile env: the SearchService was sending against the wrong path.

### Result row shape

After SaveValue with the actual query, BC emits TWO DataLoaded streams (one
per repeater) plus surrounding PropertyChanged events:

1. `PropertyChanged { controlPath: server:c[0]/c[0], changes: { StringValue: <query> } }` — echoes the search input.
2. `PropertyChanged { controlPath: server:c[1], changes: { 'Data.CurrentBookmark': <uuid> } }` — selects the first hit in the primary list.
3. `DataLoaded { controlPath: server:c[1], rows: [...] }` — primary results (typically pages/lists).
4. `DataLoaded { controlPath: server:c[2], rows: [...] }` — secondary results (reports and other categories).

Both DataLoaded events use the same row schema (named cells, see below). The
extractor walks every DataLoaded in the response and merges results — the
caller doesn't need to know about the two-stream split. In the captured
fixture, c[1] yields 23 rows and c[2] yields 32 rows for query `customer`,
totaling 55 results.

Each row follows the standard wire shape (`DataRowInserted: [index, payload]`)
with these named cells:

```json
{
  "Icon":                       { "type": "image", "source": "Resources/Images/static/transparentIcon.gif" },
  "Name":                       { "stringValue": "Customer List", "canInvoke": true },
  "DepartmentPath":             { "stringValue": "Departments/Financial Management/Receivables" },
  "DepartmentCategory":         { "stringValue": "Lists" },
  "SearchScore":                { "stringValue": "9" },
  "AdditionalSearchTermMatched": { "stringValue": "False" },
  "IsBookmarked":               { "stringValue": "False", "canInvoke": true },
  "CacheKey":                   {},
  "Source":                     { "stringValue": "[{ \"page\": \"Customer List\"}]" },
  "Description":                {}
}
```

Cells are KEYED by name (not positional binders like generic repeaters). The
column-header schema is published in `FormCreated.controlTree.Children[1].Columns`
under `Name` (e.g. `"Name"`, `"DepartmentPath"`, `"Source"`).

### Source format and run-target extraction

The `Source.stringValue` is a JSON-encoded string with one element shaped as
`[{ <objectType>: <objectName> }]`. Observed object types in this capture:

| Object type | Examples |
|---|---|
| `page` | `Customer List`, `Customer Card`, `Cash Receipt Journal`, ... |
| `report` | `Create Customer Journal Lines`, `Shpfy Sync Customers` |

BC's Tell Me identifies pages by **name** (the AL `name` property of the page
object), not by the numeric page ID. So a Tell Me result for "Customer List"
produces `Source: '[{"page": "Customer List"}]'`, not `'[{"page": "22"}]'`.

The extractor (`src/services/tell-me-extractor.ts`) parses this JSON and
returns:

```ts
{
  name: cells.Name.stringValue,           // "Customer List"
  objectType: 'page' | 'report' | ...,    // from Source key
  runTarget: '<objectName>',              // from Source value, e.g. "Customer List"
  departmentPath: cells.DepartmentPath.stringValue,
  category: cells.DepartmentCategory.stringValue,  // "Lists" / "Tasks" / ...
  score: parseInt(cells.SearchScore.stringValue, 10),
}
```

### How callers use the result

`bc_open_page` currently takes a numeric `pageId`. To open a Tell Me hit,
callers need to map name → id. Options:

1. The user already knows the page id (most common case, hardcoded reference tables).
2. A future enhancement to `bc_open_page` could accept either a numeric id or a
   page name and resolve via BC's metadata service. Out of scope for Plan D.
3. The `bc_search_pages` result documents the run-target name; the LLM can
   often infer the numeric id from the name + context, or open the page via
   the role center / navigation.

Plan D's contract: `SearchResult` carries `name` (display) and `runTarget`
(BC page/report name). The MCP user gets enough information to either know
which page to open by id or to ask BC for the metadata.

## Role Center + cuegroup wire shape (verified 2026-04-28 against BC28 BUSINESS MANAGER profile)

Captured via `scripts/capture-rolecenter.ts`. Two fixtures are produced in a
single run:

- `cuegroup-rolecenter-2026-04-28.json` — full event stream from
  `OpenForm { query: "tenant=default&runinframe=1" }` (no `page=` parameter,
  so BC resolves the user's default Role Center).
- `cuegroup-cardpart-standalone-2026-04-28.json` — opens three CardParts
  standalone (page IDs 1310 / 9061 / 9152) and records each FormCreated.

### Role Center structure

The default Role Center for the BUSINESS MANAGER profile (page 9022 — "Order
Processor Role Center" in some BC builds; here it resolves via the empty
query) is a host page. Its top-level `lf` contains 16 `fhc` (FormHost)
descendants. Each `fhc` wraps exactly one hosted `lf` (the CardPart / part
page). Hosted forms observed in this fixture:

| Caption | PageType | Notes |
|---|---|---|
| Checklist Banner | 19 (BannerPart) | |
| Headline | 12 (HeadlinePart) | |
| Activities | 3 (CardPart) | **cuegroup** — page 1310 "O365 Activities" |
| User Tasks | 3 (CardPart) | |
| Job Queue Tasks | 3 (CardPart) | |
| Email Status | 3 (CardPart) | |
| Approvals | 3 (CardPart) | |
| E-Document Activities | 3 (CardPart) | |
| Intercompany | 3 (CardPart) | |
| Self-Service | 3 (CardPart) | |
| Shopify Activities | 3 (CardPart) | |
| Business Performance | 3 (CardPart) | |
| My Accounts | 4 (ListPart) | |
| Trial Balance | 3 (CardPart) | |
| Power BI | 3 (CardPart) | |
| Report Inbox | 4 (ListPart) | |

Hosted forms expose their AL design via `DesignName` (e.g. "O365 Activities",
"Headline RC Business Manager") on the hosted `lf`. The fhc's `ServerId` is
BC's hex form-handle (e.g. `"3C36"`), NOT a numeric page id; reusing it as
`page=<hex>` produces `FormActivatorException: Parameter id must be a valid
number between 1 and 2147483647.` To open a hosted CardPart standalone you
must know its numeric AL page id (or its AL `Name`).

### Cuegroup discriminator (preliminary — confirmed in Task 2)

A cuegroup-bearing CardPart is identified by the presence of `t === 'stackgc'`
descendants. Each `stackgc` is the wire encoding of an AL `cuegroup` element;
its children are typically:

```
stackgc            (cuegroup)
  gc {MappingHint:"STACKGROUP"}
    stackc         (individual cue tile — the cue field)
    stackc
    ...
  gc {MappingHint:"LAYOUTGROUP"}
    ac             (cuegroup-level actions, MappingHint:"LINK")
```

`stackc` controls represent the cue values themselves. They carry `Caption`
(display label) and `DesignName` (AL field name). The numeric value (count /
amount) of a cue is delivered later as a `PropertyChanged` against the
`stackc` path — the initial FormCreated does NOT carry the count integers
inline. (No `i32c` descendants are present in either the role-center-hosted
or the standalone capture's FormCreated tree.)

Activities (page 1310) in this fixture has 11 `stackgc` groups containing 22
`stackc` cue tiles. Captions include "Sales This Month", "Overdue Sales
Invoice Amount", "Sales Quotes", "Sales Orders", etc. The hosted-form lf
also contains a `gc` with `MappingHint:"TOOLBAR"` whose `ac` actions include
"Refresh Data" and "Set Up Cues" — the latter is the canonical Cue
configuration entry point and reinforces that this is a CueGroup CardPart.

### Standalone CardPart behaviour (limits.md #1)

On this BC28 default environment, opening CardParts directly via
`OpenForm { query: "page=<id>&tenant=..." }` does **not** reproduce the stub
symptom from limits.md #1. Three standalone OpenForm attempts were made:

| Page | Children in FormCreated | Notes |
|---|---|---|
| 1310 — O365 Activities | 14 | full structure (11 stackgc, 22 stackc) |
| 9061 — Sales Cue | 5 | full structure (cuegroup + actions) |
| 9152 — Customer Statistics FactBox | 4 | full structure |

In all three cases BC returns a fully populated control tree, not a
placeholder shell. The standalone page 1310 tree is structurally identical
to the role-center-hosted version (same stackgc/stackc topology). limits.md
#1 (CDO Document Output Queues stub) was diagnosed against a Continia
extension page and likely depends on a Continia-specific code path not
present on the default BC28 install — this fixture documents the
counterexample.

In all CardPart fixtures (hosted and standalone), the `i32c` cue *values*
are absent from the initial FormCreated and arrive after a follow-up
`LoadForm { loadData: true }` as `PropertyChanged` events.
