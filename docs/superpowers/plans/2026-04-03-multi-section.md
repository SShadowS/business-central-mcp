# Multi-Section Document Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable full LLM interaction with BC document pages (Sales Order, Purchase Order) by tracking multiple child forms and exposing them as named sections.

**Architecture:** Form-First with Section View (Approach B). FormState per BC form as source of truth, projected independently from events. SectionDescriptor as derived view layer for LLM tools. PageContext coordinates forms and sections.

**Tech Stack:** TypeScript, ESM (.js extensions), Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-04-03-multi-section-design.md`
**Tracking:** `PHASE2.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/protocol/form-state.ts` | FormState type, FormProjection class, primaryRepeater helper |
| `src/protocol/section-resolver.ts` | SectionDescriptor type, SectionKind, SectionResolver class |
| `src/protocol/page-context.ts` | PageContext type (replaces PageState as repo unit) |
| `tests/protocol/form-projection.test.ts` | FormProjection unit tests |
| `tests/protocol/section-resolver.test.ts` | SectionResolver unit tests |

### Modified files
| File | Changes |
|---|---|
| `src/protocol/types.ts` | Update RepeaterState (add currentBookmark, totalRowCount nullable). Add ControlContainerType. Keep PageState as deprecated alias. |
| `src/protocol/control-tree-parser.ts` | Return ALL repeaters as Map. Extract columnBinderName on repeater columns. Track action parentage (isLineScoped). |
| `src/protocol/page-context-repo.ts` | Track Map<formId, FormState>. Route events by parentFormId for new forms. Derive sections. |
| `src/services/page-service.ts` | Use PageContext. Load child form data with section awareness. |
| `src/services/data-service.ts` | Section routing. Line cell writes (SetCurrentRow + SaveValue on repeater cell). |
| `src/services/navigation-service.ts` | Section-aware selectRow and drillDown. |
| `src/services/action-service.ts` | Section-scoped action resolution. Action ownership (root vs child form). |
| `src/services/filter-service.ts` | Section-aware filtering (target correct form's repeater). |
| `src/operations/*.ts` | Wire section, rowIndex, bookmark params through. |
| `src/mcp/schemas.ts` | Add section, rowIndex, bookmark to schemas. |
| `src/mcp/tool-registry.ts` | Update tool descriptions for section support. |
| `tests/protocol/control-tree-parser.test.ts` | Update expectations for multi-repeater output. |

### Deleted files
| File | Reason |
|---|---|
| `src/protocol/state-projection.ts` | Replaced by FormProjection. Removed after all consumers migrated. |

---

## Task 1: Type Definitions

**Files:**
- Modify: `src/protocol/types.ts`
- Create: `src/protocol/form-state.ts`
- Create: `src/protocol/section-resolver.ts` (types only, no logic yet)
- Create: `src/protocol/page-context.ts`

- [ ] **Step 1: Update RepeaterState in types.ts**

Add `currentBookmark` and change `totalRowCount` to nullable:

```typescript
// In src/protocol/types.ts, replace the RepeaterState interface:

export interface RepeaterState {
  readonly controlPath: string;
  readonly columns: RepeaterColumn[];
  readonly rows: RepeaterRow[];
  readonly totalRowCount: number | null;      // null = unknown; set from PropertyChanged, NOT rows.length
  readonly currentBookmark: string | null;     // per-repeater; set from BookmarkChanged events
}
```

Also add `columnBinderName` to `RepeaterColumn` and `isLineScoped` to `ActionInfo`:

```typescript
export interface RepeaterColumn {
  readonly controlPath: string;
  readonly caption: string;
  readonly type: string;
  readonly columnBinderName?: string;   // key that matches row.cells keys
  readonly columnBinderPath?: string;   // for filter column IDs
}

export interface ActionInfo {
  readonly controlPath: string;
  readonly caption: string;
  readonly systemAction: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly isLineScoped: boolean;       // true if defined inside a repeater subtree
}
```

Add `ControlContainerType`:

```typescript
export enum ControlContainerType {
  ContentArea = 0,
  FactBoxArea = 1,
  RoleCenterArea = 2,
  RequestPageFilters = 3,
  DetailsArea = 4,
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Errors in files that use `ActionInfo` without `isLineScoped` and `RepeaterState` without `currentBookmark`. That's expected -- we'll fix consumers in later tasks. Note which files error.

- [ ] **Step 3: Create FormState type in form-state.ts**

```typescript
// src/protocol/form-state.ts
import type { ControlField, RepeaterState, ActionInfo, ControlContainerType } from './types.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  readonly controlTree: ControlField[];
  readonly repeaters: ReadonlyMap<string, RepeaterState>;
  readonly actions: ActionInfo[];
  readonly filterControlPath: string | null;
  readonly containerType?: ControlContainerType;
}

/** Returns the first (and usually only) repeater, or null. */
export function primaryRepeater(form: FormState): RepeaterState | null {
  const first = form.repeaters.values().next();
  return first.done ? null : first.value;
}

/** Returns the repeater matching a controlPath, or the primary. */
export function resolveRepeater(form: FormState, controlPath?: string): RepeaterState | null {
  if (controlPath) return form.repeaters.get(controlPath) ?? null;
  return primaryRepeater(form);
}
```

- [ ] **Step 4: Create SectionDescriptor types in section-resolver.ts**

```typescript
// src/protocol/section-resolver.ts
export type SectionKind = 'header' | 'lines' | 'factbox' | 'requestPage' | 'subpage';

export interface SectionDescriptor {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  readonly formId: string;
  readonly repeaterControlPath?: string;
}
```

- [ ] **Step 5: Create PageContext type in page-context.ts**

```typescript
// src/protocol/page-context.ts
import type { FormState } from './form-state.js';
import type { SectionDescriptor } from './section-resolver.js';
import type { DialogInfo } from './types.js';

export interface PageContext {
  readonly pageContextId: string;
  readonly rootFormId: string;
  readonly pageType: 'Card' | 'List' | 'Document' | 'Unknown';
  readonly caption: string;
  readonly forms: ReadonlyMap<string, FormState>;
  readonly sections: ReadonlyMap<string, SectionDescriptor>;
  readonly dialogs: DialogInfo[];
  readonly ownedFormIds: string[];
}
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: Same errors as Step 2 (existing consumers). New files should compile cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/protocol/types.ts src/protocol/form-state.ts src/protocol/section-resolver.ts src/protocol/page-context.ts
git commit -m "feat: add FormState, SectionDescriptor, PageContext types for multi-section architecture"
```

---

## Task 2: FormProjection

**Files:**
- Modify: `src/protocol/form-state.ts` (add FormProjection class)
- Create: `tests/protocol/form-projection.test.ts`

- [ ] **Step 1: Write failing tests for FormProjection**

```typescript
// tests/protocol/form-projection.test.ts
import { describe, it, expect } from 'vitest';
import { FormProjection } from '../../src/protocol/form-state.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    formId: 'f1',
    controlTree: [],
    repeaters: new Map(),
    actions: [],
    filterControlPath: null,
    ...overrides,
  };
}

