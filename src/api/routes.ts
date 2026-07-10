import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Operations } from '../mcp/tool-registry.js';
import type { Logger } from '../core/logger.js';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
} from '../mcp/schemas.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

export function createApiRoutes(ops: Operations, logger: Logger): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  routes.set('POST /api/v1/pages/open', async (_req, res, body) => {
    const input = validateBody(OpenPageSchema, body, res);
    if (input === undefined) return;
    const result = await ops.openPage.execute(input as Parameters<typeof ops.openPage.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/read', async (_req, res, body) => {
    const input = validateBody(ReadDataSchema, body, res);
    if (input === undefined) return;
    const result = await ops.readData.execute(input as Parameters<typeof ops.readData.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/write', async (_req, res, body) => {
    const input = validateBody(WriteDataSchema, body, res);
    if (input === undefined) return;
    const result = await ops.writeData.execute(input as Parameters<typeof ops.writeData.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/action', async (_req, res, body) => {
    const input = validateBody(ExecuteActionSchema, body, res);
    if (input === undefined) return;
    const result = await ops.executeAction.execute(input as Parameters<typeof ops.executeAction.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/close', async (_req, res, body) => {
    const input = validateBody(ClosePageSchema, body, res);
    if (input === undefined) return;
    const result = await ops.closePage.execute(input as Parameters<typeof ops.closePage.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/search', async (_req, res, body) => {
    const input = validateBody(SearchPagesSchema, body, res);
    if (input === undefined) return;
    const result = await ops.searchPages.execute(input as Parameters<typeof ops.searchPages.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/navigate', async (_req, res, body) => {
    const input = validateBody(NavigateSchema, body, res);
    if (input === undefined) return;
    const result = await ops.navigate.execute(input as Parameters<typeof ops.navigate.execute>[0]);
    sendResult(res, result);
  });

  routes.set('GET /health', async (_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', version: '2.0.0' }));
  });

  // Suppress unused parameter warning — logger is available for future route-level logging
  void logger;

  return routes;
}

function validateBody<T extends z.ZodType>(schema: T, body: unknown, res: ServerResponse): z.output<T> | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: parsed.error.message, code: 'VALIDATION_ERROR' }));
    return undefined;
  }
  return parsed.data as z.output<T>;
}

function sendResult(res: ServerResponse, result: unknown): void {
  const r = result as { ok: boolean; value?: unknown; error?: { message: string; code: string } };
  if (r.ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.value));
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: r.error?.message, code: r.error?.code }));
  }
}
