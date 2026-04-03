import { isErr, mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';
import { resolveSection } from '../protocol/section-resolver.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select' | 'lookup';
  section?: string;
  field?: string;
}

export interface NavigateOutput {
  targetPageContextId?: string;
  pageType?: string;
  sections?: Array<{ sectionId: string; kind: string; caption: string }>;
  fields?: Array<{ name: string; value?: string; editable: boolean }>;
  rows?: Array<{ bookmark: string; cells: Record<string, unknown> }>;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark, input.section);
      return mapResult(result, (r) => {
        const resolved = resolveSection(r.targetPageContext, 'header');
        const form = 'error' in resolved ? undefined : resolved.form;

        // Collect section descriptors from the target page
        const sections = Array.from(r.targetPageContext.sections.entries()).map(([sectionId, s]) => ({
          sectionId,
          kind: s.kind,
          caption: s.caption,
        }));

        return {
          targetPageContextId: r.targetPageContext.pageContextId,
          pageType: r.targetPageContext.pageType,
          sections,
          fields: (form?.controlTree ?? [])
            .filter(f => f.visible && f.caption)
            .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable })),
          changedSections: [],
          dialogsOpened: [],
          requiresDialogResponse: false,
        };
      });
    }

    // Default: select row
    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark, input.section);
    if (isErr(result)) return result;
    return mapResult(result, (ctx) => {
      const resolved = resolveSection(ctx);
      const repeater = 'error' in resolved ? null : resolved.repeater;
      return {
        rows: repeater?.rows.map(r => ({ bookmark: r.bookmark, cells: r.cells })),
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      };
    });
  }
}