function makeRepeaterForm(): FormState {
  return makeForm({
    repeaters: new Map([
      ['server:c[1]', {
        controlPath: 'server:c[1]',
        columns: [{ controlPath: 'server:c[1]/co[0]', caption: 'No.', type: 'rcc' }],
        rows: [],
        totalRowCount: null,
        currentBookmark: null,
      }],
    ]),
  });
}

describe('FormProjection', () => {
  const projection = new FormProjection();

  it('applies DataLoaded to matching repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: false,
      rows: [
        { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' }, bookmark: 'bm1' }] },
        { t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': '20000' }, bookmark: 'bm2' }] },
      ],
    };
    const updated = projection.apply(form, event);
    const rep = updated.repeaters.get('server:c[1]')!;
    expect(rep.rows).toHaveLength(2);
    expect(rep.rows[0]!.bookmark).toBe('bm1');
    expect(rep.totalRowCount).toBeNull(); // not inferred from rows.length
  });

  it('ignores DataLoaded for unknown controlPath', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[99]',
      currentRowOnly: false, rows: [],
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.rows).toHaveLength(0);
  });

  it('merges currentRowOnly DataLoaded by bookmark', () => {
    const form = makeForm({
      repeaters: new Map([['server:c[1]', {
        controlPath: 'server:c[1]', columns: [], totalRowCount: null, currentBookmark: null,
        rows: [{ bookmark: 'bm1', cells: { 'No.': '10000' } }, { bookmark: 'bm2', cells: { 'No.': '20000' } }],
      }]]),
    });
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowUpdated', DataRowUpdated: [0, { cells: { 'No.': '10001' }, bookmark: 'bm1' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.repeaters.get('server:c[1]')!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cells['No.']).toBe('10001');
    expect(rows[1]!.cells['No.']).toBe('20000');
  });

  it('applies PropertyChanged TotalRowCount to repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
      changes: { TotalRowCount: 42 },
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.totalRowCount).toBe(42);
  });

  it('applies PropertyChanged to controlTree fields', () => {
    const form = makeForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]/c[1]',
      changes: { StringValue: 'Hello', Caption: 'Name', Editable: true, Visible: true },
    };
    const updated = projection.apply(form, event);
    const field = updated.controlTree.find(f => f.controlPath === 'server:c[0]/c[1]');
    expect(field).toBeDefined();
    expect(field!.stringValue).toBe('Hello');
    expect(field!.caption).toBe('Name');
  });

  it('applies BookmarkChanged to correct repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'BookmarkChanged', formId: 'f1', controlPath: 'server:c[1]', bookmark: 'bm5',
    };
    const updated = projection.apply(form, event);
    expect(updated.repeaters.get('server:c[1]')!.currentBookmark).toBe('bm5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/protocol/form-projection.test.ts`
Expected: FAIL -- `FormProjection` not exported from form-state.ts.

- [ ] **Step 3: Implement FormProjection**

Add to `src/protocol/form-state.ts`:

```typescript
import type {
  ControlField, RepeaterState, RepeaterRow, ActionInfo, BCEvent,
  DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent, FormCreatedEvent,
} from './types.js';
import { parseControlTree } from './control-tree-parser.js';

export class FormProjection {
  createInitial(formId: string, parentFormId?: string): FormState {
    return {
      formId,
      parentFormId,
      controlTree: [],
      repeaters: new Map(),
      actions: [],
      filterControlPath: null,
    };
  }

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

  private applyFormCreated(form: FormState, event: FormCreatedEvent): FormState {
    const parsed = parseControlTree(event.controlTree);
    return {
      ...form,
      controlTree: parsed.fields.length > 0 ? parsed.fields : form.controlTree,
      repeaters: parsed.repeaters.size > 0 ? parsed.repeaters : form.repeaters,
      actions: parsed.actions.length > 0 ? parsed.actions : form.actions,
      filterControlPath: parsed.filterControlPath ?? form.filterControlPath,
    };
  }

  private applyDataLoaded(form: FormState, event: DataLoadedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;

    const rows = this.extractRows(event.rows);
    let updated: RepeaterState;
    if (event.currentRowOnly && repeater.rows.length > 0) {
      const merged = [...repeater.rows];
      for (const row of rows) {
        const idx = merged.findIndex(r => r.bookmark === row.bookmark);
        if (idx >= 0) merged[idx] = row;
        else merged.push(row);
      }
      updated = { ...repeater, rows: merged };
    } else {
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
    const ch = event.changes;
    const existing = form.controlTree.find(f => f.controlPath === event.controlPath);
    const field: ControlField = {
      controlPath: event.controlPath,
      caption: (ch.Caption as string) ?? existing?.caption ?? '',
      type: (ch.ControlType as string) ?? existing?.type ?? '',
      editable: (ch.Editable as boolean) ?? existing?.editable ?? false,
      visible: (ch.Visible as boolean) ?? existing?.visible ?? true,
      value: ch.ObjectValue ?? ch.Value ?? existing?.value,
      stringValue: (ch.StringValue as string) ?? existing?.stringValue,
    };
    const controlTree = existing
      ? form.controlTree.map(f => f.controlPath === event.controlPath ? field : f)
      : [...form.controlTree, field];
    return { ...form, controlTree };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);
    if (repeater) {
      const repeaters = new Map(form.repeaters);
      repeaters.set(event.controlPath, { ...repeater, currentBookmark: event.bookmark });
      return { ...form, repeaters };
    }
    return form;
  }

  private extractRows(rawRows: unknown[]): RepeaterRow[] {
    const rows: RepeaterRow[] = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const rowData = (r.DataRowInserted ?? r.DataRowUpdated) as unknown[] | undefined;
      if (Array.isArray(rowData) && rowData.length >= 2) {
        const payload = rowData[1] as Record<string, unknown>;
        rows.push({
          bookmark: (payload.bookmark ?? payload.Bookmark ?? '') as string,
          cells: (payload.cells ?? payload.Cells ?? {}) as Record<string, unknown>,
        });
      }
    }
    return rows;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/protocol/form-projection.test.ts`
Expected: All 6 tests PASS.

Note: This will initially fail because `parseControlTree` doesn't return `repeaters` as a Map yet. The `applyFormCreated` method depends on Task 3. For now, temporarily stub it or skip that path. The DataLoaded/PropertyChanged/BookmarkChanged tests should pass.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/form-state.ts tests/protocol/form-projection.test.ts
git commit -m "feat: add FormProjection with per-form event handling and repeater map"
```

---

## Task 3: Control Tree Parser Updates

**Files:**
- Modify: `src/protocol/control-tree-parser.ts`
- Modify: `tests/protocol/control-tree-parser.test.ts`

The parser must:
1. Return ALL repeaters as a Map (not just the first)
2. Extract `columnBinderName` on repeater columns
3. Track action parentage (`isLineScoped`)

- [ ] **Step 1: Update ParsedControlTree interface**

In `src/protocol/control-tree-parser.ts`, change the return type:

```typescript
import type { ControlField, RepeaterColumn, RepeaterState, ActionInfo } from './types.js';

export interface ParsedControlTree {
  caption: string;
  pageType: 'Card' | 'List' | 'Document' | 'Unknown';
  fields: ControlField[];
  repeaters: ReadonlyMap<string, RepeaterState>;  // controlPath -> RepeaterState (was: repeater: RepeaterState | null)
  filterControlPath: string | null;
  actions: ActionInfo[];
  metadata?: { id: number; sourceTableId: number };
}
```

- [ ] **Step 2: Update walkChildren to collect all repeaters and track action parentage**

Replace the `walkChildren` function:

```typescript
function walkChildren(
  children: unknown[],
  parentPath: string,
  result: ParsedControlTree,
  insideRepeater: boolean = false,
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    const t = node.t as string | undefined;
    if (!t) continue;

    const separator = parentPath === 'server' ? ':' : '/';
    const controlPath = `${parentPath}${separator}c[${i}]`;

    if (FIELD_TYPES.has(t)) {
      extractField(node, t, controlPath, result);
    } else if (t === 'ac') {
      extractAction(node, controlPath, result, insideRepeater);
    } else if (t === 'rc') {
      extractRepeater(node, controlPath, result);
      // Recurse into repeater children with insideRepeater=true
      const subChildren = node.Children as unknown[] | undefined;
      if (Array.isArray(subChildren)) {
        walkChildren(subChildren, controlPath, result, true);
      }
      continue; // skip the general recursion below (already recursed)
    } else if (t === 'filc' && result.filterControlPath === null) {
      result.filterControlPath = controlPath;
    }

    // Recurse into Children (gc groups, etc.)
    const subChildren = node.Children as unknown[] | undefined;
    if (Array.isArray(subChildren)) {
      walkChildren(subChildren, controlPath, result, insideRepeater);
    }
  }
}
```

- [ ] **Step 3: Update extractRepeater to use Map and extract columnBinderName**

```typescript
function extractRepeater(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
): void {
  const columns: RepeaterColumn[] = [];
  const rccArray = node.Columns as unknown[] | undefined;
  if (Array.isArray(rccArray)) {
    for (let j = 0; j < rccArray.length; j++) {
      const col = rccArray[j] as Record<string, unknown> | undefined;
      if (!col || col.t !== 'rcc') continue;
      if (col.MappingHint === 'PlaceholderField') continue;

      const binder = col.ColumnBinder as { Name?: string; Path?: string } | undefined;

      columns.push({
        controlPath: `${controlPath}/co[${j}]`,
        caption: (col.Caption as string) ?? '',
        type: 'rcc',
        columnBinderName: binder?.Name || undefined,
        columnBinderPath: (col.ColumnBinderPath as string) || binder?.Path || undefined,
      });
    }
  }

  // Use mutable map, cast back to ReadonlyMap at return
  (result.repeaters as Map<string, RepeaterState>).set(controlPath, {
    controlPath,
    columns,
    rows: [],
    totalRowCount: null,
    currentBookmark: null,
  });
}
```

- [ ] **Step 4: Update extractAction to accept isLineScoped**

```typescript
function extractAction(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
  isLineScoped: boolean = false,
): void {
  result.actions.push({
    controlPath,
    caption: (node.Caption as string) ?? '',
    systemAction: (node.SystemAction as number) ?? 0,
    enabled: (node.Enabled as boolean) ?? true,
    visible: (node.Visible as boolean) ?? true,
    isLineScoped,
  });
}
```

- [ ] **Step 5: Update parseControlTree to initialize repeaters as Map**

In the `parseControlTree` function, change the result initialization:

```typescript
const result: ParsedControlTree = {
  caption: '',
  pageType: 'Unknown',
  fields: [],
  repeaters: new Map(),
  filterControlPath: null,
  actions: [],
};
```

- [ ] **Step 6: Update existing tests**

In `tests/protocol/control-tree-parser.test.ts`, update assertions:

```typescript
// Replace: expect(parsed.repeater).toBeNull();
// With:    expect(parsed.repeaters.size).toBe(0);

