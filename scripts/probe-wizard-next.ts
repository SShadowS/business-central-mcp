/**
 * Probe (issue #41): what does BC send back when "Next" fires on a NavigatePage wizard?
 * Opens the wizard, dumps the root groups (designName / visible / hasVisibleExpression)
 * and our wizardState, invokes Next, then dumps every raw event BC returned.
 *
 * Run: BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/probe-wizard-next.ts [pageId]
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
import { OpenPageOperation } from '../src/operations/open-page.js';
import { isGroupNode, type FormNode } from '../src/protocol/form-node.js';
import { actions as treeActions, fields as treeFields, groupVisibility as treeGroupVisibility } from '../src/protocol/form-views.js';
import { isEffectivelyVisible } from '../src/protocol/visibility.js';
import { classifyWizardNav } from '../src/protocol/wizard-classify.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function dumpGroups(node: FormNode, depth = 0): void {
  for (const c of node.children ?? []) {
    if (!isGroupNode(c)) continue;
    const p = c.properties;
    console.log(`${'  '.repeat(depth + 1)}gc ${c.controlPath} design=${p.designName ?? '-'} visible=${p.visible ?? '(unset)'} visExpr=${p.hasVisibleExpression ?? false} caption=${JSON.stringify(p.caption ?? '')}`);
    if (depth < 1) dumpGroups(c, depth + 1);
  }
}

async function main(): Promise<void> {
  const pageId = process.argv[2] ?? '1803';
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const session = unwrap(await sf.create());

  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const actions = new ActionService(session, repo, quiet);

  const opened = unwrap(await openPage.execute({ pageId }));
  const pcId = opened.pageContextId;
  const ctx = repo.get(pcId)!;
  const root = ctx.forms.get(ctx.rootFormId)!.root;
  console.log(`opened ${pcId} pageType=${ctx.pageType} wizardState=${JSON.stringify(ctx.wizardState)}`);
  dumpGroups(root);
  for (const a of treeActions(root)) {
    console.log(`  act ${a.controlPath} sa=${a.systemAction} icon=${a.iconIdentifier ?? '-'} en=${a.properties.enabled ?? '(unset)'} vis=${a.properties.visible ?? '(unset)'} nav=${classifyWizardNav(a) ?? '-'} "${a.properties.caption ?? ''}"`);
  }

  const res = await actions.executeWizardNav(pcId, 'next');
  if (isErr(res)) { console.log('NEXT ERR', res.error.message, res.error.context); }
  else {
    console.log(`\nNEXT success=${res.value.success}, ${res.value.events.length} events:`);
    for (const e of res.value.events) console.log(JSON.stringify(e).slice(0, 400));
    const after = repo.get(pcId)!;
    console.log(`wizardState after: ${JSON.stringify(after.wizardState)}`);
    const r2 = after.forms.get(after.rootFormId)!.root;
    const gv = treeGroupVisibility(r2);
    for (const f of treeFields(r2)) {
      if (f.properties.caption && isEffectivelyVisible(r2, f.controlPath, gv, after.wizardState)) {
        console.log(`  field ${f.controlPath} "${f.properties.caption.slice(0, 60)}" editable=${f.properties.editable ?? false}`);
      }
    }
  }

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
