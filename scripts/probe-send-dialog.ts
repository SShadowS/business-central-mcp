/**
 * Probe (issue #55), read-only: open "Send Document to" (page 364) from a Posted Sales
 * Invoice and print its actions (caption, SystemAction, controlPath), then Cancel it.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-send-dialog.ts
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
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const download = new DownloadService(conn.createHttpClient(), conn.httpBaseUrl, cfg.bc.downloadLimits, quiet);
  const data = new DataService(session, repo, quiet);
  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const read = new ReadDataOperation(data, new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);
  const exec = new ExecuteActionOperation(new ActionService(session, repo, quiet), repo, new NavigationService(session, repo, quiet), download, 100);
  const respond = new RespondDialogOperation(session, repo, download);
  try {
    const list = unwrap(await openPage.execute({ pageId: '143' }));
    const rows = unwrap(await read.execute({ pageContextId: list.pageContextId, range: { offset: 0, limit: 1 } }));
    const bm = rows.section.rows?.[0]?.bookmark;
    console.log('posted invoice row:', bm);
    const r = unwrap(await exec.execute({ pageContextId: list.pageContextId, action: process.env.ACTION ?? 'Send...', bookmark: bm }));
    const d = r.dialogsOpened?.[0];
    console.log('dialog:', d?.formId, d?.message);
    for (const f of d?.fields ?? []) console.log(`  field "${f.caption}" = ${JSON.stringify((f as { value?: unknown; stringValue?: unknown }).value ?? (f as { stringValue?: unknown }).stringValue)} editable=${f.editable} options=${JSON.stringify((f as { options?: unknown }).options ?? null)}`);
    if (!d) return;
    const form = repo.get(d.pageContextId)?.forms.get(d.formId);
    for (const a of form ? treeActions(form.root) : []) console.log(`  action "${a.properties.caption}" systemAction=${a.systemAction} ${a.controlPath} enabled=${a.properties.enabled ?? '(unset)'}`);
    const c = await respond.execute({ pageContextId: d.pageContextId, dialogFormId: d.formId, response: 'cancel' });
    console.log('cancel:', isErr(c) ? c.error.message : `ok closed=${c.value.replaySafe}`);
  } finally {
    await session.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
