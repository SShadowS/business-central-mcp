# Multi-Section Document Page Architecture

**Date**: 2026-04-03
**Status**: Draft
**Approach**: B -- Form-First with Section View

## Problem

Document pages (Sales Order 42/43, Purchase Order 50/51) have multiple repeaters: a header section with card fields and a lines subpage with a repeater for line items. The current `PageState` tracks a single repeater, causing `InvalidBookmarkException` when drilling down from document list pages.

Root causes in current code:
- `StateProjection.applyEvent` filters `event.formId === state.formId`, dropping all child form events
- `control-tree-parser` stops at the first `rc` (repeater) node
- All services hardcode `state.formId` and `state.repeater` -- no section routing

BC's actual model: subpages are separate child forms via `FormHostControl`, each with their own `formId`. The wire protocol already provides formId and controlPath per event. We just don't use it.

## Architecture

Two layers:

```
LLM tools  -->  SectionResolver  -->  FormState map
              (derived view)         (source of truth)
```

**FormState** mirrors BC's per-form reality. One per `formId`. Independently projected from events.

**SectionDescriptor** is a derived pointer from sectionId to `(formId, controlPath, kind)`. This is what tools use.

**PageContext** coordinates: which forms belong together, which sections exist, what dialogs are open.

## Type Definitions

### FormState (new -- one per BC form)

```typescript
interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  readonly controlTree: ControlField[];
  readonly repeaters: ReadonlyMap<string, RepeaterState>;  // controlPath -> RepeaterState
  readonly actions: ActionInfo[];
  readonly filterControlPath: string | null;
  readonly containerType?: ControlContainerType;
}
// Note: currentBookmark and totalRowCount live on RepeaterState, not here.
// A form can have multiple repeaters (rare but possible).
// FormProjection routes events by controlPath to the correct repeater.
// Convenience: most forms have 0 or 1 repeater. Use helper:
//   primaryRepeater(form: FormState): RepeaterState | null
//     -> returns first (and usually only) repeater, or null

enum ControlContainerType {
  ContentArea = 0,
  FactBoxArea = 1,
  RoleCenterArea = 2,
  RequestPageFilters = 3,
  DetailsArea = 4,
}
```

### SectionDescriptor (new -- derived pointer)

```typescript
interface SectionDescriptor {
  readonly sectionId: string;         // "header", "lines", "factbox:customerStats"
  readonly kind: SectionKind;
  readonly caption: string;
  readonly formId: string;            // -> PageContext.forms.get(formId)
  readonly repeaterControlPath?: string;
}

type SectionKind = 'header' | 'lines' | 'factbox' | 'requestPage' | 'subpage';
// 'subpage' = unknown child form, treated as read-only until proven otherwise.
```

### PageContext (replaces PageState)

```typescript
interface PageContext {
  readonly pageContextId: string;
  readonly rootFormId: string;
  readonly pageType: 'Card' | 'List' | 'Document' | 'Unknown';
  readonly caption: string;
  readonly forms: ReadonlyMap<string, FormState>;
  readonly sections: ReadonlyMap<string, SectionDescriptor>;
  readonly dialogs: DialogInfo[];
  readonly ownedFormIds: string[];    // formIds belonging to this context (for cleanup)
  // Note: openFormIds for invoke calls is tracked at session level, not here.
}
```

### RepeaterState (extended)

```typescript
interface RepeaterState {
  readonly controlPath: string;
  readonly columns: RepeaterColumn[];
  readonly rows: RepeaterRow[];
  readonly totalRowCount: number | null;  // null = unknown. Set from PropertyChanged, NOT rows.length.
  readonly currentBookmark: string | null;  // per-repeater, set from BookmarkChanged events
}

interface RepeaterColumn {
  readonly controlPath: string;       // e.g., "{repeater}/co[2]"
  readonly caption: string;
  readonly type: string;
  readonly columnBinderName?: string;  // NEW: key that matches row.cells keys
  readonly columnBinderPath?: string;  // for filter column IDs
}
```

### InvokeResultEnvelope (new -- unified return type)

