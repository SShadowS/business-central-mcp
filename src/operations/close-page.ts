import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';

export interface ClosePageInput {
  pageContextId: string;
}

export class ClosePageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: ClosePageInput): Promise<Result<{ success: boolean }, ProtocolError>> {
    const result = await this.pageService.closePage(input.pageContextId);
    return mapResult(result, () => ({ success: true }));
  }
}
