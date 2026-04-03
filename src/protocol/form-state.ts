// src/protocol/form-state.ts
import type {
  ControlField, RepeaterState, RepeaterRow, ActionInfo, ControlContainerType,
  BCEvent, DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent,
} from './types.js';

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

export class FormProjection {
  /** Creates an empty FormState for the given formId. */
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

  /** Applies a single BCEvent to the given FormState, returning an updated copy. */
  apply(form: FormState, event: BCEvent): FormState {
    switch (event.type) {
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
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;

    const extractedRows = this.extractRows(event.rows);

    let newRows: RepeaterRow[];
    if (event.currentRowOnly) {
      // Merge by bookmark -- replace matching rows, keep others
      newRows = form.repeaters.get(event.controlPath)!.rows.map(existing => {
        const updated = extractedRows.find(r => r.bookmark === existing.bookmark);
        return updated ?? existing;
      });
    } else {
      newRows = extractedRows;
    }

    const updatedRepeater: RepeaterState = {
      ...repeater,
      rows: newRows,
      // totalRowCount is NOT inferred from rows.length -- stays null unless set by PropertyChanged
    };

    const newRepeaters = new Map(form.repeaters);
    newRepeaters.set(event.controlPath, updatedRepeater);
    return { ...form, repeaters: newRepeaters };
  }

  private applyPropertyChanged(form: FormState, event: PropertyChangedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);

    if (repeater && 'TotalRowCount' in event.changes) {
      const totalRowCount = event.changes['TotalRowCount'] as number;
      const updatedRepeater: RepeaterState = { ...repeater, totalRowCount };
      const newRepeaters = new Map(form.repeaters);
      newRepeaters.set(event.controlPath, updatedRepeater);
      return { ...form, repeaters: newRepeaters };
    }

    // Otherwise update the controlTree field
    const { StringValue, Caption, Editable, Visible } = event.changes as Record<string, unknown>;

    const existingIndex = form.controlTree.findIndex(f => f.controlPath === event.controlPath);
    let updatedTree: ControlField[];

    if (existingIndex >= 0) {
      const existing = form.controlTree[existingIndex]!;
      const updated: ControlField = {
        ...existing,
        ...(StringValue !== undefined ? { stringValue: StringValue as string } : {}),
        ...(Caption !== undefined ? { caption: Caption as string } : {}),
        ...(Editable !== undefined ? { editable: Editable as boolean } : {}),
        ...(Visible !== undefined ? { visible: Visible as boolean } : {}),
      };
      updatedTree = [
        ...form.controlTree.slice(0, existingIndex),
        updated,
        ...form.controlTree.slice(existingIndex + 1),
      ];
    } else {
      const newField: ControlField = {
        controlPath: event.controlPath,
        caption: (Caption as string | undefined) ?? '',
        type: '',
        editable: (Editable as boolean | undefined) ?? false,
        visible: (Visible as boolean | undefined) ?? true,
        ...(StringValue !== undefined ? { stringValue: StringValue as string } : {}),
      };
      updatedTree = [...form.controlTree, newField];
    }

    return { ...form, controlTree: updatedTree };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;

    const updatedRepeater: RepeaterState = { ...repeater, currentBookmark: event.bookmark };
    const newRepeaters = new Map(form.repeaters);
    newRepeaters.set(event.controlPath, updatedRepeater);
    return { ...form, repeaters: newRepeaters };
  }

  private extractRows(rawRows: unknown[]): RepeaterRow[] {
    const rows: RepeaterRow[] = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const rowData = (r['DataRowInserted'] ?? r['DataRowUpdated']) as unknown[] | undefined;
      if (Array.isArray(rowData) && rowData.length >= 2) {
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
