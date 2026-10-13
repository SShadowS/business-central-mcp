import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { UploadService } from '../services/upload-service.js';
import type { BCEvent } from '../protocol/types.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface UploadFileInput {
  pageContextId: string;
  path?: string;
  base64?: string;
  fileName?: string;
  formId?: string;
}

export interface UploadFileOutput {
  success: boolean;
  fileName: string;
  sizeBytes: number;
  /** The form the file was uploaded to. */
  formId: string;
  /** Dialogs/messages the AL OnUpload trigger surfaced (e.g. validation errors). */
  dialogsOpened: Array<{ formId: string; message?: string }>;
  /** Always false: re-running uploads again and re-fires the AL OnUpload import. */
  replaySafe: false;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export class UploadFileOperation {
  constructor(private readonly uploadService: UploadService) {}

  async execute(input: UploadFileInput): Promise<Result<UploadFileOutput, ProtocolError>> {
    let bytes: Buffer;
    let fileName: string;

    if (input.path) {
      try {
        if (!statSync(input.path).isFile()) return err(new ProtocolError(`Not a file: ${input.path}`));
        bytes = readFileSync(input.path);
      } catch (e) {
        return err(new ProtocolError(`Cannot read file "${input.path}": ${e instanceof Error ? e.message : String(e)}`));
      }
      fileName = input.fileName ?? basename(input.path);
    } else if (input.base64) {
      if (!input.fileName) return err(new ProtocolError('`fileName` is required when uploading via `base64`.'));
      try {
        bytes = Buffer.from(input.base64, 'base64');
      } catch {
        return err(new ProtocolError('`base64` is not valid base64 content.'));
      }
      fileName = input.fileName;
    } else {
      return err(new ProtocolError('Provide exactly one of `path` or `base64`.'));
    }

    const contentType = CONTENT_TYPE_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream';

    const result = await this.uploadService.upload(
      input.pageContextId,
      { bytes, fileName, contentType },
      { formId: input.formId },
    );
    if (isErr(result)) return result;

    const events: BCEvent[] = result.value.events;
    const dialogsOpened = detectDialogs(events).map((d) => ({ formId: d.formId, message: d.message }));

    return ok({
      success: result.value.success,
      fileName: result.value.fileName,
      sizeBytes: result.value.sizeBytes,
      formId: result.value.formId,
      dialogsOpened,
      replaySafe: false,
    });
  }
}
