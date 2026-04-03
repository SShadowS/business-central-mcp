import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageState, FilterInteraction } from '../protocol/types.js';
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

    for (const filter of filters) {
      // Re-read state each iteration so we have the latest formId / repeater
      const currentState = this.repo.get(pageContextId);
      if (!currentState?.repeater) return err(new ProtocolError('State lost during filter application'));

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

      // Filter(AddLine) — create filter row in BC UI
      const addLineInteraction: FilterInteraction = {
        type: 'Filter',
        formId: currentState.formId,
        controlPath: currentState.repeater.controlPath,
        filterOperation: FilterOperation.AddLine,
        filterColumnId: columnBinderPath,
        filterValue: filter.value,
      };

      const addResult = await this.session.invoke(
        addLineInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );

      if (isErr(addResult)) return addResult;
      this.repo.applyToPage(pageContextId, addResult.value);
    }

    const updatedState = this.repo.get(pageContextId);
    if (!updatedState) return err(new ProtocolError('State lost after filter'));

    this.logger.info(`Filters applied on ${pageContextId}: ${filters.map(f => `${f.column}=${f.value}`).join(', ')}`);
    return ok(updatedState);
  }

  async clearFilters(pageContextId: string): Promise<Result<PageState, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    if (!state.repeater) return err(new ProtocolError('Page has no repeater — cannot clear filters'));

    const resetInteraction: FilterInteraction = {
      type: 'Filter',
      formId: state.formId,
      controlPath: state.repeater.controlPath,
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

    this.logger.info(`Filters cleared on ${pageContextId}`);
    return ok(updatedState);
  }
}
