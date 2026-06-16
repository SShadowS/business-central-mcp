import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReportDownloader } from '../../src/session/report-downloader.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const BASE_URL = 'http://cronus28/BC';
const EXPECTED_URL = `${BASE_URL}/client/uploadDownload/download`;
const AUTH_HEADERS = { Cookie: 'session=abc123' };

describe('ReportDownloader', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the correct download URL with Cookie header', async () => {
    const fakeBytes = Buffer.from('PDF content here');
    fetchSpy.mockResolvedValueOnce(
      new Response(fakeBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const downloader = new ReportDownloader(BASE_URL, () => AUTH_HEADERS, createMockLogger() as any);
    const result = await downloader.download();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(EXPECTED_URL);
    expect((calledInit.headers as Record<string, string>)['Cookie']).toBe(AUTH_HEADERS.Cookie);

    expect(result.contentType).toBe('application/pdf');
    expect(result.bytes.equals(fakeBytes)).toBe(true);
  });

  it('includes User-Agent header in the request', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from('data'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );

    const downloader = new ReportDownloader(BASE_URL, () => AUTH_HEADERS, createMockLogger() as any);
    await downloader.download();

    const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((calledInit.headers as Record<string, string>)['User-Agent']).toBe('BCMCPServer/2.0');
  });

  it('throws a clear error on non-200 response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    );

    const downloader = new ReportDownloader(BASE_URL, () => AUTH_HEADERS, createMockLogger() as any);
    await expect(downloader.download()).rejects.toThrow('Report download failed: HTTP 404 Not Found');
  });

  it('throws on 500 internal server error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    const downloader = new ReportDownloader(BASE_URL, () => AUTH_HEADERS, createMockLogger() as any);
    await expect(downloader.download()).rejects.toThrow('Report download failed: HTTP 500');
  });

  it('uses application/octet-stream when content-type header is absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from('bytes'), { status: 200 }),
    );

    const downloader = new ReportDownloader(BASE_URL, () => AUTH_HEADERS, createMockLogger() as any);
    const result = await downloader.download();
    expect(result.contentType).toBe('application/octet-stream');
  });

  it('calls getAuthHeaders each time to pick up refreshed cookies', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(Buffer.from('x'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    let callCount = 0;
    const getHeaders = vi.fn(() => {
      callCount++;
      return { Cookie: `session=call${callCount}` };
    });

    const downloader = new ReportDownloader(BASE_URL, getHeaders, createMockLogger() as any);
    await downloader.download();
    await downloader.download();

    expect(getHeaders).toHaveBeenCalledTimes(2);
    const [, init1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((init1.headers as Record<string, string>)['Cookie']).toBe('session=call1');
    expect((init2.headers as Record<string, string>)['Cookie']).toBe('session=call2');
  });
});
