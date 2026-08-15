import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { composeAuthProviders } from './connection/auth/create-auth-provider.js';
import { ClientElicitationPort } from './mcp/elicitation-port.js';
import { ConnectionFactory } from './connection/connection-factory.js';
import { EventDecoder } from './protocol/event-decoder.js';
import { InteractionEncoder } from './protocol/interaction-encoder.js';
import { PageContextRepository } from './protocol/page-context-repo.js';
import { SessionFactory } from './session/session-factory.js';
import { SessionManager } from './session/session-manager.js';
import type { BCSession } from './session/bc-session.js';
import { PageService } from './services/page-service.js';
import { DataService } from './services/data-service.js';
import { ActionService } from './services/action-service.js';
import { FilterService } from './services/filter-service.js';
import { SortService } from './services/sort-service.js';
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
import { SwitchCompanyOperation } from './operations/switch-company.js';
import { ListCompaniesOperation } from './operations/list-companies.js';
import { RunReportOperation } from './operations/run-report.js';
import { WizardNavigateOperation } from './operations/wizard-navigate.js';
import { DownloadService } from './services/download-service.js';
import { LookupService } from './services/lookup-service.js';
import { LookupOperation } from './operations/lookup.js';
import { QueryOperation, createQueryOperation } from './operations/query.js';
import { buildToolRegistry, type Operations } from './mcp/tool-registry.js';
import { MCPHandler } from './mcp/handler.js';
import { PROMPTS } from './mcp/prompts.js';
import { createApiRoutes } from './api/routes.js';
import { parseJsonBody, checkApiToken } from './api/middleware.js';
// isErr no longer needed — SessionManager handles session creation errors internally

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  logger.info('Starting BC MCP Server v2...');

  // Infrastructure
  const elicitationPort = new ClientElicitationPort();
  const { uiAuth, apiAuth } = composeAuthProviders(config, logger, elicitationPort);
  const connectionFactory = new ConnectionFactory(uiAuth, config.bc, logger);
  const queryOperation = createQueryOperation(config, apiAuth);

  // Protocol
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId);
  const pageContextRepo = new PageContextRepository();

  // Session — created lazily on first request, with automatic recovery
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId, config.bc.invokeTimeoutMs, config.bc.profile,
    () => uiAuth.getSessionTenantId?.() ?? config.bc.tenantId,
  );
  const sessionManager = new SessionManager(sessionFactory, pageContextRepo, logger, {
    maxRetries: config.bc.reconnectMaxRetries,
    baseDelayMs: config.bc.reconnectBaseDelayMs,
  });

  // Services — built once after session is available
  function buildServices(s: BCSession): { operations: Operations; tools: ReturnType<typeof buildToolRegistry> } {
    const pageService = new PageService(s, pageContextRepo, logger);
    const dataService = new DataService(s, pageContextRepo, logger);
    const actionService = new ActionService(s, pageContextRepo, logger);
    const filterService = new FilterService(s, pageContextRepo, logger);
    const sortService = new SortService(s, pageContextRepo, logger);
    const navigationService = new NavigationService(s, pageContextRepo, logger);
    const searchService = new SearchService(s, logger);
    const lookupService = new LookupService(s, pageContextRepo, logger);
    const httpClient = connectionFactory.createHttpClient();
    const downloadService = new DownloadService(httpClient, config.bc.baseUrl, config.bc.downloadLimits, logger);

    const operations: Operations = {
      openPage: new OpenPageOperation(pageService),
      readData: new ReadDataOperation(dataService, filterService, sortService, pageContextRepo),
      writeData: new WriteDataOperation(dataService, pageContextRepo),
      executeAction: new ExecuteActionOperation(actionService, pageContextRepo, navigationService, downloadService, config.bc.maxSelection),
      closePage: new ClosePageOperation(pageService),
      searchPages: new SearchPagesOperation(searchService),
      navigate: new NavigateOperation(navigationService),
      respondDialog: new RespondDialogOperation(s, pageContextRepo, downloadService),
      switchCompany: new SwitchCompanyOperation(s, pageContextRepo, logger),
      listCompanies: new ListCompaniesOperation(pageService, dataService, () => s.companyName, logger),
      runReport: new RunReportOperation(s, pageContextRepo, downloadService),
      wizardNavigate: new WizardNavigateOperation(actionService, pageContextRepo, downloadService),
      lookup: new LookupOperation(lookupService),
      query: queryOperation,
    };

    return { operations, tools: buildToolRegistry(operations) };
  }

  let realTools: ReturnType<typeof buildToolRegistry> | null = null;
  let apiRoutes: ReturnType<typeof createApiRoutes> | null = null;

  async function ensureSessionTools(): Promise<ReturnType<typeof buildToolRegistry>> {
    const s = await sessionManager.getSession();
    if (realTools === null || sessionManager.needsServiceRebuild) {
      const built = buildServices(s);
      realTools = built.tools;
      apiRoutes = createApiRoutes(built.operations, logger);
      sessionManager.markServicesRebuilt();
    }
    return realTools;
  }

  async function ensureReady(): Promise<void> {
    await ensureSessionTools();
  }

  // MCP tools/list and bc_query must work before a /csh session exists
  // (SaaS OAuth can serve OData without the first-party web-client cookie).
  const staticTools = buildServices({} as BCSession).tools;
  const lazyTools = staticTools.map(toolDef => ({
    ...toolDef,
    execute: async (input: unknown) => {
      if (toolDef.name === 'bc_query') {
        return queryOperation.execute(input as Parameters<QueryOperation['execute']>[0]);
      }
      const tools = await ensureSessionTools();
      const resolved = tools.find(t => t.name === toolDef.name);
      if (!resolved) throw new Error(`Tool not found after session init: ${toolDef.name}`);
      return resolved.execute(input);
    },
  }));
  const mcpHandler = new MCPHandler(lazyTools, logger, PROMPTS, { elicitationPort });

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
          status: sessionManager.currentSession !== null ? 'healthy' : 'starting',
          version: '2.0.0',
          bc: {
            baseUrl: config.bc.baseUrl,
            tenantId: config.bc.tenantId,
            authMode: config.bc.authMode,
            environment: config.bc.environmentName,
            webSession: uiAuth.isAuthenticated(),
          },
        }));
        return;
      }

      // MCP endpoint
      if (url === '/mcp' && method === 'POST') {
        const body = await parseJsonBody(req) as Parameters<MCPHandler['handleRequest']>[0];
        const response = await mcpHandler.handleRequest(body);
        // JSON-RPC notifications have no id; per spec they must not receive a
        // response body (stdio-server.ts suppresses these the same way).
        if (response.id == null) {
          res.writeHead(202);
          res.end();
          return;
        }
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
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Internal error' }));
      } else {
        res.destroy();
      }
    }
  });

  server.listen(config.port, config.server.bindAddress, () => {
    logger.info(`BC MCP Server v2 listening on ${config.server.bindAddress}:${config.port}`);
    logger.info(`MCP endpoint: POST http://${config.server.bindAddress}:${config.port}/mcp`);
    logger.info(`REST API: POST http://${config.server.bindAddress}:${config.port}/api/v1/...`);
  });

  function shutdown(): void {
    logger.info('Shutting down...');
    sessionManager.close();
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
