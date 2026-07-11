// src/protocol/form-state.ts
import type {
  RepeaterRow, ControlContainerType,
  BCEvent, DataLoadedEvent, RowDeltaEvent, PropertyChangedEvent, BookmarkChangedEvent,
} from './types.js';
import type { FormNode } from './form-node.js';
import type { NodeProperties } from './form-node.js';
import { buildFormTree } from './form-tree-builder.js';
import { applyPropertyChange } from './form-tree-mutator.js';
import { repeaters as treeRepeaters } from './form-views.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  /** Reactive control tree — replaced (with structural sharing) by FormProjection.apply via the tree mutator.
   * Source of truth for fields/actions/tabs/repeaters/groupVisibility (computed via form-views.ts). */
  readonly root: FormNode;
  /** Repeater rows keyed by repeater controlPath. */
  readonly rows: ReadonlyMap<string, readonly RepeaterRow[]>;
  readonly containerType?: ControlContainerType;
}

export class FormProjection {
  /** Creates an empty FormState for the given formId. */
  createInitial(formId: string, parentFormId?: string): FormState {
    const root = buildFormTree({ t: 'lf', ServerId: formId, Children: [], PageType: -1 });
    return {
      formId,
      parentFormId,
      root,
      rows: new Map(),
    };
  }

  /** Applies a single BCEvent to the given FormState, returning an updated copy. */
  apply(form: FormState, event: BCEvent): FormState {
    switch (event.type) {
      case 'DataLoaded':
        return this.applyDataLoaded(form, event);
      case 'RowDelta':
        return this.applyRowDelta(form, event);
      case 'PropertyChanged':
        return this.applyPropertyChanged(form, event);
      case 'BookmarkChanged':
        return this.applyBookmarkChanged(form, event);
      default:
        return form;
    }
  }

  private applyDataLoaded(form: FormState, event: DataLoadedEvent): FormState {
    // Look up the RepeaterNode in the tree; if absent, this is a no-op.
    const repeaterNode = treeRepeaters(form.root).get(event.controlPath);
    if (!repeaterNode) return form;

    const extractedRows = this.extractRows(event.rows);

    let newRows: readonly RepeaterRow[];
    if (event.currentRowOnly) {
      // Upsert by bookmark: update matched rows in place and append any row whose
      // bookmark is new (BC can re-bookmark the current row, e.g. draft→committed,
      // which the old update-only map would silently drop).
      const existing = form.rows.get(event.controlPath) ?? [];
      const seen = new Set<string>();
      newRows = [
        ...existing.map(r => {
          const upd = extractedRows.find(x => x.bookmark === r.bookmark);
          if (upd) seen.add(upd.bookmark);
          return upd ?? r;
        }),
        ...extractedRows.filter(x => !seen.has(x.bookmark) && !existing.some(r => r.bookmark === x.bookmark)),
      ];
    } else {
      newRows = extractedRows;
    }

    const newRowsMap = new Map(form.rows);
    newRowsMap.set(event.controlPath, newRows);
    return { ...form, rows: newRowsMap };
  }

  /**
   * Apply an incremental repeater-row delta (insert / update / remove) delivered
   * as a top-level DataRow* change. No-op if the repeater path is not in this
   * form's tree (so the facade falls back to the child form that owns it).
   */
  private applyRowDelta(form: FormState, event: RowDeltaEvent): FormState {
    const repeaterNode = treeRepeaters(form.root).get(event.controlPath);
    if (!repeaterNode) return form;

    const existing = form.rows.get(event.controlPath) ?? [];
    let next: readonly RepeaterRow[];

    if (event.op === 'remove') {
      if (!existing.some(r => r.bookmark === event.bookmark)) return form;
      next = existing.filter(r => r.bookmark !== event.bookmark);
    } else {
      const row: RepeaterRow = { bookmark: event.bookmark, cells: event.cells ?? {} };
      const idx = existing.findIndex(r => r.bookmark === event.bookmark);
      if (idx >= 0) {
        const copy = existing.slice();
        copy[idx] = row;
        next = copy;
      } else {
        const at = event.op === 'insert' && typeof event.index === 'number'
          ? Math.max(0, Math.min(event.index, existing.length))
          : existing.length;
        const copy = existing.slice();
        copy.splice(at, 0, row);
        next = copy;
      }
    }

    const newRowsMap = new Map(form.rows);
    newRowsMap.set(event.controlPath, next);
    return { ...form, rows: newRowsMap };
  }

