import type {
  PageState, ControlField, RepeaterRow, BCEvent,
} from './types.js';
import { parseControlTree } from './control-tree-parser.js';

export class StateProjection {
  createInitial(pageContextId: string, formId: string): PageState {
    return {
      pageContextId, formId, pageType: 'Unknown',
      controlTree: [], repeater: null, actions: [],
      childForms: [], dialogs: [], openFormIds: [formId],
    };
  }

  apply(state: PageState, events: BCEvent[]): PageState {
    let current = state;
    for (const event of events) {
      current = this.applyEvent(current, event);
    }
    return current;
  }

  private applyEvent(state: PageState, event: BCEvent): PageState {
    switch (event.type) {
      case 'DataLoaded':
        return event.formId === state.formId ? this.applyDataLoaded(state, event) : state;
      case 'PropertyChanged':
        return event.formId === state.formId ? this.applyPropertyChanged(state, event) : state;
      case 'DialogOpened':
        return this.applyDialogOpened(state, event);
      case 'FormCreated':
        if (event.formId === state.formId) {
          // Parse the control tree for metadata
          const parsed = parseControlTree(event.controlTree);
          return {
            ...state,
            pageType: parsed.pageType !== 'Unknown' ? parsed.pageType : state.pageType,
            controlTree: parsed.fields.length > 0 ? parsed.fields : state.controlTree,
            repeater: parsed.repeater ?? state.repeater,
            actions: parsed.actions.length > 0 ? parsed.actions : state.actions,
          };
        }
        // Child form
        if (event.parentFormId === state.formId) {
          return {
            ...state,
            childForms: [...state.childForms, { formId: event.formId, caption: '' }],
            openFormIds: [...state.openFormIds, event.formId],
          };
        }
        return state;
      case 'BookmarkChanged':
      case 'InvokeCompleted':
      case 'SessionInfo':
        return state;
    }
  }

  private applyDataLoaded(state: PageState, event: BCEvent & { type: 'DataLoaded' }): PageState {
    const rows = this.extractRows(event.rows);
    if (event.currentRowOnly && state.repeater) {
      const updatedRows = [...state.repeater.rows];
      for (const newRow of rows) {
        const idx = updatedRows.findIndex(r => r.bookmark === newRow.bookmark);
        if (idx >= 0) updatedRows[idx] = newRow;
        else updatedRows.push(newRow);
      }
      return { ...state, repeater: { ...state.repeater, rows: updatedRows, totalRowCount: updatedRows.length } };
    }
    return {
      ...state,
      repeater: { controlPath: event.controlPath, columns: state.repeater?.columns ?? [], rows, totalRowCount: rows.length },
    };
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

  private applyPropertyChanged(state: PageState, event: BCEvent & { type: 'PropertyChanged' }): PageState {
    const existing = state.controlTree.find(f => f.controlPath === event.controlPath);
    const ch = event.changes;
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
      ? state.controlTree.map(f => f.controlPath === event.controlPath ? field : f)
      : [...state.controlTree, field];
    return { ...state, controlTree };
  }

  private applyDialogOpened(state: PageState, event: BCEvent & { type: 'DialogOpened' }): PageState {
    return {
      ...state,
      dialogs: [...state.dialogs, { formId: event.formId, ownerFormId: event.ownerFormId, controlTree: event.controlTree }],
      openFormIds: [...state.openFormIds, event.formId],
    };
  }
}
