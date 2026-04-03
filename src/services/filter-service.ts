import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageState, FilterInteraction, SaveValueInteraction } from '../protocol/types.js';
import { FilterOperation } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export interface Filter {
  column: string;
  value: string;
}

export class FilterService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async applyFilter(pageContextId: string, columnName: string, value: string): Promise<Result<PageState, ProtocolError>> {
    return this.applyFilters(pageContextId, [{ column: columnName, value }]);
  }

  async applyFilters(pageContextId: string, filters: Filter[]): Promise<Result<PageState, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    if (!state.repeater) return err(new ProtocolError('Page has no repeater — cannot filter'));
    if (!state.filterControlPath) {
      return err(new ProtocolError('Page has no FilterLogicalControl (filc) — cannot filter'));
    }

    for (const filter of filters) {
      // Re-read state each iteration so we have the latest formId / repeater
      const currentState = this.repo.get(pageContextId);
      if (!currentState?.repeater) return err(new ProtocolError('State lost during filter application'));

      const filterControlPath = currentState.filterControlPath;
      if (!filterControlPath) return err(new ProtocolError('FilterControlPath lost during filter application'));

      // Resolve column name to filterColumnId (ColumnBinderPath from repeater columns)
      const column = currentState.repeater.columns.find(c =>
        c.caption.toLowerCase() === filter.column.toLowerCase()
      );

      if (!column) {
        return err(new ProtocolError(`Filter column not found: ${filter.column}`, {
          availableColumns: currentState.repeater.columns.map(c => c.caption).filter(Boolean),
        }));
      }

      const columnBinderPath = column.columnBinderPath;
      if (!columnBinderPath) {
        return err(new ProtocolError(`Column ${filter.column} has no columnBinderPath for filtering`));
      }

      // STEP 1: Filter(AddLine) — create filter row in BC UI
      // This targets the FilterLogicalControl (filc), NOT the repeater
      // filterValue is NOT included — that comes in step 2 via SaveValue
      const addLineInteraction: FilterInteraction = {
        type: 'Filter',
        formId: currentState.formId,
        controlPath: filterControlPath,
        filterOperation: FilterOperation.AddLine,
        filterColumnId: columnBinderPath,
      };

      this.logger.info(`[Filter] Step 1: Filter(AddLine) on ${filterControlPath}, column=${columnBinderPath}`);

      const addResult = await this.session.invoke(
        addLineInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );

      if (isErr(addResult)) return addResult;
      this.repo.applyToPage(pageContextId, addResult.value);

      // STEP 2: SaveValue — set the actual filter value
      // After Filter(AddLine), BC creates a filter row. The SaveValue targets
      // the filter value control at {filterControlPath}/c[0]/c[1]
      const saveValueControlPath = `${filterControlPath}/c[0]/c[1]`;
      const saveValueInteraction: SaveValueInteraction = {
        type: 'SaveValue',
        formId: currentState.formId,
        controlPath: saveValueControlPath,
        newValue: filter.value,
      };

      this.logger.info(`[Filter] Step 2: SaveValue on ${saveValueControlPath}, value="${filter.value}"`);

      const saveResult = await this.session.invoke(
        saveValueInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );

      if (isErr(saveResult)) return saveResult;
      this.repo.applyToPage(pageContextId, saveResult.value);
    }

    const updatedState = this.repo.get(pageContextId);
    if (!updatedState) return err(new ProtocolError('State lost after filter'));

    this.logger.info(`[Filter] Filters applied on ${pageContextId}: ${filters.map(f => `${f.column}=${f.value}`).join(', ')}`);
    return ok(updatedState);
  }

  async clearFilters(pageContextId: string): Promise<Result<PageState, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    if (!state.repeater) return err(new ProtocolError('Page has no repeater — cannot clear filters'));

    // Use filterControlPath if available, fall back to repeater controlPath for Reset
    const controlPath = state.filterControlPath ?? state.repeater.controlPath;

    const resetInteraction: FilterInteraction = {
      type: 'Filter',
      formId: state.formId,
      controlPath,
      filterOperation: FilterOperation.Reset,
    };

    const result = await this.session.invoke(
      resetInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );

    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    const updatedState = this.repo.get(pageContextId);
    if (!updatedState) return err(new ProtocolError('State lost after clear'));

    this.logger.info(`[Filter] Filters cleared on ${pageContextId}`);
    return ok(updatedState);
  }
}
