/**
 * Probe (issue #41): what lines rows does a Sales Quote (page 41) expose in view
 * mode vs after Edit? Read-only: never writes, closes the card without saving.
 *
 * Run: BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/probe-quote-lines.ts
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
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { resolveSection } from '../src/protocol/section-resolver.js';
import { actions as treeActions } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const session = unwrap(await sf.create());
  const pages = new PageService(session, repo, quiet);
  const data = new DataService(session, repo, quiet);
  const actions = new ActionService(session, repo, quiet);
  const openPage = new OpenPageOperation(pages);
  const readData = new ReadDataOperation(data, new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);

  const list = unwrap(await openPage.execute({ pageId: '9300' }));
  const quotes = unwrap(await readData.execute({ pageContextId: list.pageContextId, range: { offset: 0, limit: 5 } }));
  const bm = quotes.section.rows?.[0]?.bookmark;
  console.log(`quotes: ${quotes.section.rows?.length}, using ${bm}`);
  if (!bm) process.exit(1);

  const card = unwrap(await openPage.execute({ pageId: '41', bookmark: bm }));
  const dump = (label: string): void => {
    const ctx = repo.get(card.pageContextId)!;
    const hdr = resolveSection(ctx, 'header');
    const lines = resolveSection(ctx, 'lines');
    if ('error' in hdr || 'error' in lines) { console.log(label, 'section error'); return; }
    const editable = hdr.form.root.properties.editable;
    const repEditable = lines.repeater?.properties.editable;
    console.log(`[${label}] header root editable=${editable} lines repeater editable=${repEditable} rows=${lines.rows.length}`);
    for (const r of lines.rows) console.log(`   row ${r.bookmark} draft=${r.bookmark.startsWith('Draft')} ${JSON.stringify(r.cells).slice(0, 120)}`);
  };
  dump('view');
  {
    const ctx = repo.get(card.pageContextId)!;
    const edits = treeActions(ctx.forms.get(ctx.rootFormId)!.root).filter(a => a.systemAction === 40);
    console.log(`root Edit(40) actions: ${edits.map(a => `${a.controlPath} en=${a.properties.enabled ?? '(unset)'} "${a.properties.caption}"`).join('; ') || 'none'}`);
  }

  const edit = await actions.executeAction(card.pageContextId, 'Edit');
  console.log('Edit:', isErr(edit) ? edit.error.message : `ok, ${edit.value.events.length} events, types=${[...new Set(edit.value.events.map(e => e.type))].join(',')}`);
  dump('after Edit');

  await pages.closePage(card.pageContextId, { discardChanges: true }).catch(() => {});
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
