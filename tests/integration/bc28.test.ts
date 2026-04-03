import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { derivePageState } from '../../src/protocol/types.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { isOk, unwrap } from '../../src/core/result.js';
import type { BCConfig } from '../../src/core/config.js';

const BC28_CONFIG: BCConfig = {
  baseUrl: 'http://cronus28/BC',
  username: 'sshadows',
  password: '1234',
  tenantId: 'default',
  clientVersionString: '28.0.0.0',
  serverMajor: 28,
  timeoutMs: 120000,
};

describe('BC28 Compatibility (integration)', () => {
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  const logger = createNullLogger();

  beforeAll(async () => {
    const auth = new NTLMAuthProvider({
      baseUrl: BC28_CONFIG.baseUrl,
      username: BC28_CONFIG.username,
      password: BC28_CONFIG.password,
      tenantId: BC28_CONFIG.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, BC28_CONFIG, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(BC28_CONFIG.clientVersionString);
    const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, BC28_CONFIG.tenantId);

    const result = await sessionFactory.create();
    expect(isOk(result)).toBe(true);
    session = unwrap(result);

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    dataService = new DataService(session, repo, logger);
  }, 60000);

  afterAll(async () => {
    await session?.closeGracefully().catch(() => {});
  });

  it('connects and establishes session on BC28', () => {
    expect(session.isAlive).toBe(true);
    console.error('[BC28] Session established');
  });

  it('opens Customer List (page 22) with fields and rows', async () => {
    const result = await pageService.openPage('22', { tenantId: BC28_CONFIG.tenantId });
    expect(isOk(result)).toBe(true);
    const state = derivePageState(unwrap(result));

    console.error('[BC28] Page 22:', {
      pageType: state.pageType,
      fields: state.controlTree.length,
      actions: state.actions.length,
      rows: state.repeater?.rows.length ?? 0,
      columns: state.repeater?.columns.length ?? 0,
    });

    expect(state.formId).toBeTruthy();
    expect(state.pageType).toBe('List');
    expect(state.controlTree.length).toBeGreaterThan(0);
  }, 30000);

  it('opens Customer Card (page 21) with fields', async () => {
    const result = await pageService.openPage('21', { tenantId: BC28_CONFIG.tenantId });
    expect(isOk(result)).toBe(true);
    const state = derivePageState(unwrap(result));

    console.error('[BC28] Page 21:', {
      pageType: state.pageType,
      fields: state.controlTree.length,
      actions: state.actions.length,
      sampleFields: state.controlTree
        .filter(f => f.caption)
        .slice(0, 5)
        .map(f => `${f.caption}: ${f.stringValue ?? '(empty)'}`),
    });

    expect(state.formId).toBeTruthy();
    expect(state.pageType).toBe('Card');
    expect(state.controlTree.length).toBeGreaterThan(10);
  }, 30000);

  it('reads data rows from Customer List', async () => {
    const openResult = await pageService.openPage('22', { tenantId: BC28_CONFIG.tenantId });
    expect(isOk(openResult)).toBe(true);
    const state = derivePageState(unwrap(openResult));

    const rowsResult = dataService.readRows(state.pageContextId);
    expect(isOk(rowsResult)).toBe(true);
    const rows = unwrap(rowsResult);

    console.error(`[BC28] Customer List: ${rows.length} rows`);
    if (rows.length > 0) {
      console.error('[BC28] First row cells:', Object.keys(rows[0]!.cells).length, 'columns');
    }

    expect(rows.length).toBeGreaterThan(0);
  }, 30000);
});
