import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiRoutes } from '../../src/api/routes.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import { BusinessValidationError, SessionLostError, TimeoutError } from '../../src/core/errors.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import type { Logger } from '../../src/core/logger.js';
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
    lookup: makeOp() as never,
    query: makeOp() as never,
    uploadFile: makeOp() as never,
    getOperation: makeOp() as never,
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

  it('maps an ambiguous failure of a read-only route to 503 without a replaySafe verdict', async () => {
    const ops = makeMockOps();
    (ops.readData.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { message: 'Session expired', code: 'SESSION_LOST' },
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/read')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1' });
    expect(statusCode(res)).toBe(503);
    expect(bodyJson(res)).toEqual({ error: 'Session expired', code: 'SESSION_LOST' });
  });

  it('maps TIMEOUT_ERROR to 504 and marks a mutating route replaySafe:false', async () => {
    const ops = makeMockOps();
    (ops.executeAction.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: new TimeoutError('watchdog') });
    const res = makeRes();
    await createApiRoutes(ops, makeLogger()).get('POST /api/v1/pages/action')!(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', action: 'Post' });
    expect(statusCode(res)).toBe(504);
    expect(bodyJson(res)).toMatchObject({ code: 'TIMEOUT_ERROR', replaySafe: false });
  });

  it('turns a thrown SessionLostError on a mutating route into 503 with its recovery payload', async () => {
    const ops = makeMockOps();
    (ops.writeData.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SessionLostError('dropped', ['pc:1']));
    const res = makeRes();
    await createApiRoutes(ops, makeLogger()).get('POST /api/v1/pages/write')!(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', fields: { Name: 'Foo' } });
    expect(statusCode(res)).toBe(503);
    expect(bodyJson(res)).toMatchObject({ code: 'SESSION_LOST', impactedPageContextIds: ['pc:1'], replaySafe: false });
  });

  it('keeps a definite failure of a mutating route at 400 without a verdict', async () => {
    const ops = makeMockOps();
    (ops.writeData.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: new BusinessValidationError([{ description: 'bad' }]) });
    const res = makeRes();
    await createApiRoutes(ops, makeLogger()).get('POST /api/v1/pages/write')!(fakeReq, res as unknown as ServerResponse, { pageContextId: 'ctx1', fields: { Name: 'Foo' } });
    expect(statusCode(res)).toBe(400);
    expect(bodyJson(res)).not.toHaveProperty('replaySafe');
  });

  it('treats an untyped failure as a 500', async () => {
    const ops = makeMockOps();
    (ops.openPage.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: undefined,
    });
    const routes = createApiRoutes(ops, makeLogger());
    const handler = routes.get('POST /api/v1/pages/open')!;
    const res = makeRes();
    await handler(fakeReq, res as unknown as ServerResponse, { pageId: '22' });
    expect(statusCode(res)).toBe(500);
    expect(bodyJson(res)).toEqual({ error: 'Unknown error' });
  });
});

// ---------------------------------------------------------------------------
// Idempotency-Key replay gate (#30)
// ---------------------------------------------------------------------------

