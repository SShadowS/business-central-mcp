// tests/integration/role-center.test.ts
//
// Plan C Task 9 - live verification of Role Center cuegroup support
// against BC28 BUSINESS MANAGER profile.
//
// Verifies end-to-end:
// - bc_open_page on the role center returns hosted-CardPart sections.
// - At least one section carries cues[] populated.
// - Cue values are populated (after the LoadForm + Refresh chain in
//   PageService.discoverAndLoadChildForms).
// - bc_execute_action with cue input drills down and returns the new page.
//
// Note on section classification: hosted CardParts on a Role Center arrive
// on the wire as `IsSubForm=false / IsPart=true`, which page-context-repo
// classifies as `factbox` (the same bucket used for sidebar FactBoxes on
// Card pages). They are conceptually the role-center body, not factboxes,
// but the wire shape doesn't distinguish; the kind is `factbox` even though
// the section IDs look like `factbox:Activities`. This test treats both
// `subpage` and `factbox` sections as candidate Role Center children.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { NavigationService } from '../../src/services/navigation-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import type { Section } from '../../src/protocol/section-dto.js';
import { loadConfig } from '../../src/core/config.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

// BUSINESS MANAGER profile's default Role Center on a fresh BC28 install is
// page 9022 ("Business Manager Role Center" -- DesignName confirmed via the
// fixture in src/protocol/captures/cuegroup-rolecenter-2026-04-28.json).
// PageService.openPage('') would emit a `page=&tenant=...` query which BC
// won't resolve to the default RC; passing the explicit page id mirrors the
// known-good fallback used by scripts/capture-rolecenter.ts.
const ROLE_CENTER_PAGE_ID = '9022';

/** Sections that hold Role Center hosted CardParts (subpage OR factbox). */
function hostedSections(sections: readonly Section[]): Section[] {
  return sections.filter(s => s.kind === 'subpage' || s.kind === 'factbox');
}

describe('Role Center cues live (BC28 BUSINESS MANAGER)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let openPage: OpenPageOperation;
  let executeAction: ExecuteActionOperation;

  beforeAll(async () => {
    lease = await integrationPool.checkOut({ profile: 'BUSINESS MANAGER' });
    session = lease.session;
    const logger = createNullLogger();
    const repo = new PageContextRepository();
    const pageService = new PageService(session, repo, logger);
    const actionService = new ActionService(session, repo, logger);
    const navigationService = new NavigationService(session, repo, logger);
    openPage = new OpenPageOperation(pageService);
    const cfg = loadConfig();
    executeAction = new ExecuteActionOperation(actionService, repo, navigationService, stubDownloadService(logger), cfg.bc.maxSelection);
  }, 60_000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('Role Center opens with hosted CardParts as sections', async () => {
    const result = await openPage.execute({ pageId: ROLE_CENTER_PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pageType).toBe('RoleCenter');

    const hosted = hostedSections(result.value.sections);
    expect(hosted.length).toBeGreaterThan(0);
    console.error(`[RC] Found ${hosted.length} hosted-CardPart sections: ${hosted.map(s => `${s.kind}:${s.caption}`).join(', ')}`);
  }, 60_000);

  it('At least one Role Center section carries cues[]', async () => {
    const result = await openPage.execute({ pageId: ROLE_CENTER_PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sectionsWithCues = hostedSections(result.value.sections)
      .filter(s => (s.cues?.length ?? 0) > 0);
    console.error(`[RC] Sections with cues: ${sectionsWithCues.map(s => `${s.caption}(${s.cues!.length})`).join(', ')}`);
    expect(sectionsWithCues.length, 'expected at least one Role Center section with cues').toBeGreaterThan(0);

    // Sample one cue and verify its shape
    const sample = sectionsWithCues[0]!.cues![0]!;
    expect(sample.name).toBeTruthy();
    expect(typeof sample.value).toBe('string');
    expect(typeof sample.hasAction).toBe('boolean');
  }, 60_000);

  it('Cue values are populated (non-stub) after auto-load refresh', async () => {
    const result = await openPage.execute({ pageId: ROLE_CENTER_PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const allCues = hostedSections(result.value.sections)
      .flatMap(s => s.cues ?? []);

    // Some cues will be "0" (zero counts), some non-zero. We don't require
    // a specific value -- just verify that the values aren't all empty strings,
    // which would indicate the LoadForm/Refresh chain isn't running.
    const populated = allCues.filter(c => c.value !== '');
    console.error(`[RC] ${populated.length} of ${allCues.length} cues have populated values`);
    expect(populated.length, 'expected at least one cue with a populated value').toBeGreaterThan(0);
  }, 60_000);

  it('bc_execute_action with cue drill-down opens the underlying list', async () => {
    const open = await openPage.execute({ pageId: ROLE_CENTER_PAGE_ID });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    // Find a drill-downable cue across all hosted-CardPart sections.
    const sectionsWithCues = hostedSections(open.value.sections)
      .filter(s => (s.cues?.length ?? 0) > 0);
    let target: { sectionId: string; cueName: string } | null = null;
    for (const sp of sectionsWithCues) {
      const drillable = sp.cues!.find(c => c.hasAction);
      if (drillable) {
        target = { sectionId: sp.sectionId, cueName: drillable.name };
        break;
      }
    }
    expect(target, 'expected at least one drill-downable cue across hosted CardParts').toBeTruthy();
    if (!target) return;

    console.error(`[RC] Drilling: section=${target.sectionId}, cue=${target.cueName}`);
    const drill = await executeAction.execute({
      pageContextId: open.value.pageContextId,
      section: target.sectionId,
      cue: target.cueName,
    });
    expect(drill.ok).toBe(true);
    if (!drill.ok) return;
    expect(drill.value.openedPages.length, 'cue drill-down should open a page').toBeGreaterThan(0);
    console.error(`[RC] Opened: ${drill.value.openedPages.map(p => p.caption).join(', ')}`);
  }, 60_000);
});
