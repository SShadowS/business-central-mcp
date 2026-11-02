/**
 * Probe (issue #56): does a bookmarks[] selection that is a SUBSET of the view survive
 * an action that runs SetSelectionFilter, a modal page, then a report? Uses Print... on
 * Posted Sales Invoices (page 143), which goes SetSelectionFilter -> PrintRecords ->
 * report request page -> report. Variants: 2 rows of the full view, 1 row, and the
 * issue's workaround (view filtered to exactly the 2 rows). Writes only "No. Printed".
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-selection-print.ts [action]
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
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { RespondDialogOperation } from '../src/operations/respond-dialog.js';
import { ClosePageOperation } from '../src/operations/close-page.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCInteraction } from '../src/protocol/types.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  const [action = 'Print...'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const download = new DownloadService(conn.createHttpClient(), conn.httpBaseUrl, cfg.bc.downloadLimits, quiet);
  const pages = new PageService(session, repo, quiet);
  const filters = new FilterService(session, repo, quiet);
  const openPage = new OpenPageOperation(pages);
  const read = new ReadDataOperation(new DataService(session, repo, quiet), filters, new SortService(session, repo, quiet), repo);
  const exec = new ExecuteActionOperation(new ActionService(session, repo, quiet), repo, new NavigationService(session, repo, quiet), download, 100);
  const respond = new RespondDialogOperation(session, repo, download);
  const close = new ClosePageOperation(pages, repo, filters);

  // Log every interaction sent while an action runs.
  let log = false;
  const orig = session.invoke.bind(session);
  (session as unknown as { invoke: typeof session.invoke }).invoke = async (i: BCInteraction, ...rest) => {
    if (log) console.log(`    -> ${JSON.stringify(i).slice(0, 260)}`);
    return orig(i, ...rest);
  };
  const seq = (session as unknown as { invokeSequence?: (...a: unknown[]) => unknown }).invokeSequence;
  if (seq) (session as unknown as { invokeSequence: (...a: unknown[]) => unknown }).invokeSequence = (interactions: unknown, ...rest: unknown[]) => {
    if (log) for (const i of interactions as BCInteraction[]) console.log(`    => ${JSON.stringify(i).slice(0, 260)}`);
    return seq.call(session, interactions, ...rest);
  };

  const run = async (label: string, pc: string, sel: { bookmarks?: string[]; bookmark?: string }): Promise<void> => {
    console.log(`--- ${label}`);
    log = true;
    const r = await exec.execute({ pageContextId: pc, action, ...sel });
    if (isErr(r)) { console.log(`  action ERR ${r.error.message}`); log = false; return; }
    let d = r.value.dialogsOpened?.[0];
    console.log(`  action ok, dialog: ${d?.message ?? 'none'}, downloads: ${r.value.downloads?.length ?? 0}`);
    for (let i = 0; d && i < 3; i++) {
      const a = await respond.execute({ pageContextId: d.pageContextId, dialogFormId: d.formId, response: (process.env.RESPONSE ?? 'ok') as 'ok' });
      if (isErr(a)) { console.log(`  respond ERR ${a.error.message}`); break; }
      console.log(`  respond ok: downloads=${a.value.downloads.map(x => `${x.fileName} ${x.sizeBytes}B${x.error ? ' ' + x.error.code : ''}`).join(', ') || 'none'} messages=${JSON.stringify(a.value.messages)}`);
      d = a.value.dialogsOpened[0];
      if (d) console.log(`  next dialog: ${d.message}`);
    }
    log = false;
  };

  const list = unwrap(await openPage.execute({ pageId: '143' }));
  const pc = list.pageContextId;
  const view = unwrap(await read.execute({ pageContextId: pc, filters: [{ column: 'Customer No.', value: '10000' }] }));
  const rows = view.section.rows ?? [];
  console.log(`view: ${rows.length} rows`);
  const [a, b] = [rows[2]!, rows[3]!];
  const no = (r: typeof a): string => String((r.cells as Record<string, unknown>)['No.'] ?? '?');
  console.log(`selected: ${no(a)} ${a.bookmark}, ${no(b)} ${b.bookmark}`);

  await run('2 rows of the full view (bookmarks[])', pc, { bookmarks: [a.bookmark, b.bookmark] });
  await run('1 row (bookmark)', pc, { bookmark: a.bookmark });
  const narrowed = unwrap(await read.execute({ pageContextId: pc, clearFilters: true, filters: [{ column: 'No.', value: `${no(a)}|${no(b)}` }] }));
  console.log(`narrowed view: ${narrowed.section.rows?.length} rows`);
  await run('workaround: view = the 2 rows (bookmarks[])', pc, { bookmarks: [a.bookmark, b.bookmark] });

  await close.execute({ pageContextId: pc });
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
