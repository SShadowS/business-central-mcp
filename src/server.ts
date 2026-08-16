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
import { createQueryOperation } from './operations/query.js';
import { buildToolRegistry, type Operations } from './mcp/tool-registry.js';
import { MCPHandler } from './mcp/handler.js';
import { PROMPTS } from './mcp/prompts.js';
import { createApiRoutes } from './api/routes.js';
import { parseJsonBody, checkApiToken, bcErrorToHttp } from './api/middleware.js';
// isErr no longer needed — SessionManager handles session creation errors internally

/** The request-target's pathname: query stripped, trailing slashes trimmed,
 * absolute-form targets (proxy-style `http://host/mcp`) reduced to their
 * path. */
function requestPathname(url: string): string {
  let pathname = url.split('?')[0]!;
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch { /* keep the raw form */ }
  }
  return pathname.replace(/\/+$/, '') || '/';
}

/** The MCP endpoint by pathname — used by both the API-token 401 gate and
 * the router so they cannot drift. */
function isMcpPath(url: string): boolean {
  return requestPathname(url) === '/mcp';
}

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
    // Same-origin download guard must use the session's HTTP base (the tab
    // base on SaaS), not the portal baseUrl, or cluster DynamicFileHandler
    // URLs are misclassified as external and never fetched.
    const downloadService = new DownloadService(httpClient, connectionFactory.httpBaseUrl, config.bc.downloadLimits, logger);

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

  // MCP tools/list and session-independent tools (e.g. bc_query over OData)
  // must work before a /csh session exists. A session-independent tool's own
  // execute already reaches BC without a session, so run it directly.
  const staticBuild = buildServices({} as BCSession);
  const staticTools = staticBuild.tools;
  // Route KEYS are static (only the handlers need a session): knowing them
  // up front lets the server 404 unknown paths WITHOUT creating a BC
  // session — otherwise any stray request (a LAN scanner's GET /favicon.ico)
  // could pop the interactive SaaS sign-in window on the host.
  const knownRouteKeys = new Set(createApiRoutes(staticBuild.operations, logger).keys());
  const lazyTools = staticTools.map(toolDef => ({
    ...toolDef,
    execute: async (input: unknown) => {
      if (toolDef.sessionIndependent) {
        return toolDef.execute(input);
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
      // WWW-Authenticate marks this 401 as an API-token failure; BC-side
      // sign-in 401s from bcErrorToHttp carry a `code` field and no
      // WWW-Authenticate, so REST clients/gateways can tell them apart and
      // not rotate a valid API token over an expired BC session. NOT sent on
      // /mcp: MCP streamable-HTTP clients treat 401 + WWW-Authenticate as
      // the trigger for RFC 9728 OAuth discovery, which this server does not
      // serve.
      // Shared predicate with the router below — the two must agree, or
      // /mcp-adjacent paths get inconsistent 401 shapes and MCP clients see
      // a WWW-Authenticate that triggers OAuth discovery this server does
      // not serve.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (!isMcpPath(req.url ?? '')) {
        headers['WWW-Authenticate'] = 'Bearer realm="bc-mcp-api-token"';
      }
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      // Health check (no session needed). Matched by pathname: a query
      // string (`/health?ts=1`) must not slip past this into the REST
      // section, whose duplicate 'GET /health' route would create a BC
      // session for an unauthenticated monitoring probe.
      if (requestPathname(url) === '/health' && method === 'GET') {
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
      if (isMcpPath(url) && method === 'POST') {
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

      // Non-POST /mcp (e.g. an MCP client's GET SSE probe) must not fall
      // into the REST section: session-creation errors there map to 401,
      // which MCP streamable-HTTP clients treat as an OAuth-discovery
      // trigger this server does not serve.
      if (isMcpPath(url)) {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'Method not allowed; the MCP endpoint accepts POST only' }));
        return;
      }

      // REST API routes — resolve the route BEFORE creating a session, so
      // unknown paths 404 without side effects. Same normalization as
      // /health and /mcp: one rule for every endpoint.
      const routeKey = `${method} ${requestPathname(url)}`;
      if (!knownRouteKeys.has(routeKey)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      await ensureReady();
      const handler = apiRoutes!.get(routeKey)!;
      const body = method === 'POST' ? await parseJsonBody(req) : {};
      await handler(req, res, body);

    } catch (e) {
      logger.error(`Request error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        const { status, body } = bcErrorToHttp(e);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
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
