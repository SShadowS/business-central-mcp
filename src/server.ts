import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { NTLMAuthProvider } from './connection/auth/ntlm-provider.js';
import { ConnectionFactory } from './connection/connection-factory.js';
import { EventDecoder } from './protocol/event-decoder.js';
import { InteractionEncoder } from './protocol/interaction-encoder.js';
import { PageContextRepository } from './protocol/page-context-repo.js';
import { SessionFactory } from './session/session-factory.js';
import type { BCSession } from './session/bc-session.js';
import { PageService } from './services/page-service.js';
import { DataService } from './services/data-service.js';
import { ActionService } from './services/action-service.js';
import { FilterService } from './services/filter-service.js';
import { NavigationService } from './services/navigation-service.js';
import { SearchService } from './services/search-service.js';
import { OpenPageOperation } from './operations/open-page.js';
import { ReadDataOperation } from './operations/read-data.js';
import { WriteDataOperation } from './operations/write-data.js';
import { ExecuteActionOperation } from './operations/execute-action.js';
import { ClosePageOperation } from './operations/close-page.js';
import { SearchPagesOperation } from './operations/search-pages.js';
import { NavigateOperation } from './operations/navigate.js';
import { RespondDialogOperation } from './operations/respond-dialog.js';
import { buildToolRegistry, type Operations } from './mcp/tool-registry.js';
import { MCPHandler } from './mcp/handler.js';
import { createApiRoutes } from './api/routes.js';
import { parseJsonBody, checkApiToken } from './api/middleware.js';
import { isErr } from './core/result.js';

dotenvConfig();

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  logger.info('Starting BC MCP Server v2...');

  // Infrastructure
  const authProvider = new NTLMAuthProvider({
    baseUrl: config.bc.baseUrl,
    username: config.bc.username,
    password: config.bc.password,
    tenantId: config.bc.tenantId,
  }, logger);
  const connectionFactory = new ConnectionFactory(authProvider, config.bc, logger);

  // Protocol
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(config.bc.clientVersionString);
  const pageContextRepo = new PageContextRepository();

  // Session — created lazily on first request
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId,
  );

  let session: BCSession | null = null;

  async function getSession(): Promise<BCSession> {
    if (session !== null) return session;
    const result = await sessionFactory.create();
    if (isErr(result)) throw new Error(`Session creation failed: ${result.error.message}`);
    session = result.value;
    logger.info('BC session established');
    return session;
  }

  // Services — built once after session is available
  function buildServices(s: BCSession): { operations: Operations; tools: ReturnType<typeof buildToolRegistry> } {
    const pageService = new PageService(s, pageContextRepo, logger);
    const dataService = new DataService(s, pageContextRepo, logger);
    const actionService = new ActionService(s, pageContextRepo, logger);
    const filterService = new FilterService(s, pageContextRepo, logger);
    const navigationService = new NavigationService(s, pageContextRepo, logger);
    const searchService = new SearchService(s, logger);

    const operations: Operations = {
      openPage: new OpenPageOperation(pageService),
      readData: new ReadDataOperation(dataService, filterService),
      writeData: new WriteDataOperation(dataService, pageContextRepo),
      executeAction: new ExecuteActionOperation(actionService, pageContextRepo),
      closePage: new ClosePageOperation(pageService),
      searchPages: new SearchPagesOperation(searchService),
      navigate: new NavigateOperation(navigationService),
      respondDialog: new RespondDialogOperation(s, pageContextRepo),
    };

    return { operations, tools: buildToolRegistry(operations) };
  }

  let mcpHandler: MCPHandler | null = null;
  let apiRoutes: ReturnType<typeof createApiRoutes> | null = null;

  async function ensureReady(): Promise<void> {
    if (mcpHandler !== null) return;
    const s = await getSession();
    const { operations, tools } = buildServices(s);
    mcpHandler = new MCPHandler(tools, logger);
    apiRoutes = createApiRoutes(operations, logger);
  }

  // HTTP Server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkApiToken(req, config.server.apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      // Health check (no session needed)
      if (url === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: session !== null ? 'healthy' : 'starting',
          version: '2.0.0',
          bc: { baseUrl: config.bc.baseUrl, tenantId: config.bc.tenantId },
        }));
        return;
      }

      // MCP endpoint
      if (url === '/mcp' && method === 'POST') {
        await ensureReady();
        const body = await parseJsonBody(req) as Parameters<MCPHandler['handleRequest']>[0];
        const response = await mcpHandler!.handleRequest(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // REST API routes
      await ensureReady();
      const routeKey = `${method} ${url.split('?')[0]}`;
      const handler = apiRoutes!.get(routeKey);
      if (handler) {
        const body = method === 'POST' ? await parseJsonBody(req) : {};
        await handler(req, res, body);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (e) {
      logger.error(`Request error: ${e instanceof Error ? e.message : String(e)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Internal error' }));
    }
  });

  server.listen(config.port, config.server.bindAddress, () => {
    logger.info(`BC MCP Server v2 listening on ${config.server.bindAddress}:${config.port}`);
    logger.info(`MCP endpoint: POST http://${config.server.bindAddress}:${config.port}/mcp`);
    logger.info(`REST API: POST http://${config.server.bindAddress}:${config.port}/api/v1/...`);
  });

  function shutdown(): void {
    logger.info('Shutting down...');
    if (session !== null) {
      session.close();
    }
    server.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
