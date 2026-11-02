import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { FilterInteraction } from '../protocol/types.js';
import { FilterOperation } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { filterControlPath } from '../protocol/form-views.js';
import type { Logger } from '../core/logger.js';

export interface Filter {
  column: string;
  value: string;
}

export class FilterService {
  /** Page contexts this session added a filter to, so close_page can clear it first (#57). */
  private readonly filtered = new Set<string>();

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

    const initialFilterPath = filterControlPath(resolved.form.root);
    if (!initialFilterPath) {
      return err(new ProtocolError('Page has no FilterLogicalControl (filc) -- cannot filter'));
    }

    // BC's AddLine sets the value only when it is not empty (FilterInteraction.AddFilterLine),
    // so an empty value adds a blank line and leaves the column's filter in place.
    const empty = filters.find(f => f.value === '');
    if (empty) {
      return err(new ProtocolError(`Filter value for '${empty.column}' is empty: BC ignores an empty filter value, so it cannot remove a filter. Pass clearFilters: true to remove the filters, then the ones to keep. Nothing was sent.`));
    }

    for (const filter of filters) {
      const currentCtx = this.repo.get(pageContextId);
      if (!currentCtx) return err(new ProtocolError('State lost during filter application'));

      const currentResolved = resolveSection(currentCtx, sectionId);
      if ('error' in currentResolved) return err(new ProtocolError(currentResolved.error, { availableSections: currentResolved.availableSections }));
      if (!currentResolved.repeater) return err(new ProtocolError('State lost during filter application'));

      const fpath = filterControlPath(currentResolved.form.root);
      if (!fpath) return err(new ProtocolError('FilterControlPath lost during filter application'));

      // Resolve column on the RepeaterNode by caption
      const column = currentResolved.repeater.columns.find(c =>
        (c.properties.caption ?? '').toLowerCase() === filter.column.toLowerCase()
      );
      if (!column) {
        return err(new ProtocolError(`Filter column not found: ${filter.column}`, {
          availableColumns: currentResolved.repeater.columns.map(c => c.properties.caption ?? '').filter(Boolean),
        }));
      }
      const columnBinderPath = column.columnBinder?.path;
      if (!columnBinderPath) {
        return err(new ProtocolError(`Column ${filter.column} has no columnBinderPath for filtering`));
      }

      const addLineInteraction: FilterInteraction = {
        type: 'Filter',
        formId: currentResolved.form.formId,
        controlPath: fpath,
        filterOperation: FilterOperation.AddLine,
        filterColumnId: columnBinderPath,
        filterValue: filter.value,
      };
      this.logger.info(`[Filter] Filter(AddLine) on ${fpath}, column=${columnBinderPath}, value="${filter.value}"`);
      this.logger.info(`[Filter] repeater.controlPath=${currentResolved.repeater.controlPath}, formId=${currentResolved.form.formId}`);

      const addResult = await this.session.invoke(
        addLineInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );
      if (isErr(addResult)) return addResult;
      this.repo.applyToPage(pageContextId, addResult.value);
      this.filtered.add(pageContextId);
    }

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after filter'));
    this.logger.info(`[Filter] Filters applied on ${pageContextId}: ${filters.map(f => `${f.column}=${f.value}`).join(', ')}`);
    return ok(updatedCtx);
  }

  /** True when this session added a filter to the page context that clearFilters has not removed. */
  hasFilters(pageContextId: string): boolean {
    return this.filtered.has(pageContextId);
  }

  async clearFilters(pageContextId: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater -- cannot clear filters'));

    const formId = resolved.form.formId;
    const fpath = filterControlPath(resolved.form.root);

    // Reset alone does not clear a filter the session keeps (#57). BC stores every executed
    // filter per page for the session (FormFilterPersistencePattern.FilterExecuted ->
    // FormFilterStorage.SaveModified) and applies it to the page's UserFilter when the page
    // opens again, with no filter line; Reset (ApplySessionFilters(applyOriginal)) restores
    // the stored "original", which then holds it too (live cronus291, page 143: a filter
    // active at close_page survived reopen + Reset). So, with a filter control:
    //   1. Reset: removes the filter lines (ChildRemoved per line).
    //   2. Execute on the LogicalForm with UserFilter '': BindingManager.UserFilter.Clear()
    //      + refill (FilterInteraction.ExecuteFilter), clears the stored filter from the view.
    //   3. Execute on the filter control: raises FilterExecuted, so the session stores the
    //      now-empty filters and the page opens unfiltered next time.
    // Page-defined filters (SourceTableView, AL SetFilter) are not in UserFilter and stay.
    const steps: FilterInteraction[] = fpath
      ? [
          { type: 'Filter', formId, controlPath: fpath, filterOperation: FilterOperation.Reset },
          { type: 'Filter', formId, controlPath: 'server:', filterOperation: FilterOperation.Execute, userFilter: '' },
          { type: 'Filter', formId, controlPath: fpath, filterOperation: FilterOperation.Execute, filterColumnId: '', filterValue: '' },
        ]
      : [{ type: 'Filter', formId, controlPath: resolved.repeater.controlPath, filterOperation: FilterOperation.Reset }];
    for (const step of steps) {
      const result = await this.session.invoke(
        step,
        (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
      );
      if (isErr(result)) return result;
      this.repo.applyToPage(pageContextId, result.value);
    }
    this.filtered.delete(pageContextId);

    const updatedCtx = this.repo.get(pageContextId);
    if (!updatedCtx) return err(new ProtocolError('State lost after clear'));
    this.logger.info(`[Filter] Filters cleared on ${pageContextId}`);
    return ok(updatedCtx);
  }
}