  private applyPropertyChanged(form: FormState, event: PropertyChangedEvent): FormState {
    const changes = event.changes as Record<string, unknown>;

    // Translate BC's wire property names (PascalCase) → NodeProperties (camelCase)
    const nodeChanges: NodeProperties = {};
    if ('Visible' in changes && typeof changes.Visible === 'boolean') (nodeChanges as Record<string, unknown>).visible = changes.Visible;
    if ('Editable' in changes && typeof changes.Editable === 'boolean') (nodeChanges as Record<string, unknown>).editable = changes.Editable;
    if ('Enabled' in changes && typeof changes.Enabled === 'boolean') (nodeChanges as Record<string, unknown>).enabled = changes.Enabled;
    if ('Caption' in changes && typeof changes.Caption === 'string') (nodeChanges as Record<string, unknown>).caption = changes.Caption;
    if ('StringValue' in changes) (nodeChanges as Record<string, unknown>).stringValue = changes.StringValue == null ? undefined : String(changes.StringValue);
    if ('ObjectValue' in changes) (nodeChanges as Record<string, unknown>).objectValue = changes.ObjectValue;
    if ('TotalRowCount' in changes && typeof changes.TotalRowCount === 'number') (nodeChanges as Record<string, unknown>).totalRowCount = changes.TotalRowCount;
    if ('Bookmark' in changes && typeof changes.Bookmark === 'string') (nodeChanges as Record<string, unknown>).bookmark = changes.Bookmark;
    if ('HasFiltersApplied' in changes && typeof changes.HasFiltersApplied === 'boolean') (nodeChanges as Record<string, unknown>).hasFiltersApplied = changes.HasFiltersApplied;

    // Option fields: BC echoes the selected index as CurrentIndex. When a
    // SaveValue echoes only StringValue (no CurrentIndex), the build-time
    // optionIndex is now stale — clear it so section-dto falls back to matching
    // the new stringValue against the option texts instead of reporting the
    // pre-change option.
    if ('CurrentIndex' in changes && typeof changes.CurrentIndex === 'number') {
      (nodeChanges as Record<string, unknown>).optionIndex = changes.CurrentIndex;
    } else if ('StringValue' in changes) {
      (nodeChanges as Record<string, unknown>).optionIndex = undefined;
    }

    // Nothing this reducer tracks changed (e.g. an event carrying only
    // ValidationResults / ShowMandatory / Items). Return the same reference so
    // the "no change → same root" contract holds and the WeakMap view caches
    // are not needlessly invalidated.
    if (Object.keys(nodeChanges).length === 0) return form;

    const newRoot = applyPropertyChange(form.root, event.controlPath, nodeChanges);
    if (newRoot === form.root) return form;
    return { ...form, root: newRoot };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    // Bookmark lives on the repeater's NodeProperties — route through the mutator.
    const newRoot = applyPropertyChange(form.root, event.controlPath, { bookmark: event.bookmark });
    if (newRoot === form.root) return form;
    return { ...form, root: newRoot };
  }

  private extractRows(rawRows: unknown[]): RepeaterRow[] {
    const rows: RepeaterRow[] = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      // BC28's /csh wire uses the long-name keys; accept the abbreviated tags
      // (drich/druch) too in case an older tier emits them. The [1] payload is
      // guarded so a malformed row (e.g. [index, null]) can't throw and abort
      // the whole batch.
      const rowData = (r['DataRowInserted'] ?? r['DataRowUpdated'] ?? r['drich'] ?? r['druch']) as unknown[] | undefined;
      if (Array.isArray(rowData) && rowData.length >= 2 && rowData[1] && typeof rowData[1] === 'object') {
        const payload = rowData[1] as Record<string, unknown>;
        rows.push({
          bookmark: (payload['bookmark'] ?? payload['Bookmark'] ?? '') as string,
          cells: (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>,
        });
      }
    }
    return rows;
  }
}
