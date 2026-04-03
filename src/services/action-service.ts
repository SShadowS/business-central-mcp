import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageState, BCEvent, InvokeActionInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';

export interface ActionResult {
  success: boolean;
  events: BCEvent[];
  dialog?: { formId: string; controlTree: unknown };
  updatedState?: PageState;
}

export class ActionService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async executeAction(pageContextId: string, actionName: string): Promise<Result<ActionResult, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    // Find action by caption (case-insensitive)
    const action = state.actions.find(a =>
      a.caption.toLowerCase() === actionName.toLowerCase()
    );
    if (!action) {
      return err(new ProtocolError(`Action not found: ${actionName}`, {
        availableActions: state.actions.filter(a => a.visible && a.enabled).map(a => a.caption).filter(Boolean),
      }));
    }

    if (!action.enabled) {
      return err(new ProtocolError(`Action is disabled: ${actionName}`));
    }

    return this.invokeAction(pageContextId, state, action.controlPath, action.systemAction);
  }

  async executeSystemAction(pageContextId: string, systemAction: number): Promise<Result<ActionResult, ProtocolError>> {
    const state = this.repo.get(pageContextId);
    if (!state) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    // Find action by systemAction number
    const action = state.actions.find(a => a.systemAction === systemAction);
    const controlPath = action?.controlPath ?? 'server:c[0]';

    return this.invokeAction(pageContextId, state, controlPath, systemAction);
  }

  private async invokeAction(
    pageContextId: string,
    state: PageState,
    controlPath: string,
    systemAction: number,
  ): Promise<Result<ActionResult, ProtocolError>> {
    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: state.formId,
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