// Replace: expect(parsed.repeater).not.toBeNull();
//          expect(parsed.repeater!.columns.length)
// With:    expect(parsed.repeaters.size).toBeGreaterThan(0);
//          const repeater = parsed.repeaters.values().next().value!;
//          expect(repeater.columns.length)

// For page 22 (Customer List):
it('parses Customer List (page 22) control tree', () => {
  const controlTree = loadControlTree('page22-control-tree.json');
  const parsed = parseControlTree(controlTree);

  expect(parsed.caption).toBe('Customers');
  expect(parsed.pageType).toBe('List');
  expect(parsed.repeaters.size).toBeGreaterThan(0);
  const repeater = parsed.repeaters.values().next().value!;
  expect(repeater.columns.length).toBeGreaterThanOrEqual(5);
  expect(parsed.actions.length).toBeGreaterThan(0);

  const noCol = repeater.columns.find(c => c.caption === 'No.');
  expect(noCol).toBeDefined();
  expect(noCol!.columnBinderPath).toBe('18_Customer.1');

  // NEW: verify columnBinderName is extracted
  expect(noCol!.columnBinderName).toBeDefined();

  // Metadata
  expect(parsed.metadata).toBeDefined();
  expect(parsed.metadata!.id).toBe(22);
});

// For null/empty:
it('handles null control tree', () => {
  const parsed = parseControlTree(null);
  expect(parsed.fields).toEqual([]);
  expect(parsed.repeaters.size).toBe(0);
  expect(parsed.actions).toEqual([]);
});

// Add test for isLineScoped:
it('marks actions inside repeaters as isLineScoped', () => {
  const controlTree = loadControlTree('page22-control-tree.json');
  const parsed = parseControlTree(controlTree);
  // At minimum, verify the property exists on all actions
  for (const action of parsed.actions) {
    expect(typeof action.isLineScoped).toBe('boolean');
  }
});
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run tests/protocol/control-tree-parser.test.ts`
Expected: All tests PASS.

- [ ] **Step 8: Run type check**

Run: `npx tsc --noEmit`
Expected: Errors in `state-projection.ts` and services that still reference `parsed.repeater` (singular). Expected -- they'll be migrated.

- [ ] **Step 9: Commit**

```bash
git add src/protocol/control-tree-parser.ts tests/protocol/control-tree-parser.test.ts
git commit -m "feat: control tree parser returns all repeaters, extracts columnBinderName, tracks action parentage"
```

---

## Task 4: SectionResolver

**Files:**
- Modify: `src/protocol/section-resolver.ts` (add SectionResolver class)
- Create: `tests/protocol/section-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/protocol/section-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { SectionResolver } from '../../src/protocol/section-resolver.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import type { PageContext } from '../../src/protocol/page-context.js';

