import { describe, it, expect, vi } from 'vitest';
import { DownloadService } from '../../src/services/download-service.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const BASE = 'http://cronus28/BC';
const LIMITS = { maxBytes: 1000, maxTotalBytes: 1500, maxDownloads: 3, dir: undefined };
const dl = (fname: string, style = '1'): BCEvent => ({ type: 'FileDownloadReady', formId: '', relativeUrl: `DynamicFileHandler.axd?fname=${fname}`, style } as BCEvent);

function fakeHttp(impl: (url: string) => Promise<{ bytes: Buffer; contentType: string; fileName?: string }>) {
  return { get: vi.fn((relativeUrl: string) => impl(relativeUrl)) } as never;
}

describe('DownloadService.capture', () => {
  it('returns empty arrays when no downloads and no externals', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('unused'); }), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'InvokeCompleted' } as BCEvent]);
    expect(r).toEqual({ downloads: [], externalUris: [] });
  });

  it('fetches a ref and returns base64 bytes', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'a.pdf' })), BASE, LIMITS, logger);
    const r = await svc.capture([dl('a.pdf')]);
    expect(r.downloads[0]).toMatchObject({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4, style: 'download' });
    expect(Buffer.from(r.downloads[0]!.bytes!, 'base64').toString()).toBe('%PDF');
  });

  it('maps a TOO_LARGE fetch to a per-entry error, not a whole failure', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('TOO_LARGE'); }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('big.xlsx')]);
    expect(r.downloads[0]!.error?.code).toBe('TOO_LARGE');
    expect(r.downloads[0]!.bytes).toBeUndefined();
  });

  it('maps a generic fetch failure to FETCH_FAILED per entry', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('HTTP 404 Not Found'); }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('gone.pdf')]);
    expect(r.downloads[0]!.error?.code).toBe('FETCH_FAILED');
    expect(r.downloads[0]!.error?.message).toContain('404');
  });

  it('one failing entry does not remove the others, order preserved', async () => {
    const svc = new DownloadService(fakeHttp(async (u) => {
      if (u.includes('bad')) throw new Error('HTTP 500');
      return { bytes: Buffer.from('ok'), contentType: 'x', fileName: undefined };
    }), BASE, LIMITS, logger);
    const r = await svc.capture([dl('good1.pdf'), dl('bad.pdf'), dl('good2.pdf')]);
    expect(r.downloads.map(d => d.error?.code ?? 'ok')).toEqual(['ok', 'FETCH_FAILED', 'ok']);
  });

  it('assigns a fallback filename when none is available', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('x'), contentType: 'application/pdf', fileName: undefined })), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'FileDownloadReady', formId: '', relativeUrl: 'DynamicFileHandler.axd?form=41D', style: '1' } as BCEvent]);
    expect(r.downloads[0]!.fileName).toBe('download-0.pdf');
  });

  it('enforces the count cap and reports the drop', async () => {
    const svc = new DownloadService(fakeHttp(async () => ({ bytes: Buffer.from('x'), contentType: 'x', fileName: undefined })), BASE, { ...LIMITS, maxDownloads: 2 }, logger);
    const r = await svc.capture([dl('1'), dl('2'), dl('3')]);
    expect(r.downloads).toHaveLength(3);
    expect(r.downloads[2]!.error?.code).toBe('TOO_LARGE'); // dropped-by-count reuses TOO_LARGE with an explanatory message
    expect(r.downloads[2]!.error?.message).toMatch(/count|maximum/i);
  });

  it('surfaces external URIs untouched', async () => {
    const svc = new DownloadService(fakeHttp(async () => { throw new Error('unused'); }), BASE, LIMITS, logger);
    const r = await svc.capture([{ type: 'FileDownloadReady', formId: '', relativeUrl: 'http://evil.com/x', style: '1' } as BCEvent]);
    expect(r.downloads).toEqual([]);
    expect(r.externalUris).toEqual([{ uri: 'http://evil.com/x', style: 'download' }]);
  });
});
