/**
 * Probe (issue #59), read-only: an action that opens a List page with RunModal. Sales
 * Invoice (page 43) lines -> "Get Shipment Lines" (codeunit 64 runs page 5708 in
 * LookupMode). Logs each response's event types + formIds, reads the dialog, then Cancels.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-modal-list.ts [pageId] [action] [section]
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
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCInteraction, BCEvent } from '../src/protocol/types.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function summarize(events: BCEvent[]): string {
  return events.map(e => {
    const f = 'formId' in e ? (e as { formId?: string }).formId : '';
    const extra = e.type === 'DataLoaded' ? ` ${(e as { controlPath: string }).controlPath} rows=${(e as { rows: unknown[] }).rows.length}` : '';
    const tree = (e.type === 'DialogOpened' || e.type === 'FormCreated') ? ` hint=${JSON.stringify(((e as { controlTree?: { MappingHint?: unknown; Metadata?: { id?: unknown } } }).controlTree)?.MappingHint)} page=${JSON.stringify(((e as { controlTree?: { Metadata?: { id?: unknown } } }).controlTree)?.Metadata?.id)}` : '';
    return `${e.type}(${f}${extra}${tree})`;
  }).join(' ');
}

async function main(): Promise<void> {
  const [pageId = '43', action = 'Get Shipment Lines', section = 'lines'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const download = new DownloadService(conn.createHttpClient(), conn.httpBaseUrl, cfg.bc.downloadLimits, quiet);
  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const read = new ReadDataOperation(new DataService(session, repo, quiet), new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);
  const exec = new ExecuteActionOperation(new ActionService(session, repo, quiet), repo, new NavigationService(session, repo, quiet), download, 100);
  const respond = new RespondDialogOperation(session, repo, download);

  let log = false;
  const orig = session.invoke.bind(session);
  (session as unknown as { invoke: typeof session.invoke }).invoke = async (i: BCInteraction, ...rest) => {
    const r = await orig(i, ...rest);
    if (log) console.log(`  -> ${i.type} ${'formId' in i ? i.formId : ''}\n     <- ${isErr(r) ? 'ERR ' + r.error.message : summarize(r.value)}`);
    if (log && process.env.VERBOSE && !isErr(r)) for (const e of r.value) if (e.type === 'PropertyChanged' || e.type === 'DataLoaded') console.log(`     ${JSON.stringify(e).slice(0, 500)}`);
    if (log && process.env.DUMP && !isErr(r)) {
      const dlg = r.value.find(e => e.type === 'DialogOpened');
      if (dlg) (await import('node:fs')).writeFileSync(process.env.DUMP, JSON.stringify(dlg, null, 1));
    }
    return r;
  };
  try {
    const page = unwrap(await openPage.execute({ pageId }));
    console.log('opened', page.pageContextId, page.caption);
    log = true;
    const r = await exec.execute({ pageContextId: page.pageContextId, action, ...(section ? { section } : {}) });
    log = false;
    if (isErr(r)) { console.log("action ERR", r.error.message, JSON.stringify((r.error as { details?: unknown }).details ?? (r.error as { context?: unknown }).context).slice(0, 1500)); return; }
    const d = r.value.dialogsOpened?.[0];
    console.log('dialogsOpened:', JSON.stringify(r.value.dialogsOpened?.map(x => ({ pc: x.pageContextId, formId: x.formId, message: x.message, fields: x.fields?.length }))));
    console.log('openedPages:', JSON.stringify(r.value.openedPages));
    if (!d) return;
    if (process.env.LOADFORM) {
      log = true;
      const lf = await session.invoke({ type: 'LoadForm', formId: d.formId, loadData: true, delayed: false }, (e) => e.type === 'InvokeCompleted');
      log = false;
      if (!isErr(lf)) repo.applyToPage(d.pageContextId, lf.value);
    }
    const ctx = repo.get(d.pageContextId);
    const form = ctx?.forms.get(d.formId);
    console.log('dialog ctx pageType:', ctx?.pageType, 'rows map:', JSON.stringify([...(form?.rows ?? new Map()).entries()].map(([k, v]) => [k, v.length])));
    const rd = await read.execute({ pageContextId: d.pageContextId });
    console.log('read:', isErr(rd) ? rd.error.message : JSON.stringify(rd.value.section ? { id: rd.value.section.sectionId, rows: rd.value.section.rows?.length, total: rd.value.section.totalRowCount } : rd.value).slice(0, 400));
    log = true;
    const c = await respond.execute({ pageContextId: d.pageContextId, dialogFormId: d.formId, response: 'cancel' });
    log = false;
    console.log('cancel:', isErr(c) ? c.error.message : `closed=${c.value.replaySafe}`);
  } finally {
    await session.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
