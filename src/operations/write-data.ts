import { isOk, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';

export interface WriteDataInput {
  pageContextId: string;
  fields: Record<string, string>;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
}

export interface WriteDataOutput {
  results: FieldWriteResult[];
  allSucceeded: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string }>;
  requiresDialogResponse: boolean;
}

export class WriteDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, ProtocolError>> {
    const result = await this.dataService.writeFields(input.pageContextId, input.fields, {
      sectionId: input.section,
      rowIndex: input.rowIndex,
      bookmark: input.bookmark,
    });
    if (!isOk(result)) return result;

    const { results, events } = result.value;
    const ctx = this.repo.get(input.pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, events) : [];
    const dialogsOpened = detectDialogs(events);

    return ok({
      results,
      allSucceeded: results.every(r => r.success),
      changedSections,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    });
  }
}
