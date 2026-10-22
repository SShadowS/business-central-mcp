import { isOk, isErr, ok, err, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { FilterService } from '../services/filter-service.js';
import type { SortService } from '../services/sort-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { buildSection, type Section } from '../protocol/section-dto.js';
import { resolveKeyBy } from '../protocol/row-mapping.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  tab?: string;
  clearFilters?: boolean;
  filters?: Array<{ column: string; value: string }>;
  sort?: { column: string; direction: 'asc' | 'desc' };
  columns?: string[];
  range?: { offset: number; limit: number };
  /**
   * Key rows/fields by 'caption' (default) or by the stable AL 'designName'.
   * Omitted or blank = current caption behaviour.
   */
  keyBy?: 'caption' | 'designName' | '';
  /** When true, list sections also return columns[] metadata. */
  includeColumnMetadata?: boolean;
}

export interface ReadDataOutput {
  section: Section;
  /**
   * Generation token for the page's current state at the time of this read.
   * Increments each time an event batch mutates the page. Pass as
   * `expectedStateVersion` to bc_write_data / bc_execute_action to detect
   * and reject stale-state writes.
   */
  stateVersion: number;
}

export class ReadDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly filterService: FilterService,
    private readonly sortService: SortService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ReadDataInput): Promise<Result<ReadDataOutput, ProtocolError>> {
    const sectionId = input.section ?? 'header';
    const keyBy = resolveKeyBy(input.keyBy);
    const byDesign = keyBy === 'designName';

    // Fast-fail for unknown pageContextId before any service calls.
    if (!this.repo.get(input.pageContextId)) {
      return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));
    }

    if (input.clearFilters) {
      const clearResult = await this.filterService.clearFilters(input.pageContextId, input.section);
      if (isErr(clearResult)) return clearResult;
    }

    if (input.filters && input.filters.length > 0) {
      const filterResult = await this.filterService.applyFilters(input.pageContextId, input.filters, input.section, ...(byDesign ? [keyBy] as const : []));
      if (isErr(filterResult)) return filterResult;
    }

    // Sort is applied after clearFilters+filters and before scroll-range
    // materialization. A sort resets the BC viewport to the top of the sorted
    // result, so any prior scroll offset is discarded (which is correct: the
    // caller's range is applied to the freshly sorted result set).
    if (input.sort) {
      const sortResult = await this.sortService.applySort(input.pageContextId, input.sort.column, input.sort.direction, input.section, ...(byDesign ? [keyBy] as const : []));
      if (isErr(sortResult)) return sortResult;
    }

    // For repeater-bearing sections, materialize rows up to the requested range
    // so the resulting Section.rows reflects the slice the caller asked for.
    if (input.range) {
      const totalRowCount = this.dataService.getRepeaterTotalRowCount(input.pageContextId, input.section);
      const needed = input.range.offset + input.range.limit;
      // readRows err is benign here -- buildSection below produces a clearer
      // "Section '<id>' not found" diagnostic for the same root causes.
      const loaded = this.dataService.readRows(input.pageContextId, input.section);
      if (isOk(loaded)) {
        let rowsLen = loaded.value.length;
        while (rowsLen < needed && rowsLen < (totalRowCount ?? Infinity)) {
          const scrollResult = await this.dataService.scrollRepeater(input.pageContextId, 1, input.section);
          if (!isOk(scrollResult)) break;
          if (scrollResult.value.length <= rowsLen) break;
          rowsLen = scrollResult.value.length;
        }
      }
    }

    // Re-fetch the context AFTER applyFilters / scrollRepeater. The repo
    // replaces the PageContext entry on every event-induced update (immutable
    // updates with structural sharing), so a context captured before those
    // calls is stale and would cause buildSection to project pre-filter /
    // pre-scroll state.
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    // Column metadata is always built in designName mode (needed to match
    // `columns` by caption as well as by key) and stripped below unless requested.
    const builtSection = buildSection(ctx, sectionId, {
      keyBy,
      includeColumnMetadata: input.includeColumnMetadata === true || byDesign,
    });
    const columnMeta = builtSection?.columns;
    const section = builtSection && builtSection.columns && input.includeColumnMetadata !== true
      ? (({ columns: _omit, ...rest }) => rest)(builtSection)
      : builtSection;
    if (!section) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }

    let materialized: Section = section;

    if (input.tab && materialized.fields) {
      const tabsResult = this.dataService.getTabs(input.pageContextId, input.section);
      if (isOk(tabsResult) && tabsResult.value) {
        const matchingTab = tabsResult.value.find(t => t.caption.toLowerCase() === input.tab!.toLowerCase());
        if (!matchingTab) {
          return err(new ProtocolError(`Tab '${input.tab}' not found.`, {
            availableTabs: tabsResult.value.map(t => t.caption),
          }));
        }
        const tabFieldCaptions = new Set(matchingTab.fields.map(f => f.caption.toLowerCase()));
        materialized = {
          ...materialized,
          fields: materialized.fields.filter(f => tabFieldCaptions.has((f.caption ?? f.name).toLowerCase())),
        };
      }
    }

    if (input.columns && input.columns.length > 0) {
      const wanted = new Set(input.columns.map(c => c.toLowerCase()));
      if (byDesign && columnMeta) {
        // Also accept captions / DesignNames: translate them to the row key.
        for (const m of columnMeta) {
          if (wanted.has(m.caption.toLowerCase()) || (m.designName && wanted.has(m.designName.toLowerCase()))) {
            wanted.add(m.key.toLowerCase());
          }
        }
      }
      if (materialized.rows) {
        materialized = {
          ...materialized,
          rows: materialized.rows.map(r => ({
            bookmark: r.bookmark,
            cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => wanted.has(k.toLowerCase()))),
          })),
        };
      }
      if (materialized.fields) {
        materialized = {
          ...materialized,
          fields: materialized.fields.filter(f => wanted.has(f.name.toLowerCase())
            || (byDesign && f.caption !== undefined && wanted.has(f.caption.toLowerCase()))),
        };
      }
    }

    if (input.range && materialized.rows) {
      materialized = {
        ...materialized,
        rows: materialized.rows.slice(input.range.offset, input.range.offset + input.range.limit),
      };
    }

    return ok({ section: materialized, stateVersion: ctx.generation });
  }
}
