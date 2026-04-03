import { isOk, isErr, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService } from '../services/data-service.js';
import type { FilterService } from '../services/filter-service.js';

export interface ReadDataInput {
  pageContextId: string;
  section?: string;
  filters?: Array<{ column: string; value: string }>;
  columns?: string[];
}

export interface ReadDataOutput {
  rows: Array<{ bookmark: string; cells: Record<string, unknown> }>;
  totalCount: number;
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

    return ok({ rows, totalCount: rows.length });
  }
}
