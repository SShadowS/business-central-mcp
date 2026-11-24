import { err, isErr, mapResult, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { NavigationService } from '../services/navigation-service.js';
import { buildAllSections, type Section } from '../protocol/section-dto.js';
import type { OpenedDialog } from '../protocol/mutation-result.js';

export interface NavigateInput {
  pageContextId: string;
  bookmark: string;
  action?: 'drill_down' | 'select';
  section?: string;
}

export interface NavigateOutput {
  /** Set when action='drill_down' lands on a new page. */
  targetPageContextId?: string;
  pageType?: string;
  /** Sections of the target page (drill_down). */
  sections?: Section[];
  /** select: the row that is now current. */
  selectedBookmark?: string;
  changedSections: string[];
  dialogsOpened: OpenedDialog[];
  requiresDialogResponse: boolean;
}

export class NavigateOperation {
  constructor(private readonly navigationService: NavigationService) {}

  async execute(input: NavigateInput): Promise<Result<NavigateOutput, ProtocolError>> {
    // The schema no longer advertises 'lookup'/'field', but the REST path casts
    // raw bodies without validation — reject the removed surface explicitly
    // rather than silently falling through to a plain row select.
    if ((input.action as string) === 'lookup') {
      return err(new ProtocolError('navigate action "lookup" is not supported. Use the bc_lookup tool to enumerate lookup candidates for a field.'));
    }

    if (input.action === 'drill_down') {
      const result = await this.navigationService.drillDown(input.pageContextId, input.bookmark, input.section);
      return mapResult(result, (r) => ({
        targetPageContextId: r.targetPageContext.pageContextId,
        pageType: r.targetPageContext.pageType,
        sections: buildAllSections(r.targetPageContext),
        changedSections: [],
        dialogsOpened: [],
        requiresDialogResponse: false,
      }));
    }

    // Select only moves the cursor: say which row is current, not the whole section again
    // (re-read with bc_read_data when the row's data is needed).
    const result = await this.navigationService.selectRow(input.pageContextId, input.bookmark, input.section);
    if (isErr(result)) return result;
    return mapResult(result, () => ({
      selectedBookmark: input.bookmark,
      changedSections: [],
      dialogsOpened: [],
      requiresDialogResponse: false,
    }));
  }
}
