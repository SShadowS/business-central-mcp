import { v4 as uuid } from 'uuid';
import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageState, SetCurrentRowInteraction, InvokeActionInteraction } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export class NavigationService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  /** Select a row by bookmark (positions cursor without opening) */
  async selectRow(pageContextId: string, bookmark: string): Promise<Result<PageState, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    if (!state.repeater) return err(new ProtocolError('Page has no repeater'));

    const interaction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow',
      formId: state.formId,
      controlPath: state.repeater.controlPath,
      key: bookmark,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );

    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);
    return ok(this.repo.get(pageContextId)!);
  }

  /** Drill down: select row + InvokeAction(Edit=40). Returns the new page's state. */
  async drillDown(
    pageContextId: string,
    bookmark: string,
  ): Promise<Result<{ sourcePageContextId: string; targetPageState: PageState }, ProtocolError>> {
    // Step 1: Select the row
    const selectResult = await this.selectRow(pageContextId, bookmark);
    if (isErr(selectResult)) return selectResult;

    const state = this.repo.get(pageContextId);
    if (!state || !state.repeater) return err(new ProtocolError('State lost after select'));

    // Step 2: InvokeAction with SystemAction.Edit (40) — opens the card page
    const editInteraction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: state.formId,
      controlPath: state.repeater.controlPath,
      systemAction: SystemAction.Edit,
    };

    const editResult = await this.session.invoke(
      editInteraction,
      (event) => event.type === 'FormCreated' || event.type === 'InvokeCompleted',
    );

    if (isErr(editResult)) return editResult;

    const events = editResult.value;
    // The new page appears as a FormCreated event for a different form than the source
    const formCreated = events.find(e => e.type === 'FormCreated' && e.formId !== state.formId);

    if (!formCreated || formCreated.type !== 'FormCreated') {
      return err(new ProtocolError('No new form opened after drill-down'));
    }

    // Create a new page context for the target
    const targetPageContextId = `session:page:drilldown:${uuid().substring(0, 8)}`;
    this.repo.create(targetPageContextId, formCreated.formId);
    this.repo.applyToPage(targetPageContextId, events);

    // Also apply events to source page (its openFormIds need updating)
    this.repo.applyToPage(pageContextId, events);

    const targetState = this.repo.get(targetPageContextId);
    if (!targetState) return err(new ProtocolError('Failed to create target page context'));

    this.logger.info(`Drilled down from ${pageContextId} to ${targetPageContextId}`);
    return ok({ sourcePageContextId: pageContextId, targetPageState: targetState });
  }
}
