import { v4 as uuid } from 'uuid';
import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import { detectDialogs } from '../protocol/mutation-result.js';
import type { Download, DownloadService } from '../services/download-service.js';

export interface RunReportInput {
  reportId: string;
  format?: 'pdf' | 'excel' | 'word';
}

export interface RunReportOutput {
  success: boolean;
  reportId: number;
  requestPage?: {
    /** Page context of the registered request page — target bc_write_data /
     * bc_respond_dialog against this to fill parameters and run the report. */
    pageContextId: string;
    formId: string;
    fields?: ControlField[];
    message?: string;
  };
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
  /** Captured report output(s) when format was specified; empty otherwise. */
  downloads: Download[];
}

export class RunReportOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly downloadService: DownloadService,
  ) {}

  async execute(input: RunReportInput): Promise<Result<RunReportOutput, ProtocolError>> {
    // Number() rejects trailing garbage ("12abc" -> NaN) that parseInt would
    // silently truncate; Number.isInteger rejects NaN and fractions.
    const reportId = Number(input.reportId);
    if (!Number.isInteger(reportId)) {
      return err(new ProtocolError(
        `Invalid reportId "${input.reportId}": must be a whole number, e.g. "6" for Trial Balance.`,
      ));
    }

    if (input.format) {
      return this.executeWithDownload(reportId, input.format);
    }

    const result = await this.session.runReport(reportId);

    if (isErr(result)) return result;

    const events = result.value;
    const dialogsOpened = detectDialogs(events);

    // The first dialog opened is typically the request page. Register it as a
    // page context so the caller can fill parameters with bc_write_data and run
    // the report with bc_respond_dialog(response: "ok") — without a
    // pageContextId the returned formId is unaddressable by those tools.
    let requestPage: RunReportOutput['requestPage'] | undefined;
    if (dialogsOpened.length > 0) {
      const first = dialogsOpened[0]!;
      const pcId = `session:page:report:${uuid().substring(0, 8)}`;
      this.repo.create(pcId, first.formId);
      this.repo.applyToPage(pcId, events);
      requestPage = {
        pageContextId: pcId,
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
      downloads: [],
    });
  }

  private async executeWithDownload(
    reportId: number,
    format: 'pdf' | 'excel' | 'word',
  ): Promise<Result<RunReportOutput, ProtocolError>> {
    const result = await this.session.runReportWithDownload(reportId, format);
    if (isErr(result)) return result;

    const captured = await this.downloadService.capture(result.value.events, { timeoutMs: 120_000 });

    return ok({
      success: true,
      reportId,
      // The request/format dialogs were auto-driven and closed by
      // runReportWithDownload — don't return their stale formIds.
      dialogsOpened: [],
      requiresDialogResponse: false,
      downloads: captured.downloads,
    });
  }
}
