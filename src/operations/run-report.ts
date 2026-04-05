import { ok, isErr, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { ControlField } from '../protocol/types.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface RunReportInput {
  reportId: string;
}

export interface RunReportOutput {
  success: boolean;
  reportId: number;
  requestPage?: {
    formId: string;
    fields?: ControlField[];
    message?: string;
  };
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class RunReportOperation {
  constructor(
    private readonly session: BCSession,
  ) {}

  async execute(input: RunReportInput): Promise<Result<RunReportOutput, ProtocolError>> {
    const reportId = parseInt(input.reportId, 10);

    const result = await this.session.runReport(reportId);

    if (isErr(result)) return result;

    const events = result.value;
    const dialogsOpened = detectDialogs(events);

    // The first dialog opened is typically the request page
    let requestPage: RunReportOutput['requestPage'] | undefined;
    if (dialogsOpened.length > 0) {
      const first = dialogsOpened[0]!;
      requestPage = {
        formId: first.formId,
        fields: first.fields,
        message: first.message,
      };
    }

    return ok({
      success: true,
      reportId,
      requestPage,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    });
  }
}
