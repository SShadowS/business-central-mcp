import { v4 as uuid } from 'uuid';
import { ok, err, isErr, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { SetCurrentRowInteraction, InvokeActionInteraction, LoadFormInteraction } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import type { Logger } from '../core/logger.js';

export class NavigationService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  /** Select a row by bookmark (positions cursor without opening) */
  async selectRow(pageContextId: string, bookmark: string, sectionId?: string): Promise<Result<PageContext, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater'));

    const interaction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow',
      formId: resolved.form.formId,
      controlPath: resolved.repeater.controlPath,
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

  /** Drill down: select row + InvokeAction(Edit=40). Returns the new page's context. */
  async drillDown(
    pageContextId: string,
    bookmark: string,
    sectionId?: string,
  ): Promise<Result<{ sourcePageContextId: string; targetPageContext: PageContext }, ProtocolError>> {
    // Step 1: Select the row
    const selectResult = await this.selectRow(pageContextId, bookmark, sectionId);
    if (isErr(selectResult)) return selectResult;

    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError('State lost after select'));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return err(new ProtocolError('Page has no repeater'));

    // Step 2: InvokeAction with SystemAction.Edit (40) -- opens the card page
    // controlPath must point to a cell in the current repeater row via the 'cr' segment,
    // NOT to an action button. BC's GetContextActionToExecute calls DefaultAction on the
    // resolved control, which traverses up to the template row's Edit action.
    // Using action button paths is fragile -- they shift when BC rearranges actions after
    // row selection, causing ArgumentOutOfRangeException.
    // Verified from decompiled: RepeaterControl.ResolvePathName("cr") -> CurrentRowViewport
    const editControlPath = resolved.repeater.controlPath + '/cr/c[0]';

    const editInteraction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: resolved.form.formId,
      controlPath: editControlPath,
      systemAction: SystemAction.Edit,
    };

    const editResult = await this.session.invoke(
      editInteraction,
      (event) => event.type === 'FormCreated' || event.type === 'InvokeCompleted',
    );

    if (isErr(editResult)) return editResult;

    const events = editResult.value;
    // The new page appears as a FormCreated event for a different form than the source
    const formCreated = events.find(e => e.type === 'FormCreated' && e.formId !== resolved.form.formId);

    if (!formCreated || formCreated.type !== 'FormCreated') {
      return err(new ProtocolError('No new form opened after drill-down'));
    }

    // Create a new page context for the target
    const targetPageContextId = `session:page:drilldown:${uuid().substring(0, 8)}`;
    this.repo.create(targetPageContextId, formCreated.formId);
    this.repo.applyToPage(targetPageContextId, events);

    // Also apply events to source page (its ownedFormIds need updating)
    this.repo.applyToPage(pageContextId, events);

    // Load data for the drilled-down card page
    // Without this, field values are empty (verified from decompiled EditLogicalControl.ObjectValue)
    const loadInteraction: LoadFormInteraction = {
      type: 'LoadForm',
      formId: formCreated.formId,
      loadData: true,
      delayed: false,
    };

    const loadResult = await this.session.invoke(
      loadInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isOk(loadResult)) {
      this.repo.applyToPage(targetPageContextId, loadResult.value);
    }

    const targetCtx = this.repo.get(targetPageContextId);
    if (!targetCtx) return err(new ProtocolError('Failed to create target page context'));

    this.logger.info(`Drilled down from ${pageContextId} to ${targetPageContextId}`);
    return ok({ sourcePageContextId: pageContextId, targetPageContext: targetCtx });
  }
}
