import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { isOk, isErr } from '../../src/core/result.js';
import type { BCEvent, OpenFormInteraction, InvokeActionInteraction } from '../../src/protocol/types.js';
import { SystemAction } from '../../src/protocol/types.js';

describe('BCSession (integration)', () => {
  let session: BCSession;
  let lease: PooledLease;

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
  }, 60_000);

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

  it('opens Customer List (page 22) and receives events', async () => {
    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query: `page=22&tenant=default`,
      controlPath: 'server:c[0]',
    };

    const result = await session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    expect(isErr(result)).toBe(false);
    if (isErr(result)) return;

    let events = result.value;
    console.error('Page 22 event types:', events.map(e => e.type));
    console.error('Page 22 event formIds:', events.filter(e => 'formId' in e).map(e => (e as any).formId));

    // Handle license dialog if it appears
    events = await dismissDialogsIfPresent(events);

    // Should have received some events
    expect(events.length).toBeGreaterThan(0);

    // Session should track open forms
    expect(session.openFormIds.size).toBeGreaterThan(0);
    console.error('Open form IDs:', Array.from(session.openFormIds));
  });

  it('opens Customer Card (page 21) on same connection', async () => {
    const interaction: OpenFormInteraction = {
      type: 'OpenForm',
      query: `page=21&tenant=default`,
      controlPath: 'server:c[0]',
    };

    const result = await session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted',
    );

    expect(isErr(result)).toBe(false);
    if (isErr(result)) return;

    let events = result.value;
    console.error('Page 21 event types:', events.map(e => e.type));

    // Handle any dialogs
    events = await dismissDialogsIfPresent(events);

    // With single connection, we should have multiple forms open
    console.error('Open form IDs after page 21:', Array.from(session.openFormIds));
    expect(session.openFormIds.size).toBeGreaterThanOrEqual(2);
  });
});
