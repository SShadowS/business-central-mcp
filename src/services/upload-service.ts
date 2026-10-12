/**
 * File upload for the BC web-client (`/csh`) path — the IMPERATIVE upload flow
 * (AL `Upload`/`UploadIntoStream`), verified end-to-end live cronus29 with a
 * nopost A/B control (page 9650 "Import Layout", 2026-10-12):
 *
 *   1. The caller invokes an upload action via `bc_execute_action` (e.g.
 *      "Import Layout"). AL runs `NavWebFileDialogProvider.FileOpen`, which
 *      builds a `FileUploadForm` dialog and applies the one-shot upload token
 *      to it — it arrives as a DialogOpened with `MappingHint: "FileUploadForm"`.
 *   2. We multipart-POST the bytes to
 *      {base}/DynamicFileUploadHandler.axd?form=<dialog formId>&sessionid=<ServerSessionId>
 *      (session-cookie auth + X-CSRF-TOKEN request-token header). The server
 *      consumes the token and feeds the stream into the dialog's
 *      ByteStreamControl. Success is HTTP 200 with an EMPTY body; a silent
 *      no-op (no token on the form) is ALSO 200 empty — which is why the
 *      target dialog must be identity-checked and the AL reaction observed.
 *   3. We CloseForm the dialog — exactly what client.js does after the POST
 *      (`rootForm.close()`). That returns the server-side ShowDialog, AL's
 *      UploadIntoStream resumes on our stream, and its UI reactions (a
 *      validation-error dialog on a bad file, list changes, ...) arrive in
 *      the close invoke's events.
 *
 * Declarative `fileuploadaction` controls (wire type `fla`, e.g. "Upload
 * Extension...") are a DIFFERENT protocol (POST /up temp files + the
 * `InvokeFileUploadAction` interaction) and are not served by this service.
 */

import type { Logger } from '../core/logger.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCHttpClient } from '../connection/bc-http.js';
import type { BCEvent } from '../protocol/types.js';
import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';

/**
 * Build the relative upload URL. `handlerSessionId` is the ServerSessionId
 * (same value BC puts in `sessionid=` on download/img URLs); it contains spaces
 * and slashes from the company name, so both params are URL-encoded.
 */
export function buildUploadUrl(formServerId: string, handlerSessionId: string): string {
  const qs = new URLSearchParams({ form: formServerId, sessionid: handlerSessionId });
  return `DynamicFileUploadHandler.axd?${qs.toString()}`;
}

export interface UploadInput {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly contentType: string;
}

export interface UploadResult {
  readonly success: boolean;
  readonly fileName: string;
  readonly sizeBytes: number;
  /** The FileUploadForm dialog the file was uploaded to. */
  readonly formId: string;
  /** Events from the CloseForm invoke — carries AL's reaction to the uploaded file (dialogs, list changes). */
  readonly events: BCEvent[];
}

/** A tracked dialog whose raw lf tree says it is a FileUploadForm. */
function isFileUploadDialog(d: { formId: string; controlTree?: unknown } | undefined): boolean {
  if (!d) return false;
  const tree = d.controlTree as Record<string, unknown> | undefined | null;
  return Boolean(tree) && (tree as Record<string, unknown>)['MappingHint'] === 'FileUploadForm';
}

function uploadDialogRequiredError(detail: string): ProtocolError {
  return new ProtocolError(
    `No FileUploadForm dialog is open on this page. Invoke the upload action first (bc_execute_action, e.g. "Import Layout") so BC opens the file-upload dialog, then call bc_upload_file with the returned dialog formId. ${detail}`,
  );
}

export class UploadService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly http: BCHttpClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Upload a file into the page's open FileUploadForm dialog (the imperative
   * upload flow; see the class comment). The target dialog MUST be a tracked
   * dialog with MappingHint "FileUploadForm" — POSTing to any other form
   * silently no-ops (BC returns 200 empty and the bytes are discarded), which
   * this guard makes impossible to hit by accident.
   */
  async upload(
    pageContextId: string,
    file: UploadInput,
    opts: { formId?: string; timeoutMs?: number } = {},
  ): Promise<Result<UploadResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));

    const dialogs = ctx.dialogs as ReadonlyArray<{ formId: string; controlTree?: unknown }>;
    const dialog = opts.formId !== undefined
      ? dialogs.find(d => d.formId === opts.formId)
      : [...dialogs].reverse().find(d => isFileUploadDialog(d));
    if (opts.formId !== undefined && dialog === undefined) {
      return err(uploadDialogRequiredError(`The explicit formId "${opts.formId}" is not a tracked dialog on this page.`));
    }
    if (!isFileUploadDialog(dialog)) {
      const active = dialogs.length > 0
        ? `The active dialog (${dialogs[dialogs.length - 1]!.formId}) is not a FileUploadForm.`
        : 'No dialog is open at all.';
      return err(uploadDialogRequiredError(active));
    }
    const formId = dialog!.formId;

    // Antiforgery: the upload POST requires the X-CSRF-TOKEN header (the request
    // token from /csrf, distinct from the antiforgery cookie). GET downloads and
    // the /csh WS skip antiforgery, so this is unique to the upload path.
    let csrfToken: string;
    try {
      csrfToken = await this.http.fetchCsrfToken({ timeoutMs: opts.timeoutMs });
    } catch (e) {
      return err(new ProtocolError(`Could not obtain antiforgery token for upload: ${e instanceof Error ? e.message : String(e)}`));
    }

    const url = buildUploadUrl(formId, this.session.serverSessionId);
    let post: { status: number; body: string };
    try {
      post = await this.http.postFile(url, file, { csrfToken, timeoutMs: opts.timeoutMs });
    } catch (e) {
      return err(new ProtocolError(`File upload failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    // A 200 with a non-empty body is the error channel (client.js: `t.error ?
    // f(t.error)`), not a success echo — success is an empty body.
    if (post.body.trim() !== '') {
      return err(new ProtocolError(`Upload rejected by BC: ${post.body.slice(0, 500)}`));
    }

    // Resume AL: CloseForm the upload dialog (client.js does exactly this after
    // the POST). AL's UploadIntoStream then continues with our stream and its
    // reactions ride back in this invoke's events.
    const events: BCEvent[] = [];
    const close = await this.session.invoke(
      { type: 'CloseForm', formId },
      (e: BCEvent) => e.type === 'InvokeCompleted',
    );
    if (!isErr(close)) {
      events.push(...close.value);
      this.repo.applyToPage(pageContextId, close.value);
    } else {
      this.logger.warn(`upload CloseForm failed (upload itself succeeded): ${close.error.message}`);
    }

    return ok({ success: true, fileName: file.fileName, sizeBytes: file.bytes.byteLength, formId, events });
  }
}
