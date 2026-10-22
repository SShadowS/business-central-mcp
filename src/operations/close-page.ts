import { err, mapResult, type Result } from '../core/result.js';
import { InputValidationError, type BCError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface ClosePageInput {
  pageContextId: string;
}

export interface ClosePageOutput {
  success: boolean;
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  /**
   * True when no dialog blocked the close: CloseForm on an already-closed form
   * is a server-side no-op (verified live, cronus29). False while a
   * save/discard dialog is pending.
   */
  replaySafe: boolean;
}

export class ClosePageOperation {
  constructor(
    private readonly pageService: PageService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ClosePageInput): Promise<Result<ClosePageOutput, BCError>> {
    // A dialog bc_execute_action opened is answered, not closed: CloseForm on a modal sets an
    // unset DialogResult from its exit actions, which can be OK (decompiled
    // NavFormCloseHandler.ExecuteCloseCore / FindExitActionFormResult).
    const ctx = this.repo.get(input.pageContextId);
    if (ctx?.ownerPageContextId) {
      return err(new InputValidationError([{
        path: 'pageContextId',
        message: `${input.pageContextId} is a dialog, not a page: answer it with bc_respond_dialog (dialogFormId ${ctx.rootFormId}, e.g. response "cancel").`,
      }]));
    }

    const result = await this.pageService.closePage(input.pageContextId);
    return mapResult(result, (r) => {
      const dialogsOpened = detectDialogs(r.events);
      return {
        success: true,
        dialogsOpened,
        requiresDialogResponse: dialogsOpened.length > 0,
        replaySafe: dialogsOpened.length === 0,
      };
    });
  }
}
