import { v4 as uuid } from 'uuid';
import { ok, err, isOk, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { BCEvent, InvokeActionInteraction, SetCurrentRowInteraction } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import type { FormState } from '../protocol/form-state.js';
import type { RepeaterNode } from '../protocol/form-node.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { actions as treeActions, groupVisibility as treeGroupVisibility, cues as treeCues } from '../protocol/form-views.js';
import { classifyWizardNav } from '../protocol/wizard-classify.js';
import type { Logger } from '../core/logger.js';
import { ChildFormHydrationStrategy } from './strategies/child-form-hydration.js';

/** System actions that target a specific row via the repeater control. */
const ROW_TARGETING_ACTIONS: Set<number> = new Set([
  SystemAction.Delete, SystemAction.Edit, SystemAction.View,
  SystemAction.DrillDown, SystemAction.New,
]);

/** Map well-known action names to their system action codes. */
const SYSTEM_ACTION_NAMES: Map<string, number> = new Map([
  ['new', SystemAction.New],
  ['delete', SystemAction.Delete],
  ['refresh', SystemAction.Refresh],
  ['edit', SystemAction.Edit],
  ['view', SystemAction.View],
]);

export interface ActionResult {
  success: boolean;
  events: BCEvent[];
  dialog?: { formId: string; controlTree: unknown };
  updatedState?: PageContext;
}

/**
 * Multi-row selection to apply atomically with an action. `controlPath` is the
 * repeater's controlPath (the target of SetCurrentRow); `bookmarks[0]` is the
 * anchor and MUST be a member of `bookmarks` (BC's row-targeting actions read
 * the current row from the same selection set).
 */
export interface RowSelection {
  readonly formId: string;
  readonly controlPath: string;
  readonly bookmarks: string[];
}

export class ActionService {
  private readonly childFormHydration: ChildFormHydrationStrategy;

  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {
    this.childFormHydration = new ChildFormHydrationStrategy(session, repo, logger);
  }

  async executeAction(
    pageContextId: string,
    actionName: string,
    sectionId?: string,
    selection?: RowSelection,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    // Resolve the section to find actions in that form
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form, repeater } = resolved;
    const allActions = treeActions(form.root);

    // Well-known SystemAction fast path
    const systemActionByName = SYSTEM_ACTION_NAMES.get(actionName.toLowerCase());
    if (systemActionByName !== undefined) {
      if (selection) {
        // A selection must reach invokeAction alongside the row-targeting
        // controlPath executeSystemAction would otherwise compute -- inline
        // the same resolution (shared via resolveActionControlPath) instead of
        // delegating, since executeSystemAction's own signature stays selection-free.
        const controlPath = this.resolveActionControlPath(form, repeater, systemActionByName);
        return this.invokeAction(pageContextId, form, controlPath, systemActionByName, 'action', selection);
      }
      return this.executeSystemAction(pageContextId, systemActionByName, sectionId);
    }

    const lower = actionName.toLowerCase();
    const actionNode = allActions.find(a => (a.properties.caption ?? '').toLowerCase() === lower);
    if (!actionNode) {
      // Provide the cross-section hint
      for (const [otherId, otherSection] of ctx.sections) {
        if (otherId === (sectionId ?? 'header')) continue;
        const otherForm = ctx.forms.get(otherSection.formId);
        if (otherForm && treeActions(otherForm.root).some(a => (a.properties.caption ?? '').toLowerCase() === lower)) {
          return err(new ProtocolError(
            `Action '${actionName}' not found in section '${sectionId ?? 'header'}'. It exists in section '${otherId}'. Use section: '${otherId}' to target it.`,
            { availableSections: Array.from(ctx.sections.keys()) },
          ));
        }
      }
      const groupVis = treeGroupVisibility(form.root);
      return err(new ProtocolError(`Action not found: ${actionName}`, {
        availableActions: allActions
          .filter(a => (a.properties.enabled ?? true) && isEffectivelyVisible(form.root, a.controlPath, groupVis, ctx.wizardState))
          .map(a => a.properties.caption ?? '')
          .filter(Boolean),
      }));
    }
    if (actionNode.properties.enabled === false) {
      return err(new ProtocolError(`Action is disabled: ${actionName}`));
    }
    return this.invokeAction(pageContextId, form, actionNode.controlPath, actionNode.systemAction, 'action', selection);
  }

  /** Edit/View/DrillDown/New act on the current row only -- they do NOT consume a multi-row selection (Delete does). */
  isCurrentRowOnlyAction(name: string): boolean {
    const sa = SYSTEM_ACTION_NAMES.get(name.toLowerCase());
    return sa === SystemAction.Edit || sa === SystemAction.View || sa === SystemAction.DrillDown || sa === SystemAction.New;
  }

  /**
   * Drill down on a cue tile (stackc) inside a Role Center / CardPart cuegroup
   * (stackgc). Sends `InvokeAction(DrillDown=120)` against the cue's
   * controlPath; BC opens the underlying list page as a `FormCreated` event.
   *
   * Reference: `RepeaterControl` / cue tile drill-down protocol — cues use
   * the same DrillDown SystemAction as repeater rows.
   */
  async executeOnCue(
    pageContextId: string,
    sectionId: string,
    cueName: string,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const section = ctx.sections.get(sectionId);
    if (!section || !section.valid) {
      return err(new ProtocolError(`Section '${sectionId}' not found.`, {
        availableSections: Array.from(ctx.sections.keys()),
      }));
    }

    const form = ctx.forms.get(section.formId);
    if (!form) return err(new ProtocolError(`Form for section '${sectionId}' not loaded.`));

    const want = cueName.toLowerCase();
    const cueList = treeCues(form.root);
    const cue = cueList.find((c) => c.caption.toLowerCase() === want);
    if (!cue) {
      return err(new ProtocolError(`Cue '${cueName}' not found in section '${sectionId}'.`, {
        availableCues: cueList.map((c) => c.caption),
      }));
    }
    if (!cue.hasAction) {
      return err(new ProtocolError(`Cue '${cueName}' is not drill-downable (HasAction=false).`));
    }

    // invokeAction registers any ownerless FormCreated the drill-down opens as
    // its own page context (prefix 'cue'), so the new list page is addressable.
    return this.invokeAction(pageContextId, form, cue.controlPath, SystemAction.DrillDown, 'cue');
  }

  /**
   * Drive a NavigatePage wizard by semantic step (`back` / `next` / `finish` / `cancel`).
   * The matching action's controlPath is resolved from the parser's `wizardNav` tag.
   *
   * Reference: `Microsoft.Dynamics.Framework.UI.NavigatePageActionControlHelper.cs`
   * — BC's own client classifies these by icon resource, not SystemAction.
   */
  async executeWizardNav(
    pageContextId: string,
    nav: 'back' | 'next' | 'finish' | 'cancel',
  ): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const root = ctx.forms.get(ctx.rootFormId);
    if (!root) return err(new ProtocolError(`Root form not found for page ${pageContextId}`));

    const allActions = treeActions(root.root);
    const actionNode = allActions.find(a => classifyWizardNav(a) === nav);
    if (!actionNode) {
      const available = allActions.map(a => classifyWizardNav(a)).filter(Boolean);
      return err(new ProtocolError(
        `No wizard action of type '${nav}' on this page (page is ${ctx.pageType}, isModal=${ctx.isModal})`,
        { availableWizardNav: available },
      ));
    }
    if (actionNode.properties.enabled === false) {
      return err(new ProtocolError(`Wizard action '${nav}' is disabled at this step`));
    }

    const result = await this.invokeAction(pageContextId, root, actionNode.controlPath, actionNode.systemAction);

    // BC's web client owns the step variable client-side and emits no
    // PropertyChanged events when Next/Back fires. Mirror the step transition
    // ourselves so subsequent reads see the right step's fields. Only nudge on
    // forward/back; finish & cancel close the wizard server-side.
    if (isOk(result) && (nav === 'next' || nav === 'back')) {
      const ws = this.repo.get(pageContextId)?.wizardState;
      if (ws) {
        const delta = nav === 'next' ? 1 : -1;
        const target = ws.currentStepIndex + delta;
        if (target >= 0 && target < ws.stepPaths.length) {
          this.repo.advanceWizardStep(pageContextId, target);
          // Refresh updatedState so the caller sees post-bump visibility.
          const refreshed = this.repo.get(pageContextId);
          if (refreshed) {
            return ok({ ...result.value, updatedState: refreshed });
          }
        }
      }
    }

    return result;
  }

  async executeSystemAction(pageContextId: string, systemAction: number, sectionId?: string): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form, repeater } = resolved;
    const controlPath = this.resolveActionControlPath(form, repeater, systemAction);

    return this.invokeAction(pageContextId, form, controlPath, systemAction);
  }

  /**
   * Resolve the controlPath a SystemAction should target: row-targeting actions
   * (Delete/Edit/View/DrillDown/New) on a page with a repeater address the
   * current row (`cr/c[0]`); everything else resolves to its own action node.
   * Shared by `executeSystemAction` and the SYSTEM_ACTION_NAMES fast path in
   * `executeAction` (the latter needs it inline to also thread a selection).
   */
  private resolveActionControlPath(form: FormState, repeater: RepeaterNode | null, systemAction: number): string {
    if (repeater && ROW_TARGETING_ACTIONS.has(systemAction)) {
      return repeater.controlPath + '/cr/c[0]';
    }
    const action = treeActions(form.root).find(a => a.systemAction === systemAction);
    return action?.controlPath ?? 'server:c[0]';
  }

  private async invokeAction(
    pageContextId: string,
    form: FormState,
    controlPath: string,
    systemAction: number,
    openedPagePrefix = 'action',
    selection?: RowSelection,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: form.formId,
      controlPath,
      systemAction,
    };

    const expect = (event: BCEvent): boolean => event.type === 'InvokeCompleted';

    let result;
    if (selection) {
      const selectInteraction: SetCurrentRowInteraction = {
        type: 'SetCurrentRow',
        formId: selection.formId,
        controlPath: selection.controlPath,
        key: selection.bookmarks[0]!,
        rowsToSelect: selection.bookmarks,
      };
      result = await this.session.invokeSequence([selectInteraction, interaction], expect);
    } else {
      result = await this.session.invoke(interaction, expect);
    }

    if (isErr(result)) return result;

    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    // Register any newly-opened ownerless forms as their own page contexts.
    // Actions like "Dimensions" / "Ledger Entries" / "New" open a page as a
    // top-level FormCreated (no parentFormId). The event router deliberately
    // does NOT graft these onto the source page, so without an explicit
    // registration the new form would be unaddressable and unclosable.
    // Mirrors NavigationService.drillDown.
    for (const event of events) {
      if (event.type !== 'FormCreated') continue;
      if (event.parentFormId) continue;
      if (event.formId === form.formId) continue;
      if (this.repo.getByFormId(event.formId)) continue;
      const newPcId = `session:page:${openedPagePrefix}:${uuid().substring(0, 8)}`;
      this.repo.create(newPcId, event.formId);
      this.repo.applyToPage(newPcId, events);
      // Discover + load the opened page's child forms (lines subpage, FactBoxes)
      // so an action-opened document (e.g. a drilled ledger/document) exposes its
      // 'lines' section, matching bc_open_page. Without this it had 'header' only.
      await this.childFormHydration.hydrate(newPcId, events);
    }

    // Check for dialog
    const dialogEvent = events.find(e => e.type === 'DialogOpened');
    const dialog = dialogEvent?.type === 'DialogOpened'
      ? { formId: dialogEvent.formId, controlTree: dialogEvent.controlTree }
      : undefined;

    this.logger.info(`Action executed on ${pageContextId}: systemAction=${systemAction}, controlPath=${controlPath}`);

    return ok({
      success: true,
      events,
      dialog,
      updatedState: this.repo.get(pageContextId) ?? undefined,
    });
  }
}
