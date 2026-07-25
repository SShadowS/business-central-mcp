/**
 * Probe: does BC push an action Enabled=false PropertyChanged to a HEADLESS
 * client when a multi-row selection makes an action non-invokable?
 *
 * User observation: on the Customer list, selecting multiple rows greys out
 * Delete (the web client disables the button). Decompiled ActionControl.Enabled
 * returns Action.CanInvoke(target); DeleteAction.CanInvoke requires
 * bindingManager.Deletable AND (for multi) CanInvokeOnRepeaterMultipleItems.
 * If BC serializes that Enabled change to us, detection is a state read.
 *
 * This probe:
 *   1. Opens a page, reads 3 distinct bookmarks.
 *   2. Dumps every action's {caption, systemAction, enabled} BEFORE selection.
 *   3. selectRows([b0,b1,b2]) via the real NavigationService (routes to repo).
 *   4. Dumps the same actions AFTER selection -> did Delete flip to enabled:false?
 *   5. Also dumps single-row select as the baseline.
 *
 * Runs on Customers (22, multi-delete DISABLED per user) and Payment Terms (4,
 * a small setup list expected to ALLOW multi-delete). NEVER confirms a delete.
 *
 * Run: BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/probe-action-enabled.ts
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
import { NavigationService } from '../src/services/navigation-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { resolveSection } from '../src/protocol/section-resolver.js';
import { actions as treeActions } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function dumpActions(repo: PageContextRepository, pcId: string, label: string): void {
  const ctx = repo.get(pcId)!;
  const resolved = resolveSection(ctx, undefined);
  if ('error' in resolved) { console.log(`  [${label}] resolveSection failed`); return; }
  const acts = treeActions(resolved.form.root);
  const rows = acts
    .filter(a => a.properties.caption || a.systemAction)
    .map(a => `sa=${a.systemAction ?? '-'} en=${a.properties.enabled ?? '(unset)'} "${a.properties.caption ?? ''}"`);
  console.log(`  [${label}] ${acts.length} actions:`);
  for (const r of rows) console.log(`     ${r}`);
  const del = acts.find(a => a.systemAction === 20);
  console.log(`  [${label}] DELETE(sa=20): ${del ? `enabled=${del.properties.enabled ?? '(unset)'} path=${del.controlPath}` : 'NOT FOUND'}`);
}

async function probePage(
  pageId: string,
  openPage: OpenPageOperation,
  readData: ReadDataOperation,
  nav: NavigationService,
  repo: PageContextRepository,
): Promise<void> {
  console.log(`\n===== PAGE ${pageId} =====`);
  const opened = unwrap(await openPage.execute({ pageId }));
  const pcId = opened.pageContextId;
  const read = unwrap(await readData.execute({ pageContextId: pcId, range: { offset: 0, limit: 6 } }));
  const distinct = [...new Map((read.section.rows ?? []).map(r => [r.bookmark, r])).values()];
  if (distinct.length < 3) { console.log(`  only ${distinct.length} rows -- skipping`); return; }
  const bookmarks = distinct.slice(0, 3).map(r => r.bookmark);
  const rowCountBefore = distinct.length;
  console.log(`  captured ${rowCountBefore} distinct rows; using 3 bookmarks`);

  dumpActions(repo, pcId, 'BEFORE-select');

  // Single-row baseline
  const one = await nav.selectRows(pcId, [bookmarks[0]!]);
  if (isErr(one)) { console.log(`  single-select ERR: ${one.error.message}`); }
  dumpActions(repo, pcId, 'AFTER single-select');

  // Multi-row
  const multi = await nav.selectRows(pcId, bookmarks);
  if (isErr(multi)) { console.log(`  multi-select ERR: ${multi.error.message}`); }
  dumpActions(repo, pcId, 'AFTER 3-row-select');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED'); process.exit(1); }
  const session = unwrap(sessRes);

  const pageService = new PageService(session, repo, quiet);
  const dataService = new DataService(session, repo, quiet);
  const nav = new NavigationService(session, repo, quiet);
  const openPage = new OpenPageOperation(pageService);
  const readData = new ReadDataOperation(dataService, new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);

  // Customers: user says multi-delete DISABLED
  await probePage('22', openPage, readData, nav, repo);
  // Payment Terms: small setup list, expected multi-delete ENABLED
  await probePage('4', openPage, readData, nav, repo);
  // Countries/Regions: another setup list
  await probePage('10', openPage, readData, nav, repo);

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
