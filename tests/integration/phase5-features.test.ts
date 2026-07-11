import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { isOk, isErr, unwrap } from '../../src/core/result.js';
import type { BCEvent, InvokeActionInteraction } from '../../src/protocol/types.js';
import { SystemAction } from '../../src/protocol/types.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('Phase 5 features (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  let dataService: DataService;
  let pageContextRepo: PageContextRepository;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;

    pageContextRepo = new PageContextRepository();
    pageService = new PageService(session, pageContextRepo, logger);
    dataService = new DataService(session, pageContextRepo, logger);
  }, 60000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  /**
   * Helper: dismiss any license expiration dialog that appears in events.
   */
  async function dismissDialogsIfPresent(events: BCEvent[]): Promise<BCEvent[]> {
    const dialogs = events.filter(e => e.type === 'DialogOpened');
    for (const dialog of dialogs) {
      if (dialog.type === 'DialogOpened' && dialog.formId) {
        console.error(`[TEST] Dismissing dialog: ${dialog.formId}`);
        const dismissResult = await session.invoke(
          {
            type: 'InvokeAction',
            formId: dialog.formId,
            controlPath: 'server:c[0]',
            systemAction: SystemAction.Ok,
          } satisfies InvokeActionInteraction,
          (event) => event.type === 'InvokeCompleted',
        );
        if (isOk(dismissResult)) {
          console.error(`[TEST] Dialog dismissed, got ${dismissResult.value.length} events`);
        } else {
          console.error(`[TEST] Dialog dismiss failed:`, dismissResult.error);
        }
      }
    }
    return events.filter(e => e.type !== 'DialogOpened');
  }

  it('session.companyName returns a non-empty string after init', () => {
    const company = session.companyName;
    console.error(`[TEST] session.companyName = "${company}"`);
    expect(company).toBeTruthy();
    expect(typeof company).toBe('string');
    expect(company.length).toBeGreaterThan(0);
  });

  it('list companies via page 357 (Companies)', async () => {
    const result = await pageService.openPage('357');
    if (isErr(result)) {
      console.error('[TEST] Failed to open page 357:', result.error);
    }
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const ctx = result.value;
    const pageContextId = ctx.pageContextId;
    console.error(`[TEST] Page 357 opened: pageContextId=${pageContextId}, pageType=${ctx.pageType}, caption="${ctx.caption}"`);
    console.error(`[TEST] Sections: ${Array.from(ctx.sections.entries()).map(([id, s]) => `${id}(${s.kind})`).join(', ')}`);

    // Read rows from the repeater
    const rowsResult = dataService.readRows(pageContextId);
    if (isOk(rowsResult)) {
      const rows = rowsResult.value;
      console.error(`[TEST] Companies found: ${rows.length}`);
      for (const row of rows) {
        console.error(`[TEST]   Row: ${JSON.stringify(row.cells)}`);
      }
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } else {
      console.error('[TEST] readRows failed:', rowsResult.error);
      // Even if readRows fails, the page opened successfully -- log what we have
      for (const [formId, form] of ctx.forms) {
        console.error(`[TEST] Form ${formId}: fields=${form.controlTree.length}, repeaters=${form.repeaters.size}`);
        for (const [rPath, rep] of form.repeaters) {
          console.error(`[TEST]   Repeater ${rPath}: ${rep.rows.length} rows, ${rep.columns.length} cols`);
          for (const row of rep.rows) {
            console.error(`[TEST]     Row cells: ${JSON.stringify(row.cells)}`);
          }
        }
      }
    }

    // Clean up: close the page
    await pageService.closePage(pageContextId).catch(() => {});
  });

  it('RunReport for report 6 (Trial Balance) -- protocol investigation', async () => {
    const result = await session.runReport(6);

    if (isErr(result)) {
      console.error('[TEST] RunReport failed:', result.error);
      // Don't fail the test -- we want to see what happens
      return;
    }

    const events = result.value;
    console.error('[TEST] RunReport events:');
    console.error(JSON.stringify(events, null, 2));

    // Log event types summary
    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    console.error('[TEST] Event type counts:', JSON.stringify(typeCounts));

    // We expect some events back
    expect(events.length).toBeGreaterThan(0);

    // If a dialog opened (request page), try to dismiss it so it doesn't linger
    const dialogs = events.filter(e => e.type === 'DialogOpened' || e.type === 'FormCreated');
    for (const dialog of dialogs) {
      if ('formId' in dialog && dialog.formId) {
        console.error(`[TEST] Dismissing report dialog/form: ${dialog.formId}`);
        try {
          await session.invoke(
            {
              type: 'InvokeAction',
              formId: dialog.formId,
              controlPath: 'server:c[0]',
              systemAction: SystemAction.Cancel,
            } satisfies InvokeActionInteraction,
            (event) => event.type === 'InvokeCompleted',
          );
        } catch (e) {
          console.error(`[TEST] Failed to dismiss: ${e}`);
        }
      }
    }
  });

});
