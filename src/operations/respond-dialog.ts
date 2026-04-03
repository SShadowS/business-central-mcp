import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';

export interface RespondDialogInput {
  pageContextId: string;
  dialogFormId: string;
  response: 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'close';
}

export interface RespondDialogOutput {
  success: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  openedPages: Array<{ pageContextId: string; caption: string }>;
}

const RESPONSE_MAP: Record<string, number> = {
  ok: SystemAction.Ok,
  cancel: SystemAction.Cancel,
  yes: SystemAction.Yes,
  no: SystemAction.No,
  abort: SystemAction.Abort,
};

export class RespondDialogOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: RespondDialogInput): Promise<Result<RespondDialogOutput, ProtocolError>> {
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    // "close" uses CloseForm instead of InvokeAction
    if (input.response === 'close') {
      const closeResult = await this.session.invoke(
        { type: 'CloseForm' as const, formId: input.dialogFormId },
        (event) => event.type === 'InvokeCompleted',
      );
      if (!isOk(closeResult)) return closeResult;

      const updatedCtx = this.repo.get(input.pageContextId);
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const newDialogs = detectDialogs(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
      });
    }

    const systemAction = RESPONSE_MAP[input.response];
    if (systemAction === undefined) {
      return err(new ProtocolError(`Invalid dialog response: ${input.response}. Use: ok, cancel, yes, no, abort, close`));
    }

    const result = await this.session.invoke(
      {
        type: 'InvokeAction' as const,
        formId: input.dialogFormId,
        controlPath: 'server:c[0]',
        systemAction,
      },
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated' || event.type === 'DialogOpened',
    );

    if (!isOk(result)) return result;

    const events = result.value;
    this.repo.applyToPage(input.pageContextId, events);

    const updatedCtx = this.repo.get(input.pageContextId);
    const changedSections = updatedCtx ? detectChangedSections(updatedCtx, events) : [];
    const newDialogs = detectDialogs(events);

    // Check for new pages opened (e.g., posting creates a Posted Invoice)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId !== ctx.rootFormId) {
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== input.pageContextId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    return ok({
      success: true,
      changedSections,
      dialogsOpened: newDialogs,
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
    });
  }
}
