import { isOk, ok, err, type Result } from '../core/result.js';
import type { BCError, ProtocolError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { detectChangedSections, detectDialogs, extractValidationErrors } from '../protocol/mutation-result.js';
import { classifyBusinessError } from '../protocol/error-classifier.js';
import type { ValidationResultItem } from '../protocol/types.js';

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
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  /**
   * De-duplicated field-level validation warnings from PropertyChanged events.
   * Non-empty when BC emits Severity "Warning" or "Info" ValidationResults —
   * the value WAS accepted but BC flagged it informational. Severity "Error"
   * items cause the operation to return an Err(BusinessValidationError) instead
   * of appearing here.
   */
  validationWarnings: ValidationResultItem[];
}

export class WriteDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, BCError | ProtocolError>> {
    const result = await this.dataService.writeFields(input.pageContextId, input.fields, {
      sectionId: input.section,
      rowIndex: input.rowIndex,
      bookmark: input.bookmark,
    });
    if (!isOk(result)) return result;

    const { results, events } = result.value;

    // Classify business errors before building the ok output.
    const bizErr = classifyBusinessError(events);
    if (bizErr !== null) return err(bizErr);

    const ctx = this.repo.get(input.pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, events) : [];
    const dialogsOpened = detectDialogs(events);
    const validationWarnings = extractValidationErrors(events).filter(v => v.Severity !== 'Error');

    return ok({
      results,
      allSucceeded: results.every(r => r.success),
      changedSections,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
      validationWarnings,
    });
  }
}
