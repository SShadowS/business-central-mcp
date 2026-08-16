import { describe, it, expect, vi } from 'vitest';
import { createApiRoutes } from '../../src/api/routes.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import type { Logger } from '../../src/core/logger.js';
import { ConnectionError, SessionLostError } from '../../src/core/errors.js';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a minimal mock Operations object.  Every operation is a vi.fn() whose
 * default implementation returns an ok result.  Individual tests can override
 * by calling .mockResolvedValueOnce() on the specific operation mock.
 */
function makeMockOps(): Operations {
  const okResult = { ok: true as const, value: { data: 'test' } };

  const makeOp = (defaultResult = okResult) => ({
    execute: vi.fn().mockResolvedValue(defaultResult),
  });

  return {
    openPage: makeOp() as never,
    readData: makeOp() as never,
    writeData: makeOp() as never,
    executeAction: makeOp() as never,
    closePage: makeOp() as never,
    searchPages: makeOp() as never,
    navigate: makeOp() as never,
    respondDialog: makeOp() as never,
    switchCompany: makeOp() as never,
    listCompanies: makeOp() as never,
    runReport: makeOp() as never,
    wizardNavigate: makeOp() as never,
  };
}

interface FakeRes {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  statusCode?: number;
  writtenBody?: string;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

/** Parse the first string argument passed to res.end() as JSON */
function bodyJson(res: FakeRes): unknown {
  const raw: string = res.end.mock.calls[0]?.[0] ?? 'null';
  return JSON.parse(raw);
}

/** Return the status code passed to res.writeHead() */
function statusCode(res: FakeRes): number {
  return res.writeHead.mock.calls[0]?.[0];
}

/** Return the Content-Type header passed to res.writeHead() */
function contentType(res: FakeRes): string {
  return res.writeHead.mock.calls[0]?.[1]?.['Content-Type'];
}

// A minimal IncomingMessage stub – routes only use req for reading headers in
// middleware; the route handlers themselves receive (req, res, body) and ignore
// req directly.
const fakeReq = {} as never;

// ---------------------------------------------------------------------------
// Route map construction
// ---------------------------------------------------------------------------

describe('createApiRoutes', () => {
  it('returns a Map', () => {
    const routes = createApiRoutes(makeMockOps(), makeLogger());
    expect(routes).toBeInstanceOf(Map);
  });

  it('contains all expected route keys', () => {
    const routes = createApiRoutes(makeMockOps(), makeLogger());
    const keys = [...routes.keys()];
    expect(keys).toContain('POST /api/v1/pages/open');
    expect(keys).toContain('POST /api/v1/pages/read');
    expect(keys).toContain('POST /api/v1/pages/write');
    expect(keys).toContain('POST /api/v1/pages/action');
    expect(keys).toContain('POST /api/v1/pages/close');
    expect(keys).toContain('POST /api/v1/search');
    expect(keys).toContain('POST /api/v1/navigate');
    expect(keys).toContain('GET /health');
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health handler', () => {
  it('returns 200 with status:healthy', async () => {
    const routes = createApiRoutes(makeMockOps(), makeLogger());
    const handler = routes.get('GET /health')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, null);
    expect(statusCode(res)).toBe(200);
    expect(contentType(res)).toBe('application/json');
    expect(bodyJson(res)).toMatchObject({ status: 'healthy' });
  });

  it('includes a version field', async () => {
    const routes = createApiRoutes(makeMockOps(), makeLogger());
    const handler = routes.get('GET /health')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, null);
    const body = bodyJson(res) as Record<string, unknown>;
    expect(typeof body.version).toBe('string');
    expect(body.version).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Success path: ok result -> 200 with value as body
// ---------------------------------------------------------------------------

describe('success path (ok result)', () => {
  it('POST /api/v1/pages/open returns 200 and the value from the operation', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/open')!;

    const res = makeRes();
    const body = { pageId: '22' };
    await handler(fakeReq, res as unknown as ServerResponse, body);

    // Routes now validate + normalize via zod; execute receives the parsed data.
    expect(ops.openPage.execute).toHaveBeenCalledWith({ pageId: '22' });
    expect(statusCode(res)).toBe(200);
    expect(contentType(res)).toBe('application/json');
    expect(bodyJson(res)).toEqual({ data: 'test' });
  });

  it('POST /api/v1/pages/read returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/read')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1' });
    expect(statusCode(res)).toBe(200);
    expect(ops.readData.execute).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/pages/write returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/write')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', fields: { Name: 'Foo' } });
    expect(statusCode(res)).toBe(200);
    expect(ops.writeData.execute).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/pages/action returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/action')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', action: 'New' });
    expect(statusCode(res)).toBe(200);
    expect(ops.executeAction.execute).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/pages/close returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/close')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1' });
    expect(statusCode(res)).toBe(200);
    expect(ops.closePage.execute).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/search returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/search')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { query: 'customers' });
    expect(statusCode(res)).toBe(200);
    expect(ops.searchPages.execute).toHaveBeenCalledTimes(1);
  });

  it('POST /api/v1/navigate returns 200', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/navigate')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', bookmark: 'bk1' });
    expect(statusCode(res)).toBe(200);
    expect(ops.navigate.execute).toHaveBeenCalledTimes(1);
  });

  it('sends null body when operation value is null', async () => {
    const ops = makeMockOps();
    (ops.openPage.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      value: null,
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/open')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageId: '22' });
    expect(statusCode(res)).toBe(200);
    expect(bodyJson(res)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error path: err result -> 400 with error/code shape
// ---------------------------------------------------------------------------

describe('error path (err result)', () => {
  it('POST /api/v1/pages/open returns 400 with error shape when operation fails', async () => {
    const ops = makeMockOps();
    (ops.openPage.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { message: 'Page not found', code: 'PAGE_NOT_FOUND' },
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/open')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageId: '404' });
    expect(statusCode(res)).toBe(400);
    expect(contentType(res)).toBe('application/json');
    expect(bodyJson(res)).toEqual({ error: 'Page not found', code: 'PAGE_NOT_FOUND' });
  });

  it('POST /api/v1/pages/read returns 503 when the operation fails with SessionLostError', async () => {
    // A real BCError on the Result channel gets the same HTTP classification
    // as one thrown from ensureReady — one serializer, not two.
    const ops = makeMockOps();
    (ops.readData.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: new SessionLostError('Session expired', []),
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/read')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1' });
    expect(statusCode(res)).toBe(503);
    expect(bodyJson(res)).toMatchObject({ error: 'Session expired', code: 'SESSION_LOST' });
  });

  it('POST /api/v1/search returns 503 when the operation fails with ConnectionError', async () => {
    const ops = makeMockOps();
    (ops.searchPages.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: new ConnectionError('BC unreachable'),
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/search')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { query: 'x' });
    expect(statusCode(res)).toBe(503);
    expect(bodyJson(res)).toMatchObject({ error: 'BC unreachable', code: 'CONNECTION_ERROR' });
  });

  it('produces { error: undefined, code: undefined } when error object has no message/code', async () => {
    // Exercises the optional chaining in sendResult: r.error?.message, r.error?.code
    const ops = makeMockOps();
    (ops.openPage.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: undefined,
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/open')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageId: '22' });
    expect(statusCode(res)).toBe(400);
    const body = bodyJson(res) as Record<string, unknown>;
    // Both fields are undefined; JSON.stringify converts undefined values to
    // absent properties, so the serialised body has neither key.
    expect(body).not.toHaveProperty('error');
    expect(body).not.toHaveProperty('code');
  });
});

// ---------------------------------------------------------------------------
// Body is forwarded to the operation as-is
// ---------------------------------------------------------------------------

describe('input validation and forwarding', () => {
  it('rejects a schema-invalid body with 400 VALIDATION_ERROR and does not call the operation', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/navigate')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { target: 'some-page', extra: 42 });
    expect(statusCode(res)).toBe(400);
    expect(bodyJson(res)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(ops.navigate.execute).not.toHaveBeenCalled();
  });

  it('forwards the validated (schema-shaped) input, stripping unknown keys', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/navigate')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', bookmark: 'bk1', extra: 42 });
    expect(ops.navigate.execute).toHaveBeenCalledWith({ pageContextId: 'ctx1', bookmark: 'bk1' });
  });
});