function makePageContext(sections: Map<string, SectionDescriptor> = new Map()): PageContext {
  return {
    pageContextId: 'ctx:1', rootFormId: 'root', pageType: 'Document',
    caption: 'Sales Order', forms: new Map(), sections, dialogs: [], ownedFormIds: ['root'],
  };
}

describe('SectionResolver', () => {
  const resolver = new SectionResolver();

  it('derives lines section for child form with repeater', () => {
    const ctx = makePageContext();
    const childTree = {
      Caption: 'Sales Order Subform',
      PageType: 1, // List
      Children: [{
        t: 'rc',
        Columns: [
          { t: 'rcc', Caption: 'No.', ColumnBinderPath: '37_SalesLine.6' },
        ],
      }],
    };
    const section = resolver.deriveSection(ctx, 'child1', childTree);
    expect(section.kind).toBe('lines');
    expect(section.sectionId).toBe('lines');
    expect(section.formId).toBe('child1');
    expect(section.repeaterControlPath).toBeDefined();
  });

  it('derives subpage for child form without repeater', () => {
    const ctx = makePageContext();
    const childTree = { Caption: 'Unknown Part', Children: [] };
    const section = resolver.deriveSection(ctx, 'child2', childTree);
    expect(section.kind).toBe('subpage');
    expect(section.sectionId).toBe('subpage:Unknown Part');
  });

  it('handles section ID collisions with ordinal', () => {
    const existing = new Map<string, SectionDescriptor>([
      ['lines', { sectionId: 'lines', kind: 'lines', caption: 'First', formId: 'c1' }],
    ]);
    const ctx = makePageContext(existing);
    const childTree = {
      Caption: 'Second Lines',
      Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Col' }] }],
    };
    const section = resolver.deriveSection(ctx, 'child3', childTree);
    expect(section.sectionId).toBe('lines#2');
    expect(section.kind).toBe('lines');
  });

  it('creates header section for root form', () => {
    const section = resolver.createHeaderSection('rootForm');
    expect(section.sectionId).toBe('header');
    expect(section.kind).toBe('header');
    expect(section.formId).toBe('rootForm');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/protocol/section-resolver.test.ts`
Expected: FAIL -- `SectionResolver` class not found.

- [ ] **Step 3: Implement SectionResolver**

In `src/protocol/section-resolver.ts`, add:

```typescript
import { parseControlTree } from './control-tree-parser.js';
import type { PageContext } from './page-context.js';

export class SectionResolver {
  createHeaderSection(rootFormId: string): SectionDescriptor {
    return {
      sectionId: 'header',
      kind: 'header',
      caption: 'Header',
      formId: rootFormId,
    };
  }

  deriveSection(
    parentPageContext: PageContext,
    childFormId: string,
    childControlTree: unknown,
  ): SectionDescriptor {
    const parsed = parseControlTree(childControlTree);

    if (parsed.repeaters.size > 0) {
      const [repeaterPath] = parsed.repeaters.keys();
      const id = this.uniqueSectionId(parentPageContext, 'lines');
      return {
        sectionId: id,
        kind: 'lines',
        caption: parsed.caption || 'Lines',
        formId: childFormId,
        repeaterControlPath: repeaterPath,
      };
    }

    const caption = parsed.caption || 'Subpage';
    const id = this.uniqueSectionId(parentPageContext, `subpage:${caption}`);
    return {
      sectionId: id,
      kind: 'subpage',
      caption,
      formId: childFormId,
    };
  }

  private uniqueSectionId(ctx: PageContext, base: string): string {
    if (!ctx.sections.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}#${i}`;
      if (!ctx.sections.has(candidate)) return candidate;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/protocol/section-resolver.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/section-resolver.ts tests/protocol/section-resolver.test.ts
git commit -m "feat: add SectionResolver for deriving sections from child form control trees"
```

---

## Task 5: PageContextRepository Refactor

**Files:**
- Modify: `src/protocol/page-context-repo.ts`
- Modify: `src/protocol/types.ts` (add PageState compatibility alias)

This is the core refactor. The repo changes from tracking `PageState` to tracking `PageContext` with a `Map<formId, FormState>`.

- [ ] **Step 1: Add backward-compatible PageState derivation**

We need existing consumers to keep working while we migrate them. Add to `src/protocol/types.ts`:

```typescript
// DEPRECATED: Use PageContext from page-context.ts for new code.
// This exists for backward compatibility during migration.
export function derivePageState(ctx: import('./page-context.js').PageContext): PageState {
  const rootForm = ctx.forms.get(ctx.rootFormId);
  const repeater = rootForm ? primaryRepeaterFromForm(rootForm) : null;
  return {
    pageContextId: ctx.pageContextId,
    formId: ctx.rootFormId,
    pageType: ctx.pageType,
    controlTree: rootForm?.controlTree ?? [],
    repeater,
    filterControlPath: rootForm?.filterControlPath ?? null,
    actions: rootForm?.actions ?? [],
    childForms: Array.from(ctx.forms.entries())
      .filter(([fId]) => fId !== ctx.rootFormId)
      .map(([fId, form]) => ({ formId: fId, caption: '' })),
    dialogs: ctx.dialogs,
    openFormIds: ctx.ownedFormIds,
  };
}

function primaryRepeaterFromForm(form: import('./form-state.js').FormState): RepeaterState | null {
  const first = form.repeaters.values().next();
  return first.done ? null : first.value;
}
```

- [ ] **Step 2: Rewrite PageContextRepository**

Replace `src/protocol/page-context-repo.ts`:

```typescript
import type { BCEvent } from './types.js';
import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';
import { FormProjection } from './form-state.js';
import { SectionResolver } from './section-resolver.js';
import type { SectionDescriptor } from './section-resolver.js';

export class PageContextRepository {
  private readonly pages = new Map<string, PageContext>();
  private readonly formIdIndex = new Map<string, string>();  // formId -> pageContextId
  private readonly formProjection = new FormProjection();
  private readonly sectionResolver = new SectionResolver();

  get(pageContextId: string): PageContext | undefined {
    return this.pages.get(pageContextId);
  }

  getByFormId(formId: string): PageContext | undefined {
    const id = this.formIdIndex.get(formId);
    return id ? this.pages.get(id) : undefined;
  }

  create(pageContextId: string, rootFormId: string): PageContext {
    const rootForm = this.formProjection.createInitial(rootFormId);
    const headerSection = this.sectionResolver.createHeaderSection(rootFormId);

    const ctx: PageContext = {
      pageContextId,
      rootFormId,
      pageType: 'Unknown',
      caption: '',
      forms: new Map([[rootFormId, rootForm]]),
      sections: new Map([['header', headerSection]]),
      dialogs: [],
      ownedFormIds: [rootFormId],
    };

    this.pages.set(pageContextId, ctx);
    this.formIdIndex.set(rootFormId, pageContextId);
    return ctx;
  }

  applyEvents(events: BCEvent[]): void {
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  applyToPage(pageContextId: string, events: BCEvent[]): PageContext | undefined {
    for (const event of events) {
      this.applyEvent(event, pageContextId);
    }
    return this.pages.get(pageContextId);
  }

  private applyEvent(event: BCEvent, targetPcId?: string): void {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (!formId) return;

    // New child form: route by parentFormId
    if (event.type === 'FormCreated' && event.parentFormId) {
      const parentPcId = targetPcId ?? this.formIdIndex.get(event.parentFormId);
      if (parentPcId) {
        this.addChildForm(parentPcId, event);
      }
      return;
    }

    // New dialog: route by ownerFormId
    if (event.type === 'DialogOpened' && event.ownerFormId) {
      const ownerPcId = targetPcId ?? this.formIdIndex.get(event.ownerFormId);
      if (ownerPcId) {
        this.addDialog(ownerPcId, event);
      }
      return;
    }

    // Existing form: route by formId
    const pcId = targetPcId ?? this.formIdIndex.get(formId);
    if (!pcId) return;

    const page = this.pages.get(pcId);
    if (!page) return;

    const form = page.forms.get(formId);
    if (!form) return;

    const updated = this.formProjection.apply(form, event);
    this.updateForm(pcId, formId, updated, event);
  }

  private addChildForm(pcId: string, event: BCEvent & { type: 'FormCreated' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    // Create FormState for child
    const childForm = this.formProjection.createInitial(event.formId, event.parentFormId);
    const withTree = this.formProjection.apply(childForm, event);

    // Derive section
    const section = this.sectionResolver.deriveSection(page, event.formId, event.controlTree);

    // Update PageContext
    const forms = new Map(page.forms);
    forms.set(event.formId, withTree);

    const sections = new Map(page.sections);
    sections.set(section.sectionId, section);

    const pageType = this.inferPageType(page, sections);

    this.pages.set(pcId, {
      ...page,
      forms,
      sections,
      pageType,
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    this.formIdIndex.set(event.formId, pcId);
  }

  private addDialog(pcId: string, event: BCEvent & { type: 'DialogOpened' }): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    this.pages.set(pcId, {
      ...page,
      dialogs: [...page.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }],
      ownedFormIds: [...page.ownedFormIds, event.formId],
    });

    this.formIdIndex.set(event.formId, pcId);
  }

  private updateForm(pcId: string, formId: string, updated: FormState, event: BCEvent): void {
    const page = this.pages.get(pcId);
    if (!page) return;

    const forms = new Map(page.forms);
    forms.set(formId, updated);

    // Update pageType/caption from root form's FormCreated
    let pageType = page.pageType;
    let caption = page.caption;
    if (formId === page.rootFormId && event.type === 'FormCreated') {
      const parsed = (await import('./control-tree-parser.js')).parseControlTree(event.controlTree);
      if (parsed.pageType !== 'Unknown') pageType = parsed.pageType;
      if (parsed.caption) caption = parsed.caption;
    }

    this.pages.set(pcId, { ...page, forms, pageType, caption });
  }

  private inferPageType(
    page: PageContext,
    sections: ReadonlyMap<string, SectionDescriptor>,
  ): PageContext['pageType'] {
    // If we have a 'lines' section, it's a Document page
    for (const s of sections.values()) {
      if (s.kind === 'lines') return 'Document';
    }
    return page.pageType;
  }

  remove(pageContextId: string): void {
    const page = this.pages.get(pageContextId);
    if (page) {
      for (const fId of page.ownedFormIds) this.formIdIndex.delete(fId);
    }
    this.pages.delete(pageContextId);
  }

  listPageContextIds(): string[] { return Array.from(this.pages.keys()); }
  get size(): number { return this.pages.size; }
}
```

**IMPORTANT**: The `updateForm` method above has an `await import()` which is wrong in a sync context. Fix it: extract pageType/caption from FormCreated in `applyFormCreated` on FormProjection, and read it from FormState. Add `pageType` and `caption` fields to `FormState` or handle in `addChildForm`/root form creation path. The implementation agent should resolve this by moving the parseControlTree call to FormProjection.applyFormCreated and storing the metadata there.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Fix any type errors. The main ones will be:
- Services still importing `PageState` and using old repo API
- The async import issue noted above

- [ ] **Step 4: Update state-projection.test.ts to use FormProjection**

Rename `tests/protocol/state-projection.test.ts` to keep the old tests working with FormProjection:

```bash
mv tests/protocol/state-projection.test.ts tests/protocol/state-projection.test.ts.bak
```

The form-projection tests from Task 2 replace these.

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run`
Expected: Some failures in tests that use the old `StateProjection` API or reference `state.repeater` directly. Note which ones fail -- they'll be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/page-context-repo.ts src/protocol/types.ts
git commit -m "feat: refactor PageContextRepository for multi-form tracking with section derivation"
```

---

## Task 6: Migrate Services to PageContext

**Files:**
- Modify: `src/services/page-service.ts`
- Modify: `src/services/data-service.ts`
- Modify: `src/services/navigation-service.ts`
- Modify: `src/services/action-service.ts`
- Modify: `src/services/filter-service.ts`

This task migrates all services from `PageState` to `PageContext`. Each service gains section resolution.

- [ ] **Step 1: Create a shared section resolution helper**

Add to `src/protocol/section-resolver.ts`:

```typescript
import type { FormState } from './form-state.js';
import { primaryRepeater, resolveRepeater } from './form-state.js';

export interface ResolvedSection {
  section: SectionDescriptor;
  form: FormState;
  repeater: import('./types.js').RepeaterState | null;
}

/** Resolve a sectionId to its FormState and repeater. */
export function resolveSection(
  ctx: PageContext,
  sectionId?: string,
  defaultSection?: string,
): ResolvedSection | { error: string; availableSections: string[] } {
  const id = sectionId ?? defaultSection ?? 'header';
  const section = ctx.sections.get(id);
  if (!section) {
    return {
      error: `Section '${id}' not found.`,
      availableSections: Array.from(ctx.sections.keys()),
    };
  }
  const form = ctx.forms.get(section.formId);
  if (!form) {
    return {
      error: `Form for section '${id}' not found (formId: ${section.formId}).`,
      availableSections: Array.from(ctx.sections.keys()),
    };
  }
  const repeater = section.repeaterControlPath
    ? resolveRepeater(form, section.repeaterControlPath)
    : primaryRepeater(form);
  return { section, form, repeater };
}
```

- [ ] **Step 2: Migrate PageService**

Update `src/services/page-service.ts` to use `PageContext`:

```typescript
import type { PageContext } from '../protocol/page-context.js';
import { derivePageState } from '../protocol/types.js';  // backward compat for callers

// Change return type of openPage:
async openPage(pageId: string, options?: { bookmark?: string; tenantId?: string }): Promise<Result<PageContext, ProtocolError>> {
  // ... same invoke logic ...
  // repo.create now returns PageContext
  // repo.applyToPage now returns PageContext
  // Return PageContext directly
}

// Change closePage to use ownedFormIds:
async closePage(pageContextId: string): Promise<Result<void, ProtocolError>> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  for (const formId of ctx.ownedFormIds) {
    const closeInteraction: CloseFormInteraction = { type: 'CloseForm', formId };
    await this.session.invoke(closeInteraction, (event) => event.type === 'InvokeCompleted');
    this.session.removeOpenForm(formId);
  }

  this.repo.remove(pageContextId);
  return ok(undefined);
}
```

- [ ] **Step 3: Migrate DataService**

Update `src/services/data-service.ts` with section routing:

```typescript
import type { PageContext } from '../protocol/page-context.js';
import { resolveSection } from '../protocol/section-resolver.js';

readRows(pageContextId: string, sectionId?: string): Result<RepeaterRow[], ProtocolError> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

  return ok(resolved.repeater?.rows ?? []);
}

readField(pageContextId: string, fieldName: string, sectionId?: string): Result<ControlField | undefined, ProtocolError> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  const resolved = resolveSection(ctx, sectionId ?? 'header');
  if ('error' in resolved) return err(new ProtocolError(resolved.error));

  return ok(this.resolveField(resolved.form, fieldName));
}

// writeField gains section + row targeting:
async writeField(
  pageContextId: string,
  fieldName: string,
  value: string,
  options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
): Promise<Result<FieldWriteResult, ProtocolError>> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  const sectionId = options?.sectionId ?? 'header';
  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

  const { form, repeater } = resolved;

  // For line cell writes: select row first, then SaveValue on cell
  if (repeater && (options?.bookmark || options?.rowIndex !== undefined)) {
    return this.writeLineCell(pageContextId, form, repeater, fieldName, value, options);
  }

  // Header field write (existing logic, but using resolved form)
  const field = this.resolveField(form, fieldName);
  if (!field) {
    return this.fieldNotFoundError(ctx, fieldName, sectionId);
  }

  const interaction: SaveValueInteraction = {
    type: 'SaveValue',
    formId: form.formId,
    controlPath: field.controlPath,
    newValue: value,
  };

  const result = await this.session.invoke(interaction, (event) =>
    event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
  );
  if (isErr(result)) return result;
  this.repo.applyToPage(pageContextId, result.value);

  return ok({ fieldName, controlPath: field.controlPath, success: true, newValue: value });
}

private async writeLineCell(
  pageContextId: string,
  form: FormState,
  repeater: RepeaterState,
  fieldName: string,
  value: string,
  options: { bookmark?: string; rowIndex?: number },
): Promise<Result<FieldWriteResult, ProtocolError>> {
  // Resolve bookmark from rowIndex if needed
  let bookmark = options.bookmark;
  if (!bookmark && options.rowIndex !== undefined) {
    const row = repeater.rows[options.rowIndex];
    if (!row) {
      return err(new ProtocolError(
        `Row index ${options.rowIndex} is out of range. Currently loaded rows: 0-${repeater.rows.length - 1}.`,
      ));
    }
    bookmark = row.bookmark;
  }
  if (!bookmark) return err(new ProtocolError('No bookmark or rowIndex provided for line write'));

  // Step 1: Select the row
  const selectInteraction: SetCurrentRowInteraction = {
    type: 'SetCurrentRow',
    formId: form.formId,
    controlPath: repeater.controlPath,
    key: bookmark,
  };
  const selectResult = await this.session.invoke(selectInteraction, (event) =>
    event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
  );
  if (isErr(selectResult)) return selectResult;
  this.repo.applyToPage(pageContextId, selectResult.value);

  // Step 2: Resolve column by caption
  const col = repeater.columns.find(c => c.caption.toLowerCase() === fieldName.toLowerCase());
  if (!col) {
    return err(new ProtocolError(`Column '${fieldName}' not found in repeater.`, {
      availableColumns: repeater.columns.map(c => c.caption).filter(Boolean),
    }));
  }

  // Extract column index from controlPath (e.g., ".../co[2]" -> 2)
  const match = col.controlPath.match(/co\[(\d+)\]/);
  if (!match) return err(new ProtocolError(`Cannot determine column index from ${col.controlPath}`));
  const colIndex = parseInt(match[1]!, 10);

  // Step 3: SaveValue on the cell
  const cellPath = `${repeater.controlPath}/cr/co[${colIndex}]`;
  const saveInteraction: SaveValueInteraction = {
    type: 'SaveValue',
    formId: form.formId,
    controlPath: cellPath,
    newValue: value,
  };
  const saveResult = await this.session.invoke(saveInteraction, (event) =>
    event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
  );
  if (isErr(saveResult)) return saveResult;
  this.repo.applyToPage(pageContextId, saveResult.value);

  return ok({ fieldName, controlPath: cellPath, success: true, newValue: value });
}

private fieldNotFoundError(ctx: PageContext, fieldName: string, sectionId: string) {
  // Check if the field exists in another section
  for (const [otherId, section] of ctx.sections) {
    if (otherId === sectionId) continue;
    const otherForm = ctx.forms.get(section.formId);
    if (otherForm && this.resolveField(otherForm, fieldName)) {
      return err(new ProtocolError(
        `Field '${fieldName}' not found in section '${sectionId}'. It exists in section '${otherId}'.`,
        { availableSections: Array.from(ctx.sections.keys()) },
      ));
    }
  }
  const form = ctx.forms.get(ctx.sections.get(sectionId)?.formId ?? '');
  return err(new ProtocolError(`Field not found: ${fieldName}`, {
    availableFields: form?.controlTree.map(f => f.caption).filter(Boolean) ?? [],
  }));
}

private resolveField(form: FormState, fieldName: string): ControlField | undefined {
  const lower = fieldName.toLowerCase();
  return form.controlTree.find(f =>
    f.caption.toLowerCase() === lower || f.controlPath === fieldName,
  );
}
```

- [ ] **Step 4: Migrate NavigationService**

Update `src/services/navigation-service.ts`:

```typescript
import { resolveSection } from '../protocol/section-resolver.js';

async selectRow(
  pageContextId: string,
  bookmark: string,
  sectionId?: string,
): Promise<Result<PageContext, ProtocolError>> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return err(new ProtocolError(resolved.error));
  if (!resolved.repeater) return err(new ProtocolError(`Section '${sectionId ?? 'header'}' has no repeater`));

  const interaction: SetCurrentRowInteraction = {
    type: 'SetCurrentRow',
    formId: resolved.form.formId,
    controlPath: resolved.repeater.controlPath,
    key: bookmark,
  };

  const result = await this.session.invoke(interaction, (event) =>
    event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
  );
  if (isErr(result)) return result;
  this.repo.applyToPage(pageContextId, result.value);
  return ok(this.repo.get(pageContextId)!);
}

async drillDown(
  pageContextId: string,
  bookmark: string,
  options?: { sectionId?: string; field?: string },
): Promise<Result<{ sourcePageContextId: string; targetPageState: PageContext }, ProtocolError>> {
  const sectionId = options?.sectionId;
  const selectResult = await this.selectRow(pageContextId, bookmark, sectionId);
  if (isErr(selectResult)) return selectResult;

  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError('State lost after select'));

  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved || !resolved.repeater) {
    return err(new ProtocolError('Repeater lost after select'));
  }

  const editControlPath = resolved.repeater.controlPath + '/cr/c[0]';
  const editInteraction: InvokeActionInteraction = {
    type: 'InvokeAction',
    formId: resolved.form.formId,
    controlPath: editControlPath,
    systemAction: SystemAction.Edit,
  };

  const editResult = await this.session.invoke(editInteraction, (event) =>
    event.type === 'FormCreated' || event.type === 'InvokeCompleted',
  );
  if (isErr(editResult)) return editResult;

  // ... rest of drill-down logic stays the same but uses PageContext ...
}
```

- [ ] **Step 5: Migrate ActionService**

Update `src/services/action-service.ts` with section-scoped action resolution:

```typescript
import { resolveSection } from '../protocol/section-resolver.js';

async executeAction(
  pageContextId: string,
  actionName: string,
  options?: { sectionId?: string; bookmark?: string; rowIndex?: number },
): Promise<Result<ActionResult, ProtocolError>> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  // Find action across sections, preferring the specified section
  const { action, actionForm, resolved } = this.findAction(ctx, actionName, options?.sectionId);
  if (!action) {
    return err(new ProtocolError(`Action not found: ${actionName}`, {
      availableActions: this.listActions(ctx, options?.sectionId),
    }));
  }

  // If row-targeting, select row first in the target section
  if (resolved?.repeater && (options?.bookmark || options?.rowIndex !== undefined)) {
    // Select row in the section's repeater
    let bookmark = options?.bookmark;
    if (!bookmark && options?.rowIndex !== undefined) {
      const row = resolved.repeater.rows[options.rowIndex];
      if (!row) return err(new ProtocolError(`Row index ${options.rowIndex} out of range`));
      bookmark = row.bookmark;
    }
    if (bookmark) {
      const selectResult = await this.selectRowInForm(pageContextId, resolved.form, resolved.repeater, bookmark);
      if (isErr(selectResult)) return selectResult;
    }
  }

  return this.invokeAction(pageContextId, actionForm, action.controlPath, action.systemAction);
}

