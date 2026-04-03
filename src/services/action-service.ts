import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import type { BCEvent, InvokeActionInteraction } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import type { FormState } from '../protocol/form-state.js';
import type { Logger } from '../core/logger.js';

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

export class ActionService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async executeAction(pageContextId: string, actionName: string, sectionId?: string): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    // Resolve the section to find actions in that form
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;

    // Check if the action name is a well-known system action (New, Delete, Refresh, etc.)
    const systemActionByName = SYSTEM_ACTION_NAMES.get(actionName.toLowerCase());
    if (systemActionByName !== undefined) {
      return this.executeSystemAction(pageContextId, systemActionByName, sectionId);
    }

    // Find action by caption (case-insensitive)
    const action = form.actions.find(a =>
      a.caption.toLowerCase() === actionName.toLowerCase()
    );
    if (!action) {
      // Check other sections for the action to provide instructional error
      const lower = actionName.toLowerCase();
      for (const [otherId, otherSection] of ctx.sections) {
        if (otherId === (sectionId ?? 'header')) continue;
        const otherForm = ctx.forms.get(otherSection.formId);
        if (otherForm?.actions.some(a => a.caption.toLowerCase() === lower)) {
          return err(new ProtocolError(
            `Action '${actionName}' not found in section '${sectionId ?? 'header'}'. It exists in section '${otherId}'. Use section: '${otherId}' to target it.`,
            { availableSections: Array.from(ctx.sections.keys()) },
          ));
        }
      }
      return err(new ProtocolError(`Action not found: ${actionName}`, {
        availableActions: form.actions.filter(a => a.visible && a.enabled).map(a => a.caption).filter(Boolean),
      }));
    }

    if (!action.enabled) {
      return err(new ProtocolError(`Action is disabled: ${actionName}`));
    }

    return this.invokeAction(pageContextId, form, action.controlPath, action.systemAction);
  }

  async executeSystemAction(pageContextId: string, systemAction: number, sectionId?: string): Promise<Result<ActionResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form, repeater } = resolved;

    // For row-targeting actions on pages with a repeater, use the repeater's controlPath
    let controlPath: string;
    if (repeater && ROW_TARGETING_ACTIONS.has(systemAction)) {
      controlPath = repeater.controlPath + '/cr/c[0]';
    } else {
      const action = form.actions.find(a => a.systemAction === systemAction);
      controlPath = action?.controlPath ?? 'server:c[0]';
    }

    return this.invokeAction(pageContextId, form, controlPath, systemAction);
  }

  private async invokeAction(
    pageContextId: string,
    form: FormState,
    controlPath: string,
    systemAction: number,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: form.formId,
      controlPath,
      systemAction,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    if (isErr(result)) return result;

    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

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
