import { isErr, mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select';
}

export interface NavigateOutput {
  targetPageContextId?: string;
  pageType?: string;
  fields?: Array<{ name: string; value?: string; editable: boolean }>;
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark);
      return mapResult(result, (r) => ({
        targetPageContextId: r.targetPageState.pageContextId,
        pageType: r.targetPageState.pageType,
        fields: r.targetPageState.controlTree
          .filter(f => f.visible && f.caption)
          .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable })),
      }));
    }

    // Default: select row
    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark);
    if (isErr(result)) return result;
    return mapResult(result, (state) => ({
      rows: state.repeater?.rows.map(r => ({ bookmark: r.bookmark, cells: r.cells })),
    }));
  }
}