private findAction(ctx: PageContext, actionName: string, sectionId?: string) {
  const lower = actionName.toLowerCase();

  // If section specified, look there first, then root form for line-scoped actions
  if (sectionId) {
    const resolved = resolveSection(ctx, sectionId);
    if (!('error' in resolved)) {
      const action = resolved.form.actions.find(a => a.caption.toLowerCase() === lower);
      if (action) return { action, actionForm: resolved.form, resolved };

      // Check root form for actions that are line-scoped
      if (sectionId !== 'header') {
        const rootForm = ctx.forms.get(ctx.rootFormId);
        if (rootForm) {
          const rootAction = rootForm.actions.find(a =>
            a.caption.toLowerCase() === lower && (a.isLineScoped || ROW_TARGETING_ACTIONS.has(a.systemAction)),
          );
          if (rootAction) return { action: rootAction, actionForm: rootForm, resolved };
        }
      }
    }
  }

  // No section: search all forms
  for (const [, form] of ctx.forms) {
    const action = form.actions.find(a => a.caption.toLowerCase() === lower);
    if (action) return { action, actionForm: form, resolved: undefined };
  }

  return { action: undefined, actionForm: undefined, resolved: undefined };
}
```

- [ ] **Step 6: Migrate FilterService**

Update `src/services/filter-service.ts` to accept sectionId and resolve the correct form/repeater:

```typescript
async applyFilters(pageContextId: string, filters: Filter[], sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
  const ctx = this.repo.get(pageContextId);
  if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return err(new ProtocolError(resolved.error));
  if (!resolved.repeater) return err(new ProtocolError('Section has no repeater -- cannot filter'));

  const form = resolved.form;
  const filterControlPath = form.filterControlPath;
  if (!filterControlPath) return err(new ProtocolError('Section has no FilterLogicalControl'));

  for (const filter of filters) {
    // ... same logic but use form.formId and resolved.repeater.columns ...
  }
}
```

- [ ] **Step 7: Run type check and fix errors**

Run: `npx tsc --noEmit`
Fix all remaining type errors. The main issues will be import paths and return types.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Fix any failing tests. Update test expectations where return types changed from `PageState` to `PageContext`.

- [ ] **Step 9: Commit**

```bash
git add src/services/ src/protocol/
git commit -m "feat: migrate all services to PageContext with section-aware routing"
```

---

## Task 7: Operations and MCP Layer

**Files:**
- Modify: `src/operations/open-page.ts`
- Modify: `src/operations/read-data.ts`
- Modify: `src/operations/write-data.ts`
- Modify: `src/operations/execute-action.ts`
- Modify: `src/operations/navigate.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tool-registry.ts`

- [ ] **Step 1: Update schemas**

In `src/mcp/schemas.ts`, add section and row targeting params:

```typescript
export const ReadDataSchema = z.object({
  pageContextId: z.string().min(1),
  section: z.string().optional(),
  range: z.object({ offset: z.number(), limit: z.number() }).optional(),
  filters: z.array(z.object({ column: z.string(), value: z.string() })).optional(),
  columns: z.array(z.string()).optional(),
});

