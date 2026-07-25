import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError, type BCError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { Download, DownloadService } from '../services/download-service.js';

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
  /** Captured file downloads produced by this response (e.g. Open in Excel); empty when none. */
  downloads: Download[];
  /** Links BC would open externally (not fetched by the server); empty when none. */
  externalUris: Array<{ uri: string; style: string }>;
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

      this.repo.applyToPage(input.pageContextId, closeResult.value);

      const closeBizErr = classifyBusinessError(closeResult.value);
      if (closeBizErr !== null) return err(closeBizErr);

      const updatedCtx = this.repo.get(input.pageContextId);
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const newDialogs = detectDialogs(closeResult.value);
      const closeCaptured = await this.downloadService.capture(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
        downloads: closeCaptured.downloads,
        externalUris: closeCaptured.externalUris,
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

    const bizErr = classifyBusinessError(events);
    if (bizErr !== null) return err(bizErr);

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

    const captured = await this.downloadService.capture(events);
    return ok({
      success: true,
      changedSections,
      dialogsOpened: newDialogs,
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
      downloads: captured.downloads,
      externalUris: captured.externalUris,
    });
  }
}
