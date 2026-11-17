/**
 * Probe: a NavigatePage whose step 2 hosts a ListPart without SubPageLink and with a blank caption
 * (fixture app tests/integration/fixtures/al/wizard-part, page 50990). Dumps the fhc/lf wire
 * properties of every hosted part in the open response, the sections we derive, then Next twice
 * with the raw events and the sections/rows after each.
 *
 * Run: BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/probe-wizard-part.ts [pageId]
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
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCEvent } from '../src/protocol/types.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function dumpHosts(node: unknown, path = 'server'): void {
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.t === 'fhc') {
    const lf = (o.Children as Array<Record<string, unknown>> | undefined)?.find(c => c.t === 'lf') ?? (o.Form as Record<string, unknown> | undefined);
    console.log(`  fhc ${path} DesignName=${JSON.stringify(o.DesignName)} Caption=${JSON.stringify(o.Caption)} Visible=${o.Visible}`);
    if (lf) console.log(`    lf ServerId=${lf.ServerId} Caption=${JSON.stringify(lf.Caption)} DesignName=${JSON.stringify(lf.DesignName)} State=${lf.State} IsSubForm=${lf.IsSubForm} IsPart=${lf.IsPart} PageType=${(lf.Metadata as Record<string, unknown> | undefined)?.pageType ?? lf.PageType} keys=${Object.keys(lf).join(',')}`);
  }
  const kids = o.Children as unknown[] | undefined;
  kids?.forEach((c, i) => dumpHosts(c, `${path}/c[${i}]`));
}

function dumpCtx(repo: PageContextRepository, pcId: string): void {
  const ctx = repo.get(pcId)!;
  for (const [id, s] of ctx.sections) {
    const f = ctx.forms.get(s.formId);
    const rows = s.repeaterControlPath ? f?.rows.get(s.repeaterControlPath)?.length : undefined;
    const allRows = f ? [...f.rows.entries()].map(([k, v]) => `${k}:${v.length}`).join(' ') : '';
    console.log(`  section ${JSON.stringify(id)} kind=${s.kind} formId=${s.formId} rep=${s.repeaterControlPath ?? '-'} valid=${s.valid} rows=${rows ?? '-'} formRows=[${allRows}]`);
  }
}

function dumpEvents(events: readonly BCEvent[]): void {
  for (const e of events) console.log('   ', JSON.stringify(e).slice(0, 300));
}

async function main(): Promise<void> {
  const pageId = process.argv[2] ?? '50990';
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const session = unwrap(await sf.create());

  // Raw open events: wrap invoke once to see the OpenForm response.
  const origInvoke = session.invoke.bind(session);
  let firstOpen: BCEvent[] | undefined;
  (session as unknown as { invoke: typeof session.invoke }).invoke = async (i, p, o) => {
    const r = await origInvoke(i, p, o);
    if (!firstOpen && i.type === 'OpenForm' && !isErr(r)) firstOpen = r.value;
    if (i.type !== 'OpenForm') {
      console.log(`  >> ${JSON.stringify(i).slice(0, 200)}`);
      if (isErr(r)) console.log(`  << ERR ${r.error.message}`);
      else for (const e of r.value) console.log(`  << ${JSON.stringify(e).slice(0, 260)}`);
    }
    return r;
  };

  const pages = new PageService(session, repo, quiet);
  const actions = new ActionService(session, repo, quiet);
  const opened = unwrap(await pages.openPage(pageId));
  const pcId = opened.pageContextId;
  console.log(`opened ${pcId} pageType=${repo.get(pcId)!.pageType} isModal=${repo.get(pcId)!.isModal}`);
  console.log('open events:', firstOpen?.map(e => e.type).join(','));
  for (const e of firstOpen ?? []) {
    if ((e.type === 'DialogOpened' || e.type === 'FormCreated') && 'controlTree' in e) dumpHosts(e.controlTree);
  }
  dumpCtx(repo, pcId);

  for (let n = 1; n <= 2; n++) {
    const res = await actions.executeWizardNav(pcId, 'next');
    if (isErr(res)) { console.log(`NEXT#${n} ERR`, res.error.message); break; }
    console.log(`\nNEXT#${n} ${res.value.events.length} events:`);
    dumpEvents(res.value.events);
    dumpCtx(repo, pcId);
  }

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
