import { isOk, isErr, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { FilterService } from '../services/filter-service.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  tab?: string;
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
  range?: { offset: number; limit: number };
}

export interface ReadDataOutput {
  rows: Array<{ bookmark: string; cells: Record<string, unknown> }>;
  totalCount: number;
  totalRowCount?: number;
}

export class ReadDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly filterService: FilterService,
  ) {}

  async execute(input: ReadDataInput): Promise<Result<ReadDataOutput, ProtocolError>> {
    // Apply filters if provided
    if (input.filters && input.filters.length > 0) {
      const filterResult = await this.filterService.applyFilters(input.pageContextId, input.filters, input.section);
      if (isErr(filterResult)) return filterResult;
    }

    // Read rows (synchronous)
    const rowsResult = this.dataService.readRows(input.pageContextId, input.section);
    if (!isOk(rowsResult)) return rowsResult;

    let rows = rowsResult.value.map(r => ({ bookmark: r.bookmark, cells: r.cells }));

    // Tab filtering: when tab is specified, only include fields belonging to that tab group
    if (input.tab) {
      const tabsResult = this.dataService.getTabs(input.pageContextId, input.section);
      if (isOk(tabsResult) && tabsResult.value) {
        const tabLower = input.tab.toLowerCase();
        const matchingTab = tabsResult.value.find(t => t.caption.toLowerCase() === tabLower);
        if (matchingTab) {
          const tabFieldCaptions = new Set(matchingTab.fields.map(f => f.caption.toLowerCase()));
          rows = rows.map(r => ({
            bookmark: r.bookmark,
            cells: Object.fromEntries(
              Object.entries(r.cells).filter(([k]) => tabFieldCaptions.has(k.toLowerCase()))
            ),
          }));
        }
      }
    }

    // Column selection
    if (input.columns && input.columns.length > 0) {
      const colSet = new Set(input.columns.map(c => c.toLowerCase()));
      rows = rows.map(r => ({
        bookmark: r.bookmark,
        cells: Object.fromEntries(
          Object.entries(r.cells).filter(([k]) => colSet.has(k.toLowerCase()))
        ),
      }));
    }

    // Total row count from repeater state (before slicing)
    const totalRowCount = this.dataService.getRepeaterTotalRowCount(input.pageContextId, input.section);
    const totalCount = rows.length;

    // Range slicing (paging MVP)
    if (input.range) {
      rows = rows.slice(input.range.offset, input.range.offset + input.range.limit);
    }

    return ok({
      rows,
      totalCount,
      ...(totalRowCount !== null ? { totalRowCount } : {}),
    });
  }
}
