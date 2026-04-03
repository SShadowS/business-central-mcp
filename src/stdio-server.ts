import { createInterface } from 'node:readline';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { NTLMAuthProvider } from './connection/auth/ntlm-provider.js';
import { ConnectionFactory } from './connection/connection-factory.js';
import { EventDecoder } from './protocol/event-decoder.js';
import { InteractionEncoder } from './protocol/interaction-encoder.js';
import { StateProjection } from './protocol/state-projection.js';
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
import { buildToolRegistry, type Operations } from './mcp/tool-registry.js';
import { MCPHandler } from './mcp/handler.js';
import { isErr } from './core/result.js';

dotenvConfig();

async function main() {
  const config = loadConfig();
  // Logger already writes to stderr (via writeStderr in logger.ts) — stdout is sacred (JSON-RPC only)
  const logger = createLogger(config.logging);

  logger.info('BC MCP Server v2 (stdio) starting...');

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
  const stateProjection = new StateProjection();
  const pageContextRepo = new PageContextRepository(stateProjection);

  // Session — created lazily on first tools/call
  const sessionFactory = new SessionFactory(
    connectionFactory, decoder, encoder, logger, config.bc.tenantId,
  );

  let session: BCSession | null = null;
  let realTools: ReturnType<typeof buildToolRegistry> | null = null;

  async function getSession(): Promise<BCSession> {
    // If session exists and is alive, reuse it
    if (session !== null && session.isAlive) return session;

    // Session is dead or doesn't exist — tear down and recreate
    if (session !== null) {
      logger.info('Session is dead, closing and recreating...');
      session.close();
      session = null;
      realTools = null;  // Services reference the old session — must rebuild
    }

    const result = await sessionFactory.create();
    if (isErr(result)) throw new Error(`Session creation failed: ${result.error.message}`);
    session = result.value;
    logger.info('BC session established');
    return session;
  }

  // Services — built once after session is available
  function buildServices(s: BCSession): ReturnType<typeof buildToolRegistry> {
    const pageService = new PageService(s, pageContextRepo, logger);
    const dataService = new DataService(s, pageContextRepo, logger);
    const actionService = new ActionService(s, pageContextRepo, logger);
    const filterService = new FilterService(s, pageContextRepo, logger);
    const navigationService = new NavigationService(s, pageContextRepo, logger);
    const searchService = new SearchService(s, logger);

    const operations: Operations = {
      openPage: new OpenPageOperation(pageService),
      readData: new ReadDataOperation(dataService, filterService),
      writeData: new WriteDataOperation(dataService),
      executeAction: new ExecuteActionOperation(actionService),
      closePage: new ClosePageOperation(pageService),
      searchPages: new SearchPagesOperation(searchService),
      navigate: new NavigateOperation(navigationService),
    };

    return buildToolRegistry(operations);
  }

  // Build MCPHandler eagerly with lazy-executing tool wrappers.
  // Tool definitions (name, description, inputSchema, zodSchema) are static and
  // available immediately so initialize/tools/list work before any BC connection.
  // The execute functions call ensureSession() on first invocation.

  async function ensureSession(): Promise<ReturnType<typeof buildToolRegistry>> {
    const s = await getSession();
    // Rebuild services if session was recreated (realTools nulled in getSession)
    if (realTools === null) {
      realTools = buildServices(s);
    }
    return realTools;
  }

  // Produce a static set of tool definitions whose execute functions delegate
  // lazily to the real operations (created on first tools/call).
  const staticTools = buildServices({} as BCSession);  // Only used to extract metadata
  const lazyTools = staticTools.map(toolDef => ({
    ...toolDef,
    execute: async (input: unknown) => {
      const tools = await ensureSession();
      const resolved = tools.find(t => t.name === toolDef.name);
      if (!resolved) throw new Error(`Tool not found after session init: ${toolDef.name}`);
      return resolved.execute(input);
    },
  }));

  const mcpHandler = new MCPHandler(lazyTools, logger);

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
    session?.close();
    process.exit(0);
  });

  function shutdown(): void {
    logger.info('Shutting down...');
    session?.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[FATAL] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