```typescript
interface InvokeResultEnvelope<T = void> {
  readonly success: boolean;
  readonly value?: T;
  readonly error?: { message: string; availableSections?: string[]; suggestion?: string };
  readonly changedSections: string[];           // sections whose data changed
  readonly openedPages: Array<{ pageContextId: string; caption: string }>;
  readonly dialogsOpened: DialogInfo[];
  readonly requiresDialogResponse: boolean;
}
```

## Event Routing

### Current (broken)

```
BCEvent(formId=X) --> PageContextRepo --> StateProjection
                      filters: formId === rootFormId only
```

### New

```
BCEvent(formId=X) --> PageContextRepo --> formId lookup --> FormProjection
                      routes to correct FormState
                      then updates section descriptors
```

### PageContextRepository changes

```typescript
class PageContextRepository {
  private readonly pages = new Map<string, PageContext>();
  private readonly formIdIndex = new Map<string, string>();  // formId -> pageContextId

  applyEvents(events: BCEvent[]): void {
    for (const event of events) {
      const formId = 'formId' in event ? event.formId : undefined;
      if (!formId) continue;

      // CRITICAL: Events that introduce NEW forms must be routed by their
      // PARENT formId, not their own (which isn't indexed yet).
      if (event.type === 'FormCreated' && event.parentFormId) {
        const parentPcId = this.formIdIndex.get(event.parentFormId);
        if (parentPcId) {
          this.addChildForm(parentPcId, event);
          // Index the new formId AFTER creation
          this.formIdIndex.set(formId, parentPcId);
        }
        continue;
      }

      if (event.type === 'DialogOpened' && event.ownerFormId) {
        const ownerPcId = this.formIdIndex.get(event.ownerFormId);
        if (ownerPcId) {
          this.addDialog(ownerPcId, event);
          this.formIdIndex.set(formId, ownerPcId);
        }
        continue;
      }

      // Route to existing FormState
      const pcId = this.formIdIndex.get(formId);
      if (!pcId) continue;

      const page = this.pages.get(pcId);
      if (!page) continue;

      const form = page.forms.get(formId);
      if (form) {
        const updated = this.formProjection.apply(form, event);
        this.updateForm(pcId, formId, updated);
      }
    }
  }
}
```

### FormProjection (new -- handles one form's events)

```typescript
class FormProjection {
  apply(form: FormState, event: BCEvent): FormState {
    switch (event.type) {
      case 'FormCreated':
        return this.applyFormCreated(form, event);
      case 'DataLoaded':
        return this.applyDataLoaded(form, event);
      case 'PropertyChanged':
        return this.applyPropertyChanged(form, event);
      case 'BookmarkChanged':
        return this.applyBookmarkChanged(form, event);
      default:
        return form;
    }
  }

  private applyDataLoaded(form: FormState, event: DataLoadedEvent): FormState {
    // Route by controlPath to the correct repeater
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;  // unknown repeater -- ignore

    const rows = this.extractRows(event.rows);
    let updated: RepeaterState;
    if (event.currentRowOnly && repeater.rows.length > 0) {
      // Merge into existing rows by bookmark
      const merged = [...repeater.rows];
      for (const row of rows) {
        const idx = merged.findIndex(r => r.bookmark === row.bookmark);
        if (idx >= 0) merged[idx] = row;
        else merged.push(row);
      }
      updated = { ...repeater, rows: merged };
    } else {
      // Full refresh -- do NOT infer totalRowCount from rows.length.
      // totalRowCount arrives separately via PropertyChanged.
      updated = { ...repeater, rows };
    }

    const repeaters = new Map(form.repeaters);
    repeaters.set(event.controlPath, updated);
    return { ...form, repeaters };
  }

  private applyPropertyChanged(form: FormState, event: PropertyChangedEvent): FormState {
    // Check for TotalRowCount on a repeater
    const repeater = form.repeaters.get(event.controlPath);
    if (repeater) {
      const total = event.changes.TotalRowCount;
      if (typeof total === 'number') {
        const repeaters = new Map(form.repeaters);
        repeaters.set(event.controlPath, { ...repeater, totalRowCount: total });
        return { ...form, repeaters };
      }
    }
    // Otherwise update controlTree field
    // ...
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    // BookmarkChanged carries controlPath -- update the correct repeater
    const repeater = form.repeaters.get(event.controlPath);
    if (repeater) {
      const repeaters = new Map(form.repeaters);
      repeaters.set(event.controlPath, { ...repeater, currentBookmark: event.bookmark });
      return { ...form, repeaters };
    }
    return form;
  }
}
```

