import { describe, it, expect, vi, afterEach } from 'vitest';
import { BCHttpClient } from '../../src/connection/bc-http.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const BASE = 'http://cronus28/BC';
const AUTH = () => ({ Cookie: 'session=abc' });

function streamResponse(chunks: Buffer[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(new Uint8Array(c)); controller.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } });
}

describe('BCHttpClient.get', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs baseUrl + relativeUrl with the auth headers and returns bytes', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(streamResponse([Buffer.from('%PDF-1.7')]));
    const c = new BCHttpClient(BASE, AUTH, logger);
    const r = await c.get('DynamicFileHandler.axd?fname=a.pdf', { maxBytes: 1000 });
    expect(spy).toHaveBeenCalledWith('http://cronus28/BC/DynamicFileHandler.axd?fname=a.pdf', expect.objectContaining({
      method: 'GET', redirect: 'manual', headers: expect.objectContaining({ Cookie: 'session=abc' }),
    }));
    expect(r.bytes.toString()).toBe('%PDF-1.7');
    expect(r.contentType).toBe('application/pdf');
    expect(r.fileName).toBe('a.pdf');
  });

  it('aborts and throws TOO_LARGE when the streamed body exceeds maxBytes without buffering it whole', async () => {
    // Two 600-byte chunks = 1200 bytes; cap is 1000. Must throw after the 2nd chunk, not buffer a 3rd.
    const chunk = Buffer.alloc(600, 0x41);
    let enqueued = 0;
    const body = new ReadableStream({
      pull(controller) { if (enqueued < 5) { controller.enqueue(new Uint8Array(chunk)); enqueued++; } else controller.close(); },
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'x' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow('TOO_LARGE');
    expect(enqueued).toBeLessThan(5); // proves we stopped pulling, did not read the whole body
  });

  it('throws with the HTTP status on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow(/404/);
  });

  it('treats a 3xx (redirect:manual) as an error naming the location', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/SignIn' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.get('x', { maxBytes: 1000 })).rejects.toThrow(/redirect|302|SignIn/i);
  });

  it('redacts sessionid and fid query values from the thrown error and the debug log', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    let thrown: Error | undefined;
    try {
      await c.get('DynamicFileHandler.axd?sessionid=SECRETSESS&fid=SECRETFID', { maxBytes: 1000 });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain('SECRETSESS');
    expect(thrown!.message).not.toContain('SECRETFID');
    expect(thrown!.message).toContain('***');

    expect(logger.debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('SECRETSESS'));
    expect(logger.debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('SECRETFID'));
  });
});

describe('BCHttpClient.postFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs a multipart form with the file bytes, auth cookie and X-CSRF-TOKEN header, returns the body', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 200 }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    const r = await c.postFile('DynamicFileUploadHandler.axd?form=f1&sessionid=s1', {
      bytes: Buffer.from('hello'), fileName: 'a.app', contentType: 'application/octet-stream',
    }, { csrfToken: 'CfDJ8TOKEN' });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://cronus28/BC/DynamicFileUploadHandler.axd?form=f1&sessionid=s1');
    expect(init).toEqual(expect.objectContaining({
      method: 'POST', redirect: 'manual',
      // antiforgery token MUST ride in the X-CSRF-TOKEN header, not the query string
      headers: expect.objectContaining({ Cookie: 'session=abc', 'X-CSRF-TOKEN': 'CfDJ8TOKEN' }),
    }));
    const body = (init as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get('file') as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('a.app');
    expect(await file.text()).toBe('hello');
    expect(r.status).toBe(200);
  });

  it('throws on a 302 auth redirect, with sessionid redacted', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/SignIn' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    let thrown: Error | undefined;
    try {
      await c.postFile('DynamicFileUploadHandler.axd?form=f1&sessionid=SECRETSESS', { bytes: Buffer.from('x'), fileName: 'a.app', contentType: 'application/octet-stream' });
    } catch (e) { thrown = e as Error; }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/redirect|302|SignIn/i);
    expect(thrown!.message).not.toContain('SECRETSESS');
  });

  it('throws with the HTTP status on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('bad form', { status: 404, statusText: 'Not Found' }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.postFile('x', { bytes: Buffer.from('x'), fileName: 'a.app', contentType: 'application/octet-stream' }))
      .rejects.toThrow(/404/);
  });
});

describe('BCHttpClient.fetchCsrfToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs /csrf with the auth cookie and returns the csrfToken from the JSON body', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ csrfToken: 'CfDJ8REQTOKEN' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const c = new BCHttpClient(BASE, AUTH, logger);
    const token = await c.fetchCsrfToken();
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://cronus28/BC/csrf');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Cookie: 'session=abc' }) }));
    expect(token).toBe('CfDJ8REQTOKEN');
  });

  it('throws when /csrf does not return a token', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const c = new BCHttpClient(BASE, AUTH, logger);
    await expect(c.fetchCsrfToken()).rejects.toThrow(/csrf|token/i);
  });
});
