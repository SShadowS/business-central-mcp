/**
 * Probe (issue #58), read-only: Companies (page 357) -> "Create New Company", Next, then
 * dump every field node of the wizard (caption, designName, controlIdentifier, editable,
 * visible, showCaption, controlPath) per step, then Cancel. Creates no company.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-company-wizard.ts
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { ActionService } from '../src/services/action-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { DownloadService } from '../src/services/download-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { WizardNavigateOperation } from '../src/operations/wizard-navigate.js';
import { WriteDataOperation } from '../src/operations/write-data.js';
import { DataService } from '../src/services/data-service.js';
import { fields as treeFields } from '../src/protocol/form-views.js';
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
  const actions = new ActionService(session, repo, quiet);
  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const exec = new ExecuteActionOperation(actions, repo, new NavigationService(session, repo, quiet), download, 100);
  const wizard = new WizardNavigateOperation(actions, repo, download);
  const write = new WriteDataOperation(new DataService(session, repo, quiet), repo);
  const dump = (pcId: string, label: string): void => {
    const ctx = repo.get(pcId);
    const form = ctx?.forms.get(ctx.rootFormId);
    console.log(`--- ${label}: ${ctx?.caption}`);
    for (const f of form ? treeFields(form.root) : []) {
      const p = f.properties;
      console.log(`  ${f.type} ${f.controlPath} caption=${JSON.stringify(p.caption)} design=${JSON.stringify(p.designName)} id=${JSON.stringify(p.controlIdentifier)} showCaption=${p.showCaption} editable=${p.editable} visible=${p.visible} enabled=${p.enabled} value=${JSON.stringify(p.stringValue)} tfn=${f.tableFieldNo}`);
    }
  };
  try {
    const list = unwrap(await openPage.execute({ pageId: '357' }));
    const r = unwrap(await exec.execute({ pageContextId: list.pageContextId, action: 'Create New Company' }));
    const pc = r.dialogsOpened?.[0]?.pageContextId ?? r.openedPages?.[0]?.pageContextId;
    console.log('opened:', JSON.stringify({ dialogs: r.dialogsOpened?.map(d => d.message), pages: r.openedPages }));
    if (!pc) return;
    dump(pc, 'step 1');
    const n = await wizard.execute({ pageContextId: pc, action: 'next' });
    console.log('next:', isErr(n) ? n.error.message : JSON.stringify(n.value.fields));
    if (!process.env.QUIET) dump(pc, 'step 2');
    // Writes only the wizard's own variable; the company is created on Finish, never reached.
    const w = await write.execute({ pageContextId: pc, fields: { CompanyName: 'MCP Probe Co' } });
    console.log('write:', isErr(w) ? w.error.message : JSON.stringify(w.value).slice(0, 400));
    const c = await wizard.execute({ pageContextId: pc, action: 'cancel' });
    console.log('cancel:', isErr(c) ? c.error.message : JSON.stringify(c.value).slice(0, 600));
  } finally {
    await session.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