## Section Discovery

When a child `FormCreated` event arrives with `parentFormId` matching the root form, we need to determine what section it represents.

### Strategy (from decompiled ControlContainerType)

BC control trees contain container nodes with a `ContainerType` property:
- `ContentArea (0)` or `DetailsArea (4)` -- lines subpage
- `FactBoxArea (1)` -- factbox

### Heuristic (fallback when metadata is absent)

1. Parse the child form's control tree
2. If it has a repeater with data columns --> `lines` section
3. If the parent control tree position is in a factbox area --> `factbox:{caption}`
4. Otherwise --> `subpage:{caption}`

### SectionResolver

```typescript
class SectionResolver {
  deriveSection(
    parentPageContext: PageContext,
    childFormId: string,
    childControlTree: unknown,
  ): SectionDescriptor {
    const parsed = parseControlTree(childControlTree);
    const containerType = this.detectContainerType(parentPageContext, childFormId);

    if (containerType === ControlContainerType.FactBoxArea) {
      const id = this.uniqueSectionId(parentPageContext, 'factbox', parsed.caption);
      return { sectionId: id, kind: 'factbox', caption: parsed.caption, formId: childFormId };
    }

    if (parsed.repeaters.size > 0) {
      // Child form with repeater = lines subpage
      const id = this.uniqueSectionId(parentPageContext, 'lines', parsed.caption);
      const [repeaterPath] = parsed.repeaters.keys();
      return { sectionId: id, kind: 'lines', caption: parsed.caption, formId: childFormId, repeaterControlPath: repeaterPath };
    }

    // Unknown child form -- treat as read-only subpage, block writes/nav until classified
    const id = this.uniqueSectionId(parentPageContext, 'subpage', parsed.caption);
    return { sectionId: id, kind: 'subpage', caption: parsed.caption, formId: childFormId };
  }

  /** Generate unique section ID, appending ordinal if collision */
  private uniqueSectionId(ctx: PageContext, prefix: string, caption: string): string {
    const base = caption ? `${prefix}:${sanitize(caption)}` : prefix;
    if (!ctx.sections.has(base)) return base;
    // Collision -- append ordinal
    for (let i = 2; ; i++) {
      const candidate = `${base}#${i}`;
      if (!ctx.sections.has(candidate)) return candidate;
    }
  }
}
```

## Tool Interface Changes

### bc_open_page (extended output)

```typescript
// Input: unchanged
{ pageId: number; bookmark?: string }

// Output: add sections
{
  pageContextId: string;
  pageType: string;
  caption: string;
  sections: Array<{
    sectionId: string;
    kind: string;           // "header", "lines", "factbox"
    caption: string;
    hasRepeater: boolean;
    fieldCount: number;
    actionCount: number;
  }>;
  fields: [...];            // header fields (convenience -- same as reading header section)
  actions: [...];           // header actions (convenience)
  rows?: [...];             // primary repeater rows (convenience)
}
```

### bc_read_data (section-aware)

```typescript
// Input: add optional section + range
{
  pageContextId: string;
  section?: string;           // default: inferred (see Section Defaults below)
  range?: { offset: number; limit: number };
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
}

// Output: section-aware
{
  sectionId: string;
  kind: string;
  fields?: Array<{ name: string; value?: string; editable: boolean; type: string }>;
  rows?: Array<{
    index: number;
    bookmark: string;
    cells: Record<string, unknown>;   // keyed by column caption (LLM-friendly)
  }>;
  totalRowCount?: number;             // null if unknown (BC hasn't sent PropertyChanged yet)
  columns?: Array<{
    name: string;                     // caption (display name)
    id: string;                       // columnBinderName (stable key, matches raw cells)
    type: string;
    editable: boolean;
    isLookup: boolean;
  }>;
  actions?: Array<{ name: string; systemAction: number; enabled: boolean }>;
}
// Note: cells are keyed by caption for LLM readability. The columns[] array
// provides the id<->name mapping if the LLM needs stable identifiers.
// Duplicate captions are disambiguated with ordinal suffix: "Description", "Description#2".
```

### bc_write_data (section + row targeting)

```typescript
// Input: add section + row targeting
{
  pageContextId: string;
  section?: string;           // default: "header"
  fields: Record<string, string>;
  rowIndex?: number;          // target a specific row (convenience)
  bookmark?: string;          // target a specific row (stable, preferred)
}

