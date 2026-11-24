import { isOk, ok, err, type Result } from '../core/result.js';
import { StaleContextError, type BCError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { detectChangedSections, registerDialogs, extractValidationErrors, collectMessages, type ShownMessage, type OpenedDialog } from '../protocol/mutation-result.js';
import { classifyBusinessError, fieldMessages } from '../protocol/error-classifier.js';
import { writeDataReplaySafe } from '../protocol/replay-safety.js';

export interface WriteDataInput {
  pageContextId: string;
  fields: Record<string, string>;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * Opt-in staleness guard. When provided, the operation checks the page
   * context's current generation before sending anything to BC. If the
   * generation differs (the page was mutated by async events or a sibling
   * operation since the last read), the call is rejected immediately with a
   * STALE_CONTEXT error. Obtain the value from `stateVersion` in the
   * bc_open_page / bc_read_data response.
   */
  expectedStateVersion?: number;
}

/** One written field as the caller sees it (no raw BC events or control paths). */
export type WriteResult = Omit<FieldWriteResult, 'events' | 'controlPath'>;

export interface WriteDataOutput {
  results: WriteResult[];
  allSucceeded: boolean;
  changedSections: string[];
  /** Dialogs the write opened (e.g. an OnValidate confirm), each with its own pageContextId. */
  dialogsOpened: OpenedDialog[];
  requiresDialogResponse: boolean;
  /**
   * De-duplicated field-level validation warnings from PropertyChanged events.
   * Non-empty when BC emits Severity "Warning" or "Info" ValidationResults —
   * the value WAS accepted but BC flagged it informational. Severity "Error"
   * items cause the operation to return an Err(BusinessValidationError) instead
   * of appearing here.
   */
  validationWarnings: ReturnType<typeof fieldMessages>;
  /** AL Message() texts raised by OnValidate (Error/Fatal ones become an error instead); empty when none. */
  messages: ShownMessage[];
  /** True when BC echoed every written value and no dialog is pending: re-running cannot double-apply. */
  replaySafe: boolean;
}

export class WriteDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, BCError>> {
    if (input.expectedStateVersion !== undefined) {
      const ctx = this.repo.get(input.pageContextId);
      if (ctx && ctx.generation !== input.expectedStateVersion) {
        return err(new StaleContextError(input.expectedStateVersion, ctx.generation, { pageContextId: input.pageContextId }));
      }
    }

    const result = await this.dataService.writeFields(input.pageContextId, input.fields, {
      sectionId: input.section,
      rowIndex: input.rowIndex,
      bookmark: input.bookmark,
    });
    if (!isOk(result)) return result;

    const { results, events } = result.value;

    // Classify business errors before building the ok output.
    const bizErr = classifyBusinessError(events, this.repo);
    if (bizErr !== null) return err(bizErr);

    const ctx = this.repo.get(input.pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, events) : [];
    const dialogsOpened = registerDialogs(this.repo, input.pageContextId, events);
    const validationWarnings = fieldMessages(extractValidationErrors(events).filter(v => v.Severity !== 'Error'), this.repo);

    return ok({
      // Each result carried BC's whole event array: internal (replay-safety, echo checks), not output.
      results: results.map(({ events: _events, controlPath: _path, ...r }) => r),
      allSucceeded: results.every(r => r.success),
      changedSections,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
      validationWarnings,
      messages: collectMessages(events),
      replaySafe: writeDataReplaySafe(results, dialogsOpened.length),
    });
  }
}
