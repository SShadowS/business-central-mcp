/**
 * Probe (issue #54): does a new line's DraftRecord bookmark survive the first field write?
 * Creates a draft Sales Invoice, adds a line, writes Type / No. / Quantity by the draft
 * bookmark one field at a time and prints the lines rows' bookmarks after each write.
 * Deletes the draft invoice at the end.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-draft-bookmark.ts [customerNo] [itemNo]
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { DataService } from '../src/services/data-service.js';
import { ActionService } from '../src/services/action-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { DownloadService } from '../src/services/download-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { WriteDataOperation } from '../src/operations/write-data.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { RespondDialogOperation } from '../src/operations/respond-dialog.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { resolveSection } from '../src/protocol/section-resolver.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  const [customerNo = '10000', itemNo = '1896-S'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const download = new DownloadService(conn.createHttpClient(), conn.httpBaseUrl, cfg.bc.downloadLimits, quiet);
  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const write = new WriteDataOperation(new DataService(session, repo, quiet), repo);
  const exec = new ExecuteActionOperation(new ActionService(session, repo, quiet), repo, new NavigationService(session, repo, quiet), download, 100);
  const respond = new RespondDialogOperation(session, repo, download);

  const card = unwrap(await openPage.execute({ pageId: '43' }));
  const nw = unwrap(await exec.execute({ pageContextId: card.pageContextId, action: 'New' }));
  const pc = nw.openedPages?.[0]?.pageContextId ?? card.pageContextId;
  unwrap(await write.execute({ pageContextId: pc, fields: { 'Customer No.': customerNo } }));
  const rows = (label: string): string => {
    const s = resolveSection(repo.get(pc)!, 'lines');
    return `[${label}] ${'error' in s ? s.error : s.rows.map(r => r.bookmark).join(', ')}`;
  };
  try {
    console.log(rows('before New'));
    unwrap(await exec.execute({ pageContextId: pc, action: 'New', section: 'lines' }));
    console.log(rows('after New'));
    const s = resolveSection(repo.get(pc)!, 'lines');
    const draft = 'error' in s ? undefined : s.rows.find(r => r.bookmark.startsWith('DraftRecord'))?.bookmark;
    console.log('draft bookmark:', draft);
    const r = await write.execute({ pageContextId: pc, section: 'lines', bookmark: draft, fields: { Type: 'Item', 'No.': itemNo, Quantity: '1' } });
    console.log(`write Type/No./Quantity by ${draft}:`, isErr(r) ? `ERR ${r.error.message}` : JSON.stringify(r.value.results.map(x => [x.fieldName, x.success, x.newValue])));
    console.log(rows('after write'));
    const stale = await write.execute({ pageContextId: pc, section: 'lines', bookmark: draft, fields: { Quantity: '2' } });
    console.log(`write again by stale ${draft}:`, isErr(stale) ? `ERR ${stale.error.message}` : JSON.stringify(stale.value.results.map(x => [x.fieldName, x.success, x.error])));
  } finally {
    // An invoice left behind by an earlier run (LEFTOVER=<No.>): delete it from the list.
    if (process.env.LEFTOVER) {
      const list = unwrap(await openPage.execute({ pageId: '9301' }));
      const read = unwrap(await new ReadDataOperation(new DataService(session, repo, quiet), new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo)
        .execute({ pageContextId: list.pageContextId, filters: [{ column: 'No.', value: process.env.LEFTOVER }] }));
      const bm = read.section.rows?.[0]?.bookmark;
      console.log(`leftover ${process.env.LEFTOVER}: rows=${read.section.rows?.length} bookmark=${bm}`);
      if (bm && read.section.rows?.length === 1) {
        const d = await exec.execute({ pageContextId: list.pageContextId, action: 'Delete', bookmark: bm });
        const c = isErr(d) ? [] : d.value.dialogsOpened ?? [];
        const y = c[0] ? await respond.execute({ pageContextId: c[0].pageContextId, dialogFormId: c[0].formId, response: 'yes' }) : d;
        console.log('leftover delete:', isErr(y) ? y.error.message : 'ok');
      }
    }
    const del = await exec.execute({ pageContextId: pc, action: 'Delete' });
    const dd = isErr(del) ? [] : del.value.dialogsOpened ?? [];
    if (dd[0]) {
      const y = await respond.execute({ pageContextId: dd[0].pageContextId, dialogFormId: dd[0].formId, response: 'yes' });
      console.log('delete:', isErr(y) ? y.error.message : 'ok');
    } else console.log('delete:', isErr(del) ? del.error.message : 'no confirm?');
    await session.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
