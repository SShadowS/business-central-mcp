#!/usr/bin/env node
import { createInterface } from 'node:readline';
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
// isErr no longer needed — SessionManager handles session creation errors internally

async function main() {
  if (process.argv[2] === 'login') {
    const { runLoginCli } = await import('./cli/login.js');
    await runLoginCli(loadConfig());
    process.exit(process.exitCode ?? 0);
  }

  const config = loadConfig();
  // Logger already writes to stderr (via writeStderr in logger.ts) — stdout is sacred (JSON-RPC only)
  const logger = createLogger(config.logging);

  logger.info('BC MCP Server v2 (stdio) starting...');

  // Infrastructure
  const elicitationPort = new ClientElicitationPort();
  const { uiAuth, apiAuth } = composeAuthProviders(config, logger, elicitationPort);
  const connectionFactory = new ConnectionFactory(uiAuth, config.bc, logger);
  const queryOperation = createQueryOperation(config, apiAuth);

  // Protocol
  const decoder = new EventDecoder();
  const encoder = new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId);
  const pageContextRepo = new PageContextRepository();

  // Session — created lazily on first tools/call, with automatic recovery
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId, config.bc.invokeTimeoutMs, config.bc.profile,
  );
  const sessionManager = new SessionManager(sessionFactory, pageContextRepo, logger, {
    maxRetries: config.bc.reconnectMaxRetries,
    baseDelayMs: config.bc.reconnectBaseDelayMs,
  });

  let realTools: ReturnType<typeof buildToolRegistry> | null = null;

  // Services — built once after session is available
  function buildServices(s: BCSession): ReturnType<typeof buildToolRegistry> {
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

    return buildToolRegistry(operations);
  }

  // Build MCPHandler eagerly with lazy-executing tool wrappers.
  // Tool definitions (name, description, inputSchema, zodSchema) are static and
  // available immediately so initialize/tools/list work before any BC connection.
  // The execute functions call ensureSession() on first invocation.
  // SessionManager throws SessionLostError on recovery — MCPHandler catches it.

  async function ensureSession(): Promise<ReturnType<typeof buildToolRegistry>> {
    const s = await sessionManager.getSession();
    // Rebuild services if session was recreated
    if (realTools === null || sessionManager.needsServiceRebuild) {
      realTools = buildServices(s);
      sessionManager.markServicesRebuilt();
    }
    return realTools;
  }

  // Produce a static set of tool definitions whose execute functions delegate
  // lazily to the real operations (created on first tools/call).
  const staticTools = buildServices({} as BCSession);  // Only used to extract metadata
  const lazyTools = staticTools.map(toolDef => ({
    ...toolDef,
    execute: async (input: unknown) => {
      // bc_query talks to the OData API and must not require a /csh session.
      // SaaS OAuth can obtain an API token even when the first-party web-client
      // cookie session (needed for /csh) cannot be established.
      if (toolDef.name === 'bc_query') {
        return queryOperation.execute(input as Parameters<QueryOperation['execute']>[0]);
      }
      const tools = await ensureSession();
      const resolved = tools.find(t => t.name === toolDef.name);
      if (!resolved) throw new Error(`Tool not found after session init: ${toolDef.name}`);
      return resolved.execute(input);
    },
  }));

  const mcpHandler = new MCPHandler(lazyTools, logger, PROMPTS, { elicitationPort });

  // Read JSON-RPC from stdin, write responses to stdout
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    let id: unknown = undefined;
    try {
      const request = JSON.parse(line) as { jsonrpc: string; id: unknown; method: string; params?: unknown };
      id = request.id;

      const response = await mcpHandler.handleRequest(request);

      // Notifications (no id) don't get responses
      if (request.id !== undefined && request.id !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      if (id !== undefined && id !== null) {
        const errorResponse = {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  });

  rl.on('close', () => {
    logger.info('stdin closed, shutting down');
    sessionManager.close();
    process.exit(0);
  });

  function shutdown(): void {
    logger.info('Shutting down...');
    sessionManager.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
