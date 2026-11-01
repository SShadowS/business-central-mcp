import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError, InputValidationError, type BCError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { PageContext } from '../protocol/page-context.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs, collectMessages, type ShownMessage } from '../protocol/mutation-result.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import { formClosed } from '../protocol/replay-safety.js';
import type { Download, DownloadService } from '../services/download-service.js';
import type { BCEvent } from '../protocol/types.js';

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
  /** AL Message() texts raised after the answer (Error/Fatal ones become an error instead); empty when none. */
  messages: ShownMessage[];
  /** Captured file downloads produced by this response (e.g. Open in Excel); empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
  /** True when BC closed the dialog form: a re-run against that dialogFormId is rejected (FormNotFoundException). */
  replaySafe: boolean;
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
    private readonly downloadService: DownloadService,
  ) {}

  async execute(input: RespondDialogInput): Promise<Result<RespondDialogOutput, BCError>> {
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${input.pageContextId}`));

    // "close" uses CloseForm instead of InvokeAction
    if (input.response === 'close') {
      const closeResult = await this.session.invoke(
        { type: 'CloseForm' as const, formId: input.dialogFormId },
        (event) => event.type === 'InvokeCompleted',
      );
      if (!isOk(closeResult)) return closeResult;

      this.applyResponseEvents(ctx.rootFormId, input, closeResult.value);

      const closeBizErr = classifyBusinessError(closeResult.value);
      if (closeBizErr !== null) return err(closeBizErr);

      const updatedCtx = this.repo.get(this.reportPcId(ctx, input));
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const newDialogs = detectDialogs(closeResult.value);
      const closeCaptured = await this.downloadService.capture(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
        messages: collectMessages(closeResult.value),
        downloads: closeCaptured.downloads,
        externalUris: closeCaptured.externalUris,
        replaySafe: formClosed(closeResult.value, input.dialogFormId),
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
    this.applyResponseEvents(ctx.rootFormId, input, events);

    const bizErr = classifyBusinessError(events);
    if (bizErr !== null) return err(bizErr);

    // BC runs Abort only on a dialog that has an Abort action (InvokeActionInteraction: session,
    // context or form action); confirms, messages and request pages have none (LogicalDialog.AddActions),
    // so BC answers InvokeCompleted and the dialog stays open (live cronus29, report 6 request page).
    // The dialog's tree cannot decide this up front: context actions such as a request page's OK are
    // not serialized as controls. Nothing ran, so this is a definite failure (#38).
    if (systemAction === SystemAction.Abort && !formClosed(events, input.dialogFormId)
      && !events.some(e => e.type === 'DialogOpened' || e.type === 'FormCreated')) {
      return err(new InputValidationError([{ path: 'response', message: `BC ignored 'abort': dialog ${input.dialogFormId} has no Abort action and is still open. Answer it with ok, cancel, yes, no or close.` }]));
    }

    const reportPcId = this.reportPcId(ctx, input);
    const updatedCtx = this.repo.get(reportPcId);
    const changedSections = updatedCtx ? detectChangedSections(updatedCtx, events) : [];
    const newDialogs = detectDialogs(events);

    // Check for new pages opened (e.g., posting creates a Posted Invoice)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId !== ctx.rootFormId) {
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== input.pageContextId && newCtx.pageContextId !== reportPcId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    const captured = await this.downloadService.capture(events);
    return ok({
      success: true,
      changedSections,
      dialogsOpened: newDialogs,
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
      messages: collectMessages(events),
      downloads: captured.downloads,
      externalUris: captured.externalUris,
      replaySafe: formClosed(events, input.dialogFormId),
    });
  }

  /**
   * The dialog's own page context (dialogsOpened[].pageContextId) holds only the dialog,
   * so applying BC's answer to it alone would drop the changes to the page that opened the
   * dialog. Route by form id then; a host page context keeps the page-scoped apply.
   */
  private applyResponseEvents(rootFormId: string, input: RespondDialogInput, events: BCEvent[]): void {
    if (rootFormId === input.dialogFormId) this.repo.applyEvents(events);
    else this.repo.applyToPage(input.pageContextId, events);
  }

  /**
   * The page to report changedSections/openedPages on. Answered through its own context,
   * the dialog is gone afterwards: report on the page that opened it.
   */
  private reportPcId(ctx: PageContext, input: RespondDialogInput): string {
    return ctx.rootFormId === input.dialogFormId && ctx.ownerPageContextId ? ctx.ownerPageContextId : input.pageContextId;
  }
}