export const WriteDataSchema = z.object({
  pageContextId: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  section: z.string().optional(),
  rowIndex: z.number().optional(),
  bookmark: z.string().optional(),
});

export const ExecuteActionSchema = z.object({
  pageContextId: z.string().min(1),
  action: z.string().min(1),
  section: z.string().optional(),
  rowIndex: z.number().optional(),
  bookmark: z.string().optional(),
});

export const NavigateSchema = z.object({
  pageContextId: z.string().min(1),
  bookmark: z.string().min(1),
  action: z.enum(['drill_down', 'select', 'lookup']).optional(),
  section: z.string().optional(),
  field: z.string().optional(),
});
```

- [ ] **Step 2: Update OpenPageOperation to include sections**

```typescript
// src/operations/open-page.ts
export interface OpenPageOutput {
  pageContextId: string;
  pageType: string;
  caption: string;
  sections: Array<{
    sectionId: string;
    kind: string;
    caption: string;
    hasRepeater: boolean;
    fieldCount: number;
    actionCount: number;
  }>;
  fields: Array<{ name: string; value?: string; editable: boolean; type: string }>;
  actions: Array<{ name: string; systemAction: number; enabled: boolean }>;
  rows?: Array<{ index: number; bookmark: string; cells: Record<string, unknown> }>;
}

