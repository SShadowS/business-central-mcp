import { describe, it, expect, vi } from 'vitest';
import { UploadService } from '../../src/services/upload-service.js';
import { isOk, isErr, ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/** A tracked FileUploadForm dialog (MappingHint verified live cronus29, page 9650 "Import Layout"). */
const UPLOAD_DIALOG = { formId: '720', controlTree: { MappingHint: 'FileUploadForm' } };
/** An unrelated modal — e.g. the ErrorDialog an empty-list action failure opens, or a "No. Series" task dialog. */
const ERROR_DIALOG = { formId: '63E', controlTree: { MappingHint: 'ErrorDialog', Caption: 'Error' } };

function harness(ctx: unknown, postFileResult: { status: number; body: string } = { status: 200, body: '' }, invokeEvents: BCEvent[] = []) {
  const http = {
    fetchCsrfToken: vi.fn(async () => 'TOK'),
    postFile: vi.fn(async () => postFileResult),
  };
  const session = { serverSessionId: 'SID', invoke: vi.fn(async () => ok(invokeEvents)) };
  const repo = { get: vi.fn(() => ctx), applyToPage: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new UploadService(session as any, repo as any, http as any, logger);
  return { svc, http, session, repo };
}

const FILE = { bytes: Buffer.from('payload'), fileName: 'a.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

describe('UploadService.upload (verified imperative path: POST + CloseForm)', () => {
  it('POSTs to the active FileUploadForm dialog, then CloseForms it so AL resumes', async () => {
    const events: BCEvent[] = [{ type: 'DialogOpened', formId: '721', controlTree: {} }];
    const { svc, http, session } = harness({ rootFormId: 'root', dialogs: [UPLOAD_DIALOG], forms: new Map() }, { status: 200, body: '' }, events);
    const r = await svc.upload('pc1', FILE);
    expect(http.fetchCsrfToken).toHaveBeenCalled();
    expect(http.postFile).toHaveBeenCalledWith(
      'DynamicFileUploadHandler.axd?form=720&sessionid=SID',
      expect.objectContaining({ fileName: 'a.docx' }),
      { csrfToken: 'TOK' },
    );
    // The resumption step is CloseForm of the upload dialog (client.js
    // rootForm.close() after the POST) — NOT a LoadForm flush, which violates
    // modality while the dialog is still open (LogicalModalityViolation).
    expect(session.invoke).toHaveBeenCalledWith(
      { type: 'CloseForm', formId: '720' },
      expect.any(Function),
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.formId).toBe('720');
      expect(r.value.events).toEqual(events);
    }
  });

  it('accepts an explicit formId only when it is a tracked FileUploadForm dialog', async () => {
    const { svc, http } = harness({ rootFormId: 'root', dialogs: [UPLOAD_DIALOG], forms: new Map() });
    const r = await svc.upload('pc1', FILE, { formId: '720' });
    expect(http.postFile).toHaveBeenCalled();
    expect(isOk(r) && r.value.formId).toBe('720');
  });

  it('rejects an explicit formId that is not a tracked dialog (silent no-op guard)', async () => {
    const { svc, http } = harness({ rootFormId: 'root', dialogs: [UPLOAD_DIALOG], forms: new Map() });
    const r = await svc.upload('pc1', FILE, { formId: 'explicit' });
    expect(http.postFile).not.toHaveBeenCalled();
    expect(isErr(r)).toBe(true);
    expect(isErr(r) && r.error.message).toMatch(/[Ee]xplicit/);
  });

  it('rejects when the active dialog is not a FileUploadForm (e.g. an ErrorDialog)', async () => {
    const { svc, http } = harness({ rootFormId: 'root', dialogs: [ERROR_DIALOG], forms: new Map() });
    const r = await svc.upload('pc1', FILE);
    expect(http.postFile).not.toHaveBeenCalled();
    expect(isErr(r)).toBe(true);
    expect(isErr(r) && r.error.message).toMatch(/FileUploadForm|upload action/i);
  });

  it('rejects when no dialog is open (page-root POST silently no-ops — no token is ever applied)', async () => {
    const { svc, http } = harness({ rootFormId: 'root', dialogs: [], forms: new Map() });
    const r = await svc.upload('pc1', FILE);
    expect(http.postFile).not.toHaveBeenCalled();
    expect(isErr(r)).toBe(true);
    expect(isErr(r) && r.error.message).toMatch(/FileUploadForm|upload action/i);
  });

  it('surfaces an AL-side error when the POST returns 200 with a non-empty body', async () => {
    const { svc, session } = harness({ rootFormId: 'root', dialogs: [UPLOAD_DIALOG], forms: new Map() }, { status: 200, body: '{"error":"The file is corrupt."}' });
    const r = await svc.upload('pc1', FILE);
    expect(isErr(r)).toBe(true);
    expect(isErr(r) && r.error.message).toMatch(/corrupt/);
    expect(session.invoke).not.toHaveBeenCalled();
  });

  it('errors when the page context is not found', async () => {
    const { svc } = harness(undefined);
    const r = await svc.upload('missing', FILE);
    expect(isErr(r)).toBe(true);
  });
});
