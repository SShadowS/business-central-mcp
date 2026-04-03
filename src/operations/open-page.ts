import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';

export interface OpenPageInput {
  pageId: string;
  bookmark?: string;
  tenantId?: string;
}

export interface OpenPageOutput {
  pageContextId: string;
  pageType: string;
  caption: string;
  fields: Array<{ name: string; value?: string; editable: boolean; type: string }>;
  actions: Array<{ name: string; systemAction: number; enabled: boolean }>;
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
}

export class OpenPageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: OpenPageInput): Promise<Result<OpenPageOutput, ProtocolError>> {
    const result = await this.pageService.openPage(input.pageId, {
      bookmark: input.bookmark,
      tenantId: input.tenantId,
    });

    return mapResult(result, (state) => ({
      pageContextId: state.pageContextId,
      pageType: state.pageType,
      caption: state.formId,
      fields: state.controlTree
        .filter(f => f.visible && f.caption)
        .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable, type: f.type })),
      actions: state.actions
        .filter(a => a.visible && a.enabled && a.caption)
        .map(a => ({ name: a.caption, systemAction: a.systemAction, enabled: a.enabled })),
      rows: state.repeater?.rows.map(r => ({ bookmark: r.bookmark, cells: r.cells })),
    }));
  }
}
