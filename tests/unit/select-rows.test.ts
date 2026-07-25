// tests/unit/select-rows.test.ts
//
// NavigationService.selectRows sends BC a multi-row selection (anchor =
// bookmarks[0], full set as rowsToSelect) in a single SetCurrentRow
// interaction. selectRow(bookmark) is now a one-element delegate to
// selectRows([bookmark]). A stale anchor (BC's InvalidBookmarkException)
// maps to the typed InvalidBookmarkError.
//
// The page-context fixture is built via the REAL PageContextRepository (not
// mocked) so resolveSection(ctx, sectionId) resolves a genuine repeater —
// see tests/protocol/section-resolver.test.ts for the FormCreated shape that
// yields a repeater child (a `rc` node under the root `lf`).

import { describe, it, expect, vi } from 'vitest';
import { NavigationService } from '../../src/services/navigation-service.js';
import { ok, err, isErr } from '../../src/core/result.js';
import { ProtocolError, InvalidBookmarkError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';
import type { Logger } from '../../src/core/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/**
 * Real PageContextRepository seeded with a root form that owns a repeater,
 * so resolveSection(ctx, 'header') yields { form, repeater } for the
 * 'header' section. Mirrors the FormCreated shape used throughout
 * tests/protocol/section-resolver.test.ts.
 */
function makeRepoWithRepeater(pcId: string, formId: string): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create(pcId, formId);
  const formCreated: BCEvent = {
    type: 'FormCreated',
    formId,
    controlTree: {
      t: 'lf',
      ServerId: formId,
      PageType: 1,
      Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] }],
    },
  } as unknown as BCEvent;
  repo.applyEvents([formCreated]);
  return repo;
}

/** Spies on session.invoke, recording every interaction it is asked to send. */
function makeSession(invokeImpl: () => Promise<ReturnType<typeof ok<BCEvent[]>> | ReturnType<typeof err<ProtocolError>>>) {
  const sent: unknown[] = [];
  const session = {
    invoke: vi.fn(async (interaction: unknown) => {
      sent.push(interaction);
      return invokeImpl();
    }),
  };
  return { session: session as unknown as import('../../src/session/bc-session.js').BCSession, sent };
}

describe('NavigationService.selectRows', () => {
  it('sends ONE SetCurrentRow interaction with key = bookmarks[0] and rowsToSelect = the full set', async () => {
    const pcId = 'pc:1';
    const repo = makeRepoWithRepeater(pcId, 'F1');
    const { session, sent } = makeSession(async () => ok([]));
    const nav = new NavigationService(session, repo, logger);

    const result = await nav.selectRows(pcId, ['A', 'B', 'C']);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const interaction = sent[0] as { type: string; key: string; rowsToSelect: string[] };
    expect(interaction.type).toBe('SetCurrentRow');
    expect(interaction.key).toBe('A');
    expect(interaction.rowsToSelect).toEqual(['A', 'B', 'C']);
  });

  it('selectRow(pcId, "X") delegates to selectRows and sends key = "X", rowsToSelect = ["X"]', async () => {
    const pcId = 'pc:2';
    const repo = makeRepoWithRepeater(pcId, 'F2');
    const { session, sent } = makeSession(async () => ok([]));
    const nav = new NavigationService(session, repo, logger);

    const result = await nav.selectRow(pcId, 'X');

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const interaction = sent[0] as { type: string; key: string; rowsToSelect: string[] };
    expect(interaction.type).toBe('SetCurrentRow');
    expect(interaction.key).toBe('X');
    expect(interaction.rowsToSelect).toEqual(['X']);
  });

  it('maps an InvalidBookmarkException RPC error to InvalidBookmarkError(bookmarks[0])', async () => {
    const pcId = 'pc:3';
    const repo = makeRepoWithRepeater(pcId, 'F3');
    const { session } = makeSession(async () => err(new ProtocolError('RPC failed: InvalidBookmarkException: stale anchor')));
    const nav = new NavigationService(session, repo, logger);

    const result = await nav.selectRows(pcId, ['A', 'B', 'C']);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(InvalidBookmarkError);
    expect((result.error as InvalidBookmarkError).bookmark).toBe('A');
    expect(result.error.code).toBe('INVALID_BOOKMARK');
  });

  it('returns a ProtocolError ("at least one bookmark") without calling session.invoke when bookmarks is empty', async () => {
    const pcId = 'pc:4';
    const repo = makeRepoWithRepeater(pcId, 'F4');
    const { session } = makeSession(async () => ok([]));
    const nav = new NavigationService(session, repo, logger);

    const result = await nav.selectRows(pcId, []);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(ProtocolError);
    expect(result.error.message).toMatch(/at least one bookmark/i);
    expect(session.invoke).not.toHaveBeenCalled();
  });
});