// Output: InvokeResultEnvelope<FieldWriteResult[]>
{
  success: boolean;
  value: Array<{
    fieldName: string;
    success: boolean;
    newValue?: string;
    error?: string;
  }>;
  changedSections: string[];
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
}
```

### bc_execute_action (section-scoped)

```typescript
// Input: add section + row targeting
{
  pageContextId: string;
  action: string;
  section?: string;           // disambiguates header vs lines actions
  rowIndex?: number;
  bookmark?: string;
}

// Output: InvokeResultEnvelope<ActionResult>
{
  success: boolean;
  value: {
    events: BCEvent[];        // internal, may omit from MCP output
    dialog?: { formId: string };
  };
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
}
```

### bc_navigate (section-aware)

```typescript
// Input: add section + cell targeting
{
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select' | 'lookup';
  section?: string;           // which section's repeater
  field?: string;             // which cell to drill-down/lookup from
}
```

## Section Defaults

When `section` is omitted from a tool call, the default depends on the tool and page type:

| Tool | Card page | List page | Document page |
|---|---|---|---|
| bc_read_data | `header` | `header` (the list repeater IS the header) | `header` |
| bc_write_data | `header` | `header` | `header` |
| bc_execute_action | `header` | `header` | `header` |
| bc_navigate | `header` | `header` | `lines` (drill-down typically targets line items) |

For List pages, the "header" section contains both card fields and the repeater. There is no separate "lines" section on a List page.

For Document pages, `bc_read_data` with no section returns header fields. To read line items, use `section: "lines"`.

## Line Cell Write Protocol

Verified from decompiled `RepeaterControl.ResolvePathName` (RepeaterControl.cs lines 809-819).

### Wire format

To write to a cell in the current row of a repeater:

1. **Select the row** (if not already selected):
   ```typescript
   { type: 'SetCurrentRow', formId: linesFormId, controlPath: repeaterPath, key: bookmark }
   ```

2. **SaveValue to the cell**:
   ```typescript
   { type: 'SaveValue', formId: linesFormId, controlPath: `${repeaterPath}/cr/co[${colIndex}]`, newValue: value }
   ```

Path segments:
- `cr` -- resolves to `CurrentRowViewport.Children[0]` (the current row template)
- `co[N]` -- resolves to `DefaultRowTemplate.Children[N]` (the Nth column control)

### Column index resolution

The `colIndex` is the position of the column in the repeater's `Columns` array (from the control tree). The `RepeaterColumn.controlPath` already stores this as `{repeater}/co[N]`. For SaveValue on the current row, replace `co` with `cr/co`:

```typescript
function cellControlPath(repeaterPath: string, colIndex: number): string {
  return `${repeaterPath}/cr/co[${colIndex}]`;
}
```

### Column caption to index mapping

To write by column name (e.g., "Line Discount %"):
1. Find the column in `repeater.columns` by caption match
2. Extract the index from its controlPath (`/co[N]`)
3. Build the SaveValue controlPath as `{repeater}/cr/co[N]`

## Section Discovery from Control Tree

### ControlContainerType (from decompiled ControlContainerDefinition.cs)

The control tree's container nodes carry a `ContainerType` property:

```
ContentArea = 0      // Main content (header fields, embedded repeaters)
FactBoxArea = 1      // Right sidebar factboxes
RoleCenterArea = 2   // Role center (irrelevant)
RequestPageFilters = 3
DetailsArea = 4      // Detail area (lines subpage area)
```

### Parsing strategy

When `parseControlTree` encounters a container node:
1. Check `ContainerType` property on the node
2. If `FactBoxArea` -- mark children as factbox sections
3. If `ContentArea` or `DetailsArea` with a `FormHostControl` child (`fhc` type?) -- expect child form creation event
4. The actual child form's control tree arrives in a separate `FormCreated` event

### FormHostControl in the control tree

FormHostControl nodes appear in the parent form's control tree as placeholder children. When the child form loads, BC sends a `FormCreated` event with `parentFormId`. We match this to discover which placeholder it fills.

## TotalRowCount

Verified from decompiled `RepeaterControl.cs` and `ClientRepeaterControl.cs`.

TotalRowCount is NOT in `DataRefreshChange`. It arrives as a separate `PropertyChanged` event:
- `controlPath` = repeater's controlPath
- `changes.TotalRowCount` = the actual count

`FormProjection.applyPropertyChanged` must check for this and update `RepeaterState.totalRowCount`. `RepeaterState.totalRowCount` starts as `null` (unknown) and is ONLY set from PropertyChanged events. The `applyDataLoaded` method does NOT infer total from `rows.length` -- that was the old broken behavior.

## Instructional Error Messages

When a tool call targets the wrong section or a missing field:

```typescript
// Field exists in another section
{
  success: false,
  error: {
    message: "Field 'Line Discount %' not found in section 'header'.",
    suggestion: "This field exists in section 'lines'. Use section: 'lines' with a rowIndex or bookmark.",
    availableSections: ["header", "lines"]
  }
}

