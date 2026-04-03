import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Operations } from '../mcp/tool-registry.js';
import type { Logger } from '../core/logger.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

export function createApiRoutes(ops: Operations, logger: Logger): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  routes.set('POST /api/v1/pages/open', async (_req, res, body) => {
    const result = await ops.openPage.execute(body as Parameters<typeof ops.openPage.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/read', async (_req, res, body) => {
    const result = await ops.readData.execute(body as Parameters<typeof ops.readData.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/write', async (_req, res, body) => {
    const result = await ops.writeData.execute(body as Parameters<typeof ops.writeData.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/action', async (_req, res, body) => {
    const result = await ops.executeAction.execute(body as Parameters<typeof ops.executeAction.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/pages/close', async (_req, res, body) => {
    const result = await ops.closePage.execute(body as Parameters<typeof ops.closePage.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/search', async (_req, res, body) => {
    const result = await ops.searchPages.execute(body as Parameters<typeof ops.searchPages.execute>[0]);
    sendResult(res, result);
  });

  routes.set('POST /api/v1/navigate', async (_req, res, body) => {
    const result = await ops.navigate.execute(body as Parameters<typeof ops.navigate.execute>[0]);
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
