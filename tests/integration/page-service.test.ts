import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { derivePageState } from '../../src/protocol/types.js';
import { PageService } from '../../src/services/page-service.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('PageService (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
  });

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('opens Customer List (page 22) and returns PageState', async () => {
    const result = await pageService.openPage('22');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const state = derivePageState(result.value);
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
      const state = derivePageState(result.value);
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
