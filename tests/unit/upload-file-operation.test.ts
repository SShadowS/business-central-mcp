import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UploadFileOperation } from '../../src/operations/upload-file.js';
import { ok, isOk, isErr } from '../../src/core/result.js';

function fakeService() {
  return {
    upload: vi.fn(async (_pc: string, file: { fileName: string; bytes: Buffer }, _opts?: unknown) =>
      ok({ success: true, fileName: file.fileName, sizeBytes: file.bytes.byteLength, formId: 'f1', events: [] })),
  };
}

describe('UploadFileOperation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bcup-'));
  afterEach(() => vi.restoreAllMocks());

  it('reads a local path, derives the basename, and uploads the bytes', async () => {
    const p = join(dir, 'ext.app');
    writeFileSync(p, 'APP-BYTES');
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = new UploadFileOperation(svc as any);
    const r = await op.execute({ pageContextId: 'pc1', path: p });
    expect(svc.upload).toHaveBeenCalledWith('pc1',
      expect.objectContaining({ fileName: 'ext.app', bytes: expect.any(Buffer) }),
      expect.objectContaining({ formId: undefined }));
    const call = svc.upload.mock.calls[0]!;
    expect((call[1] as { bytes: Buffer }).bytes.toString()).toBe('APP-BYTES');
    expect(isOk(r) && r.value.fileName).toBe('ext.app');
  });

  it('decodes base64 with the provided fileName and passes an explicit formId', async () => {
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = new UploadFileOperation(svc as any);
    const r = await op.execute({ pageContextId: 'pc1', base64: Buffer.from('HELLO').toString('base64'), fileName: 'x.app', formId: 'dlg' });
    const call = svc.upload.mock.calls[0]!;
    expect((call[1] as { bytes: Buffer }).bytes.toString()).toBe('HELLO');
    expect(call[2]).toEqual(expect.objectContaining({ formId: 'dlg' }));
    expect(isOk(r)).toBe(true);
  });

  it('errors when the local path does not exist', async () => {
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = new UploadFileOperation(svc as any);
    const r = await op.execute({ pageContextId: 'pc1', path: join(dir, 'nope.app') });
    expect(isErr(r)).toBe(true);
    expect(svc.upload).not.toHaveBeenCalled();
  });

  it('infers content type from extension (.pdf -> application/pdf)', async () => {
    const p = join(dir, 'doc.pdf');
    writeFileSync(p, '%PDF');
    const svc = fakeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = new UploadFileOperation(svc as any);
    await op.execute({ pageContextId: 'pc1', path: p });
    expect((svc.upload.mock.calls[0]![1] as { contentType: string }).contentType).toBe('application/pdf');
  });

  it('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
});
