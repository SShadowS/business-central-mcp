import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { findField } from '../../src/protocol/form-views.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

// A NavigatePage whose step 2 hosts a ListPart (no SubPageLink, blank caption). Needs the
// fixture app tests/integration/fixtures/al/wizard-part (pages 50990/50991) on Cronus28;
// skips when it is not installed. Read-only: the wizard writes nothing.
describe.sequential('Wizard with a list part on a hidden step (fixture page 50990)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pages: PageService;
  let actions: ActionService;
  let pcId: string | undefined;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pages = new PageService(session, repo, logger);
    actions = new ActionService(session, repo, logger);
  });

  afterAll(async () => {
    if (pcId) { try { await pages.closePage(pcId, { discardChanges: true }); } catch { /* ignore */ } }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('exposes the part as a lines section with rows, through Next, and Next reads its current row', async () => {
    const open = await pages.openPage('50990');
    if (!isOk(open)) { console.error('Skip: fixture page 50990 not installed:', open.error.message); return; }
    pcId = open.value.pageContextId;
    expect(open.value.pageType).toBe('NavigatePage');

    const lines = open.value.sections.get('lines');
    expect(lines?.repeaterControlPath).toBeDefined();
    // Blank part caption falls back to the part's AL control name.
    expect(lines?.caption).toBe('SetupBankAccountList');

    const step1 = buildSection(repo.get(pcId)!, 'lines')!;
    expect(step1.rows?.length ?? 0).toBeGreaterThan(0);
    const firstNo = step1.rows![0]!.cells['No.'];
    expect(firstNo).toBeTruthy();

    unwrap(await actions.executeWizardNav(pcId, 'next')); // -> step 2, part visible
    const step2 = buildSection(repo.get(pcId)!, 'lines')!;
    expect(step2.rows?.length).toBe(step1.rows!.length);

    unwrap(await actions.executeWizardNav(pcId, 'next')); // -> step 3, reads the part's current row
    const ctx = repo.get(pcId)!;
    const root = ctx.forms.get(ctx.rootFormId)!.root;
    expect(findField(root, 'Selected Bank Account')?.properties.stringValue).toBe(firstNo);

    // BC's own Close (systemAction 350) closes the wizard: State 0 on the root only.
    unwrap(await actions.executeWizardNav(pcId, 'cancel'));
    const closed = repo.get(pcId)!;
    expect([...closed.sections.values()].map(s => `${s.sectionId}:${s.valid}`)).toEqual(['header:false', 'lines:false']);
    pcId = undefined;
  }, 90000);
});
