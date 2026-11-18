import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { isOk } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

// ListPart FactBoxes: the fixture app tests/integration/fixtures/al/wizard-part (1.1+) adds page
// 50992 "Bank Connection" first in the factboxes of the Bank Account Card (370) and the Bank
// Accounts list (371), next to the Notes system part. Both parts are repeater-only and BC sends
// both parts' rows on the host's formId at `server:c[0]`. Skips when the fixture is missing.
describe.sequential('ListPart FactBoxes on Bank Account Card / List (fixture page 50992)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pages: PageService;
  let nav: NavigationService;
  const opened: string[] = [];
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pages = new PageService(session, repo, logger);
    nav = new NavigationService(session, repo, logger);
  });

  afterAll(async () => {
    for (const id of opened) { try { await pages.closePage(id, { discardChanges: true }); } catch { /* ignore */ } }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  for (const pageId of ['370', '371']) {
    it(`page ${pageId} exposes each ListPart FactBox with its own rows`, async () => {
      const open = await pages.openPage(pageId);
      expect(isOk(open)).toBe(true);
      if (!isOk(open)) return;
      opened.push(open.value.pageContextId);
      const ctx = repo.get(open.value.pageContextId)!;
      if (!ctx.sections.has('factbox:Bank Connection')) { console.error('Skip: fixture page 50992 not installed'); return; }

      const bank = buildSection(ctx, 'factbox:Bank Connection')!;
      expect(bank.rows?.length).toBe(1); // SubPageLink "No." = field("No.")
      const notes = ctx.sections.get('factbox:Notes');
      expect(notes?.valid).toBe(true);
      expect(buildSection(ctx, 'factbox:Notes')!.rows ?? []).toHaveLength(0);
    }, 60000);
  }

  it('page 371: selecting another list row moves the ListPart FactBox to that record', async () => {
    const open = await pages.openPage('371');
    expect(isOk(open)).toBe(true);
    if (!isOk(open)) return;
    const pcId = open.value.pageContextId;
    opened.push(pcId);
    if (!repo.get(pcId)!.sections.has('factbox:Bank Connection')) { console.error('Skip: fixture page 50992 not installed'); return; }

    const list = buildSection(repo.get(pcId)!, 'header')!;
    expect(list.rows!.length).toBeGreaterThan(1);
    const second = list.rows![1]!;
    expect(isOk(await nav.selectRow(pcId, second.bookmark))).toBe(true);
    const bank = buildSection(repo.get(pcId)!, 'factbox:Bank Connection')!;
    expect(bank.rows?.map(r => r.cells['No.'])).toEqual([second.cells['No.']]);
  }, 60000);
});
