import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface ClosePageInput {
  pageContextId: string;
}

export interface ClosePageOutput {
  success: boolean;
  dialogsOpened: Array<{ formId: string; message?: string }>;
  requiresDialogResponse: boolean;
}

export class ClosePageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: ClosePageInput): Promise<Result<ClosePageOutput, ProtocolError>> {
    const result = await this.pageService.closePage(input.pageContextId);
    return mapResult(result, (r) => {
      const dialogsOpened = detectDialogs(r.events);
      return {
        success: true,
        dialogsOpened,
        requiresDialogResponse: dialogsOpened.length > 0,
      };
    });
  }
}