// Action ambiguous across sections
{
  success: false,
  error: {
    message: "Action 'Delete' exists in multiple sections: 'header', 'lines'.",
    suggestion: "Specify section: 'header' or section: 'lines' to disambiguate."
  }
}

// Section not found
{
  success: false,
  error: {
    message: "Section 'shipping' not found.",
    availableSections: ["header", "lines", "factbox:customerStats"]
  }
}
```

## Cascading Refresh Semantics

**Pattern A**: After a mutating operation, the tool returns `changedSections[]` indicating which sections may have stale data. The LLM decides whether to re-read.

Detection: after applying events from a write/action, check which FormStates received `DataLoaded` or `PropertyChanged` events. Map those formIds back to sectionIds.

```typescript
// After bc_write_data on header "Sell-to Customer No."
{
  success: true,
  value: [{ fieldName: "Sell-to Customer No.", success: true, newValue: "40000" }],
  changedSections: ["header", "lines", "factbox:customerStats"],  // BC recalculated
}
```

## Action Ownership vs Section Context

Many "line actions" (Dimensions, Item Tracking, Reserve) may appear in the **root form's** action bar, not the child form's. They operate on the selected line but are defined on the parent page.

### Resolution strategy

When `bc_execute_action(section: "lines", action: "Dimensions")` is called:

1. First look for the action in the lines section's form (`linesFormState.actions`)
2. If not found, look in the root form's actions (`rootFormState.actions`)
3. If found in root form, still select the row in the lines repeater FIRST, then invoke the action on the root form with the row context set

This means action execution is a two-step process:
- **Row context**: determined by `section` + `bookmark`/`rowIndex` -- selects the row in the correct form's repeater
- **Action invocation**: may target a different form than the row context

The tool response should indicate which form the action was actually invoked on, for debugging.

### Action listing per section

`bc_read_data(section: "lines").actions` should include:
- Actions defined on the lines child form
- Actions from the root form that are structurally inside a repeater node (see below)
- System actions in ROW_TARGETING_ACTIONS set (Delete=20, Edit=40, DrillDown=120)

### Structural signal: action parentage in control tree

In BC's AL language, actions defined inside a `repeater` control are line-scoped. The serialized control tree preserves this: `ac` nodes inside `rc` nodes are line actions. The control tree parser must track this:

```typescript
// In walkChildren, when inside a repeater subtree, tag actions
function walkChildren(children, parentPath, result, insideRepeater = false): void {
  for (const child of children) {
    if (t === 'rc') {
      extractRepeater(node, controlPath, result);
      // Recurse into repeater children with insideRepeater=true
      walkChildren(subChildren, controlPath, result, true);
    } else if (t === 'ac') {
      extractAction(node, controlPath, result, insideRepeater);
      // ActionInfo gains: readonly isLineScoped: boolean;
    }
  }
}
```

This eliminates the need for heuristics on named actions. "Dimensions", "Reserve", "Item Tracking Lines" will be correctly classified as line-scoped if they're defined inside the repeater in AL code.

**Verification needed**: Capture wire traffic for Sales Order page 42 to confirm that line actions appear as `ac` nodes inside the `rc` subtree in the serialized control tree. If BC flattens actions to the top level during serialization, this approach fails and we fall back to the heuristic.

## Form Reload Semantics

`FormCreatedEvent` includes `isReload?: boolean`. On reload:
1. Remove old formId from `forms` map and `formIdIndex`
2. Create fresh FormState with the new control tree
3. Regenerate section descriptors
4. Existing sectionIds should remain stable if the same child forms reappear
5. Return `changedSections: [...]` to notify the LLM

## rowIndex Semantics

`rowIndex` is the index within **currently loaded rows**, not an absolute position. If rows 0-19 are loaded and the LLM requests `rowIndex: 25`, return an error:

```typescript
{
  success: false,
  error: {
    message: "Row index 25 is out of range. Currently loaded rows: 0-19 of 47 total.",
    suggestion: "Use bc_read_data with range: {offset: 20, limit: 20} to load more rows, or use bookmark for stable targeting."
  }
}
```

## openFormIds Tracking

BC requires correct `openFormIds` in each invoke call. This must be tracked at the **session level** (union of all forms across all page contexts), not per PageContext.

`PageContext.openFormIds` is replaced by `PageContext.ownedFormIds` -- the set of formIds that belong to this context (for cleanup on close). The invoke layer reads the session-global set.

## Migration Strategy

### Files to create
- `src/protocol/form-state.ts` -- FormState type + FormProjection class
- `src/protocol/section-resolver.ts` -- Section discovery + SectionDescriptor type
- `src/protocol/types/page-context.ts` -- PageContext type (replaces PageState)

### Files to refactor
- `src/protocol/page-context-repo.ts` -- Track Map<formId, FormState>, derive sections
- `src/protocol/control-tree-parser.ts` -- Parse ALL repeaters, extract columnBinderName on repeater columns, detect ControlContainerType
- `src/protocol/state-projection.ts` -- Replaced by FormProjection (delete or gut)
- `src/services/navigation-service.ts` -- Use SectionResolver for all repeater access
- `src/services/data-service.ts` -- Add section routing, line cell writes
- `src/services/action-service.ts` -- Add section scoping
- `src/mcp/schemas.ts` -- Add section, rowIndex, bookmark params
- `src/mcp/tool-registry.ts` -- Update tool descriptions
- `src/operations/*.ts` -- Wire section params through to services
- `src/api/routes.ts` -- Pass through new params

### Files unchanged
- `src/session/bc-session.ts` -- Invoke layer is form-agnostic
- `src/protocol/event-decoder.ts` -- Already extracts formId + controlPath per event
- `src/core/*` -- No changes needed

### Test strategy
1. Record actual BC27/BC28 wire traffic for Sales Order page 42/43
2. Unit test FormProjection with recorded events
3. Unit test SectionResolver with recorded control trees
4. Integration test: open page 42, verify header + lines sections
5. Integration test: write to line cell, verify round-trip
6. Integration test: drill-down from line item
7. Regression: all existing 110 tests must pass

## Open Questions

1. **FormHostControl type alias**: What is the `t` value for FormHostControl nodes in the serialized control tree? Need to check `FormHostControlSerializer.cs` or capture actual wire traffic. This determines how we find subpage placeholders in the parent tree.

2. **FactBox child form timing**: Do FactBox child forms arrive as `FormCreated` events during initial page load, or only when the FactBox is visible/expanded? If lazy, we may not have their data until the user requests it.

3. **Multiple lines subpages**: Can a document page have more than one lines-style subpage (e.g., header lines + prepayment lines)? If so, section IDs need disambiguation beyond just "lines". (Mitigation: `uniqueSectionId` appends ordinals on collision.)

4. **Child form to placeholder correlation**: When `FormCreated(parentFormId=X)` arrives, is there any property linking it to a specific `FormHostControl` placeholder in the parent tree (controlPath, index)? Or do we only have `parentFormId` + child control tree? This affects ControlContainerType detection.

5. **Line action location**: Do "line actions" (Dimensions, Item Tracking) appear in the root form's action tree, the child form's action tree, or both? Need wire traffic capture to confirm the action ownership strategy.

6. **Dialog closure events**: Current event types include `DialogOpenedEvent` but no "DialogClosed". How do we detect dialog closure for cleanup? Is it inferred from `InvokeCompleted` after Ok/Cancel? Needed for stale section recovery.