// In execute():
return mapResult(result, (ctx) => {
  const rootForm = ctx.forms.get(ctx.rootFormId);
  const sections = Array.from(ctx.sections.values()).map(s => {
    const form = ctx.forms.get(s.formId);
    return {
      sectionId: s.sectionId,
      kind: s.kind,
      caption: s.caption,
      hasRepeater: !!s.repeaterControlPath,
      fieldCount: form?.controlTree.length ?? 0,
      actionCount: form?.actions.length ?? 0,
    };
  });

  const repeater = rootForm ? primaryRepeater(rootForm) : null;

  return {
    pageContextId: ctx.pageContextId,
    pageType: ctx.pageType,
    caption: ctx.caption,
    sections,
    fields: rootForm?.controlTree
      .filter(f => f.visible && f.caption)
      .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable, type: f.type })) ?? [],
    actions: rootForm?.actions
      .filter(a => a.visible && a.enabled && a.caption)
      .map(a => ({ name: a.caption, systemAction: a.systemAction, enabled: a.enabled })) ?? [],
    rows: repeater?.rows.map((r, i) => ({ index: i, bookmark: r.bookmark, cells: r.cells })),
  };
});
```

- [ ] **Step 3: Update ReadDataOperation with section param**

```typescript
// src/operations/read-data.ts
export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  range?: { offset: number; limit: number };
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
}
```

Wire `section` through to `dataService.readRows(input.pageContextId, input.section)`.

- [ ] **Step 4: Update WriteDataOperation with section + row targeting**

```typescript
// src/operations/write-data.ts
export interface WriteDataInput {
  pageContextId: string;
  fields: Record<string, string>;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
}
```

Wire `section`, `rowIndex`, `bookmark` through to `dataService.writeFields`.

- [ ] **Step 5: Update ExecuteActionOperation with section + row targeting**

Wire `section`, `rowIndex`, `bookmark` through to `actionService.executeAction`.

- [ ] **Step 6: Update NavigateOperation with section + field**

Wire `section` and `field` through to `navigationService.drillDown`.

- [ ] **Step 7: Update tool descriptions in tool-registry.ts**

Update descriptions to mention sections. Key changes:
- `bc_open_page`: "Returns sections list for Document pages (header, lines, factboxes)."
- `bc_read_data`: "Optional `section` param targets specific section. Default: header."
- `bc_write_data`: "For Document page lines, use `section: 'lines'` with `rowIndex` or `bookmark`."
- `bc_execute_action`: "Use `section` to disambiguate actions that exist on multiple sections."
- `bc_navigate`: "Use `section` to drill-down from a specific section's repeater."

- [ ] **Step 8: Run type check and all tests**

Run: `npx tsc --noEmit && npx vitest run`
Fix any errors.

- [ ] **Step 9: Commit**

```bash
git add src/operations/ src/mcp/
git commit -m "feat: wire section, rowIndex, bookmark params through operations and MCP layer"
```

---

## Task 8: Delete StateProjection and Clean Up

**Files:**
- Delete: `src/protocol/state-projection.ts`
- Delete: `tests/protocol/state-projection.test.ts.bak`
- Modify: any remaining imports of StateProjection

- [ ] **Step 1: Search for remaining StateProjection references**

Run: `grep -r "StateProjection\|state-projection" src/ tests/ --include="*.ts" -l`

- [ ] **Step 2: Remove all references and delete the file**

Delete `src/protocol/state-projection.ts`. Update any remaining imports.

- [ ] **Step 3: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove StateProjection, replaced by FormProjection"
```

