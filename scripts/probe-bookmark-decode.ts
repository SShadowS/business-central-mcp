/**
 * READ-ONLY probe for #34: capture real record bookmarks and decode them as
 * NavRecordId bytes. Opens lists 22 / 9305, reads rows, opens card 21 and
 * document 42 on an existing bookmark, closes with discardChanges, then runs
 * bc_get_operation's read-back for a synthetic in-doubt entry (also read-only).
 * Run: BC_BASE_URL=http://cronus29/BC BC_TEST_USERS=sshadows npx tsx scripts/probe-bookmark-decode.ts <outFile>
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTargetDescriber } from '../src/operations/target-descriptor.js';
import { GetOperationOperation } from '../src/operations/get-operation.js';
import { OperationLedger } from '../src/mcp/operation-ledger.js';
import { createNullLogger } from '../src/core/logger.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { unwrap } from '../src/core/result.js';
import { integrationPool } from '../tests/integration/helpers/session-pool.js';

const log = createNullLogger();
const out: unknown[] = [];

async function main(): Promise<void> {
  const lease = await integrationPool.checkOut();
  const s = lease.session;
  const repo = new PageContextRepository();
  const ps = new PageService(s, repo, log);
  const read = new ReadDataOperation(new DataService(s, repo, log), new FilterService(s, repo, log), new SortService(s, repo, log), repo);
  const ledger = new OperationLedger(mkdtempSync(join(tmpdir(), 'bcmcp-bm-probe-')));
  const getOp = new GetOperationOperation(ledger, ps, () => s.companyName, () => s.modalStackSnapshot().length > 0);
  try {
    const lists: Record<string, string> = { '22': '21', '9305': '42' };
    for (const [listId, cardId] of Object.entries(lists)) {
      const ctx = unwrap(await ps.openPage(listId));
      const rows = unwrap(await read.execute({ pageContextId: ctx.pageContextId, range: { offset: 0, limit: 5 } })).section.rows ?? [];
      for (const r of rows) out.push({ page: listId, bookmark: r.bookmark, cells: r.cells });
      unwrap(await ps.closePage(ctx.pageContextId, { discardChanges: true }));
      const bm = rows[0]?.bookmark;
      if (!bm) continue;
      const card = unwrap(await ps.openPage(cardId, { bookmark: bm }));
      const root = card.forms.get(card.rootFormId);
      const target = createTargetDescriber(repo, () => s.companyName)({ pageContextId: card.pageContextId, action: 'Release' });
      out.push({ page: cardId, requested: bm, landed: root?.root.properties.bookmark, caption: card.caption, keyFields: target.keyFields });
      unwrap(await ps.closePage(card.pageContextId, { discardChanges: true }));
      // bc_get_operation read-back against a synthetic in-doubt entry: opens the page, reads, closes with discardChanges.
      const id = `probe-${cardId}-${Date.now()}`;
      await ledger.claim(id, 'bc_execute_action', 'digest', target);
      await ledger.settle(id, { status: 'unknown', replaySafe: false });
      const got = unwrap(await getOp.execute({ operationId: id }));
      out.push({ page: cardId, readBack: got.readBack, readBackError: got.readBackError });
    }
  } finally {
    writeFileSync(process.argv[2] ?? 'bookmarks.json', JSON.stringify(out, null, 2));
    await integrationPool.checkIn(lease, { poisoned: false });
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
