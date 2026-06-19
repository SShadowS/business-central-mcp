import { ok, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { ControlField } from '../protocol/types.js';
import { detectDialogs } from '../protocol/mutation-result.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface RunReportInput {
  reportId: string;
  format?: 'pdf' | 'excel' | 'word';
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
  /** Present when format was specified and the report file was captured. */
  download?: {
    /** Base64-encoded file bytes. */
    bytes: string;
    contentType: string;
    fileName?: string;
    /** Absolute path where the file was saved, if BC_REPORT_DIR is set. */
    savedPath?: string;
  };
}

export class RunReportOperation {
  constructor(
    private readonly session: BCSession,
  ) {}

  async execute(input: RunReportInput): Promise<Result<RunReportOutput, ProtocolError>> {
    const reportId = parseInt(input.reportId, 10);

    if (input.format) {
      return this.executeWithDownload(reportId, input.format);
    }

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

  private async executeWithDownload(
    reportId: number,
    format: 'pdf' | 'excel' | 'word',
  ): Promise<Result<RunReportOutput, ProtocolError>> {
    const result = await this.session.runReportWithDownload(reportId, format);
    if (isErr(result)) return result;

    const { events, bytes, contentType, fileName } = result.value;
    const dialogsOpened = detectDialogs(events);

    let savedPath: string | undefined;
    const reportDir = process.env['BC_REPORT_DIR'];
    if (reportDir) {
      try {
        if (!existsSync(reportDir)) {
          mkdirSync(reportDir, { recursive: true });
        }
        const outName = fileName ?? `report-${reportId}-${Date.now()}.pdf`;
        savedPath = join(reportDir, outName);
        writeFileSync(savedPath, bytes);
      } catch {
        // Non-fatal: still return bytes even if save fails
        savedPath = undefined;
      }
    }

    return ok({
      success: true,
      reportId,
      dialogsOpened,
      requiresDialogResponse: false,
      download: {
        bytes: bytes.toString('base64'),
        contentType,
        fileName,
        savedPath,
      },
    });
  }
}