describe('Idempotency-Key replay gate', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-rest-ledger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const writeBody = { pageContextId: 'ctx1', fields: { Name: 'Foo' } };
  const post = async (routes: ReturnType<typeof createApiRoutes>, path: string, body: unknown, key?: string) => {
    const res = makeRes();
    const req = { headers: key === undefined ? {} : { 'idempotency-key': key } } as never;
    await routes.get(`POST /api/v1/${path}`)!(req, res as unknown as ServerResponse, body);
    return res;
  };

  it('replays a completed call with 200 + Idempotent-Replayed, without re-executing, and records it under the MCP tool name', async () => {
    const ops = makeMockOps();
    const ledger = new OperationLedger(dir);
    const routes = createApiRoutes(ops, makeLogger(), new IdempotencyGate(ledger, makeLogger()));
    const first = await post(routes, 'pages/write', writeBody, 'k-1');
    const second = await post(routes, 'pages/write', writeBody, 'k-1');
    expect(ops.writeData.execute).toHaveBeenCalledTimes(1);
    expect(statusCode(second)).toBe(200);
    expect(second.writeHead.mock.calls[0]![1]).toMatchObject({ 'Idempotent-Replayed': 'true' });
    expect(bodyJson(second)).toEqual(bodyJson(first));
    expect(await ledger.get('k-1')).toMatchObject({ tool: 'bc_write_data', status: 'completed', result: { data: 'test' } });
  });

  it('rejects a reused key with different input, or on a different route, with 422', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger(), new IdempotencyGate(new OperationLedger(dir), makeLogger()));
    await post(routes, 'pages/write', writeBody, 'k-2');
    const otherInput = await post(routes, 'pages/write', { ...writeBody, fields: { Name: 'Bar' } }, 'k-2');
    const otherRoute = await post(routes, 'pages/close', { pageContextId: 'ctx1' }, 'k-2');
    expect(statusCode(otherInput)).toBe(422);
    expect(bodyJson(otherInput)).toMatchObject({ code: 'OPERATION_ID_REUSED' });
    expect(statusCode(otherRoute)).toBe(422);
    expect(ops.writeData.execute).toHaveBeenCalledTimes(1);
    expect(ops.closePage.execute).not.toHaveBeenCalled();
  });

  it('reports an ambiguous failure as 409 in doubt on retry, never re-executing', async () => {
    const ops = makeMockOps();
    (ops.executeAction.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: new TimeoutError('watchdog') });
    const routes = createApiRoutes(ops, makeLogger(), new IdempotencyGate(new OperationLedger(dir), makeLogger()));
    const body = { pageContextId: 'ctx1', action: 'Post' };
    expect(statusCode(await post(routes, 'pages/action', body, 'k-3'))).toBe(504);
    const retry = await post(routes, 'pages/action', body, 'k-3');
    expect(statusCode(retry)).toBe(409);
    expect(bodyJson(retry)).toMatchObject({ code: 'OPERATION_IN_DOUBT', operationId: 'k-3', status: 'unknown', replaySafe: false, error: { code: 'TIMEOUT_ERROR' } });
    expect(ops.executeAction.execute).toHaveBeenCalledTimes(1);
  });

  it('releases the key after a definite failure so a corrected retry executes', async () => {
    const ops = makeMockOps();
    (ops.writeData.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: new BusinessValidationError([{ description: 'bad' }]) });
    const ledger = new OperationLedger(dir);
    const routes = createApiRoutes(ops, makeLogger(), new IdempotencyGate(ledger, makeLogger()));
    expect(statusCode(await post(routes, 'pages/write', writeBody, 'k-4'))).toBe(400);
    expect(await ledger.get('k-4')).toBeUndefined();
    expect(statusCode(await post(routes, 'pages/write', writeBody, 'k-4'))).toBe(200);
    expect(ops.writeData.execute).toHaveBeenCalledTimes(2);
  });

  it('shares ids with MCP: a REST key replays a result stored by the MCP gate', async () => {
    const ops = makeMockOps();
    const ledger = new OperationLedger(dir);
    const gate = new IdempotencyGate(ledger, makeLogger());
    await gate.run('bc_close_page', 'k-5', { pageContextId: 'ctx1' }, async () => ({ value: { closed: true } }));
    const res = await post(createApiRoutes(ops, makeLogger(), gate), 'pages/close', { pageContextId: 'ctx1' }, 'k-5');
    expect(bodyJson(res)).toEqual({ closed: true });
    expect(ops.closePage.execute).not.toHaveBeenCalled();
  });

  it('rejects an over-long key with 400 and ignores the header on read-only routes', async () => {
    const ops = makeMockOps();
    const routes = createApiRoutes(ops, makeLogger(), new IdempotencyGate(new OperationLedger(dir), makeLogger()));
    expect(statusCode(await post(routes, 'pages/write', writeBody, 'x'.repeat(201)))).toBe(400);
    expect(ops.writeData.execute).not.toHaveBeenCalled();
    await post(routes, 'pages/read', { pageContextId: 'ctx1' }, 'k-6');
    await post(routes, 'pages/read', { pageContextId: 'ctx1' }, 'k-6');
    expect(ops.readData.execute).toHaveBeenCalledTimes(2);
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
