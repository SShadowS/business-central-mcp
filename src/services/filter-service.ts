import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { FilterInteraction } from '../protocol/types.js';
import { FilterOperation } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
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

  async applyFilter(pageContextId: string, columnName: string, value: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    return this.applyFilters(pageContextId, [{ column: columnName, value }], sectionId);
  }

  async applyFilters(pageContextId: string, filters: Filter[], sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot filter'));
    if (!resolved.form.filterControlPath) {
      return err(new ProtocolError('Page has no FilterLogicalControl (filc) -- cannot filter'));
    }

    for (const filter of filters) {
      // Re-read state each iteration so we have the latest formId / repeater
      const currentCtx = this.repo.get(pageContextId);
      if (!currentCtx) return err(new ProtocolError('State lost during filter application'));

      const currentResolved = resolveSection(currentCtx, sectionId);
      if ('error' in currentResolved) return err(new ProtocolError(currentResolved.error, { availableSections: currentResolved.availableSections }));
      if (!currentResolved.repeater) return err(new ProtocolError('State lost during filter application'));

      const filterControlPath = currentResolved.form.filterControlPath;
      if (!filterControlPath) return err(new ProtocolError('FilterControlPath lost during filter application'));

      // Resolve column name to filterColumnId (ColumnBinderPath from repeater columns)
      const column = currentResolved.repeater.columns.find(c =>
        c.caption.toLowerCase() === filter.column.toLowerCase()
      );

      if (!column) {
        return err(new ProtocolError(`Filter column not found: ${filter.column}`, {
          availableColumns: currentResolved.repeater.columns.map(c => c.caption).filter(Boolean),
        }));
      }

      const columnBinderPath = column.columnBinderPath;
      if (!columnBinderPath) {
        return err(new ProtocolError(`Column ${filter.column} has no columnBinderPath for filtering`));
      }

      // Single-step: Filter(AddLine) with FilterValue included directly
      // BC's Filter(AddLine) accepts FilterValue in namedParameters, no separate SaveValue needed
      const addLineInteraction: FilterInteraction = {
        type: 'Filter',
        formId: currentResolved.form.formId,
        controlPath: filterControlPath,
        filterOperation: FilterOperation.AddLine,
        filterColumnId: columnBinderPath,
        filterValue: filter.value,
      };

      this.logger.info(`[Filter] Filter(AddLine) on ${filterControlPath}, column=${columnBinderPath}, value="${filter.value}"`);
      this.logger.info(`[Filter] repeater.controlPath=${currentResolved.repeater.controlPath}, formId=${currentResolved.form.formId}`);

      const addResult = await this.session.invoke(
        addLineInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );

      if (isErr(addResult)) return addResult;
      this.repo.applyToPage(pageContextId, addResult.value);
    }

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after filter'));

    this.logger.info(`[Filter] Filters applied on ${pageContextId}: ${filters.map(f => `${f.column}=${f.value}`).join(', ')}`);
    return ok(updatedCtx);
  }

  async clearFilters(pageContextId: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot clear filters'));

    // Use filterControlPath if available, fall back to repeater controlPath for Reset
    const controlPath = resolved.form.filterControlPath ?? resolved.repeater.controlPath;

    const resetInteraction: FilterInteraction = {
      type: 'Filter',
      formId: resolved.form.formId,
      controlPath,
      filterOperation: FilterOperation.Reset,
    };

    const result = await this.session.invoke(
      resetInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );

    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after clear'));

    this.logger.info(`[Filter] Filters cleared on ${pageContextId}`);
    return ok(updatedCtx);
  }
}