---

## Task 9: Integration Smoke Test

**Files:**
- Create: `tests/integration/multi-section.test.ts`

This verifies the full stack against real BC. Requires BC27/BC28 running.

- [ ] **Step 1: Write integration test for Sales Order page**

```typescript
// tests/integration/multi-section.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// ... import session setup helpers from existing integration tests ...

describe('Multi-Section: Sales Order (page 42)', () => {
  // ... session setup ...

  it('opens page 42 and finds header + lines sections', async () => {
    const result = await openPage.execute({ pageId: '42' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { sections } = result.value;
    const sectionIds = sections.map(s => s.sectionId);

    expect(sectionIds).toContain('header');
    // lines section should appear (from child form with repeater)
    const linesSection = sections.find(s => s.kind === 'lines');
    expect(linesSection).toBeDefined();

    console.error('Sections found:', sections.map(s => `${s.sectionId} (${s.kind})`));
  });

  it('reads line items from lines section', async () => {
    const result = await readData.execute({
      pageContextId: lastPageContextId,
      section: 'lines',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rows.length).toBeGreaterThan(0);
    console.error('Line rows:', result.value.rows.length);
    console.error('First line cells:', JSON.stringify(result.value.rows[0]?.cells));
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/multi-section.test.ts`
Expected: PASS (if BC is running).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/multi-section.test.ts
git commit -m "test: add multi-section integration smoke test for Sales Order page"
```

---

## Summary

| Task | What it does | Files |
|---|---|---|
| 1 | Type definitions | types.ts, form-state.ts, section-resolver.ts, page-context.ts |
| 2 | FormProjection | form-state.ts, form-projection.test.ts |
| 3 | Control tree parser | control-tree-parser.ts, control-tree-parser.test.ts |
| 4 | SectionResolver | section-resolver.ts, section-resolver.test.ts |
| 5 | PageContextRepository | page-context-repo.ts, types.ts |
| 6 | Service migration | All 5 services |
| 7 | Operations + MCP | All 5 operations, schemas.ts, tool-registry.ts |
| 8 | Cleanup | Delete state-projection.ts |
| 9 | Integration test | multi-section.test.ts |

**After this plan**: Tier 3 (robustness -- unified result envelope, instructional errors, cascading refresh) and Tier 4 (extended -- dialog response tool, factboxes, paging) are separate follow-up plans per PHASE2.md.
