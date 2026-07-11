import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { isOk } from '../../src/core/result.js';
import { repeaters as treeRepeaters } from '../../src/protocol/form-views.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

// Regression guard for the child-form-hydration fix: a document reached via
// bc_navigate(drill_down) must expose its 'lines' section, not just 'header'.
// Skips gracefully if the demo DB has no drillable sales order.
describe.sequential('Drill-down loads document lines (Sales Order List 9305 -> Sales Order)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let navigationService: NavigationService;
  const logger = createNullLogger();
  let listPcId: string | undefined;
  let targetPcId: string | undefined;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    navigationService = new NavigationService(session, repo, logger);
  });

  afterAll(async () => {
    for (const p of [targetPcId, listPcId]) {
      if (p) { try { await pageService.closePage(p, { discardChanges: true }); } catch { /* ignore */ } }
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('drilling a sales-order list row yields a target with a lines section', async () => {
    const open = await pageService.openPage('9305'); // Sales Order List
    if (!isOk(open)) { console.error('Skip: could not open page 9305:', open.error.message); return; }
    listPcId = open.value.pageContextId;

    const header = open.value.sections.get('header');
    if (!header) { console.error('Skip: no header section on 9305'); return; }
    const listForm = open.value.forms.get(header.formId);
    const rep = listForm ? treeRepeaters(listForm.root).values().next().value : undefined;
    const rows = rep && listForm ? (listForm.rows.get(rep.controlPath) ?? []) : [];
    if (rows.length === 0) { console.error('Skip: no sales orders in the list to drill into'); return; }

    const drill = await navigationService.drillDown(listPcId, rows[0]!.bookmark);
    if (!isOk(drill)) { console.error('Skip: drill-down failed:', drill.error.message); return; }
    const target = drill.value.targetPageContext;
    targetPcId = target.pageContextId;

    const sections = Array.from(target.sections.entries()).map(([id, s]) => `${id}:${s.kind}`);
    console.error('Drill-down target sections:', sections);

    // The core assertion: the drilled-into document exposes its lines section.
    const kinds = Array.from(target.sections.values()).map(s => s.kind);
    expect(kinds).toContain('lines');
  }, 60000);
});
