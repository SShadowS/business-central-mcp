import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { StateProjection } from '../../src/protocol/state-projection.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { isOk, unwrap } from '../../src/core/result.js';

dotenvConfig();

describe('PageService (integration)', () => {
  let session: BCSession;
  let pageService: PageService;
  const logger = createNullLogger();

  beforeAll(async () => {
    const appConfig = loadConfig();
    const auth = new NTLMAuthProvider({
      baseUrl: appConfig.bc.baseUrl,
      username: appConfig.bc.username,
      password: appConfig.bc.password,
      tenantId: appConfig.bc.tenantId,
    }, logger);
    const connFactory = new ConnectionFactory(auth, appConfig.bc, logger);
    const decoder = new EventDecoder();
    const encoder = new InteractionEncoder(appConfig.bc.clientVersionString);
    const sessionFactory = new SessionFactory(connFactory, decoder, encoder, logger, appConfig.bc.tenantId);

    const result = await sessionFactory.create();
    session = unwrap(result);

    const projection = new StateProjection();
    const repo = new PageContextRepository(projection);
    pageService = new PageService(session, repo, logger);
  });

  afterAll(() => {
    session?.close();
  });

  it('opens Customer List (page 22) and returns PageState', async () => {
    const result = await pageService.openPage('22');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const state = result.value;
      console.error('Page 22 PageState:', JSON.stringify({
        pageContextId: state.pageContextId,
        formId: state.formId,
        pageType: state.pageType,
        controlTreeSize: state.controlTree.length,
        repeaterRows: state.repeater?.rows.length ?? 0,
        childForms: state.childForms.length,
        dialogs: state.dialogs.length,
        openFormIds: state.openFormIds,
        firstFields: state.controlTree.slice(0, 5).map(f => ({ caption: f.caption, path: f.controlPath, value: f.stringValue })),
      }, null, 2));

      expect(state.formId).toBeTruthy();
      expect(state.pageContextId).toContain('page:22');
    }
  });

  it('opens Customer Card (page 21) and returns PageState with fields', async () => {
    const result = await pageService.openPage('21');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const state = result.value;
      console.error('Page 21 PageState:', JSON.stringify({
        pageContextId: state.pageContextId,
        formId: state.formId,
        controlTreeSize: state.controlTree.length,
        repeaterRows: state.repeater?.rows.length ?? 0,
        firstFields: state.controlTree.slice(0, 10).map(f => ({
          caption: f.caption,
          path: f.controlPath,
          value: f.stringValue,
          editable: f.editable,
        })),
      }, null, 2));

      expect(state.formId).toBeTruthy();
    }
  });
});
