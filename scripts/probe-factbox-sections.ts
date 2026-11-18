/**
 * Probe: which FactBox sections a Card / List page exposes. Dumps the fhc/lf wire properties of
 * every hosted part in the OpenForm response, every non-OpenForm invoke the page open sends with
 * its events, then the sections we derive (kind, valid, field/row counts).
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/probe-factbox-sections.ts 370 [bookmark]
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { fields as treeFields, repeaters as treeRepeaters } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCEvent } from '../src/protocol/types.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function dumpHosts(node: unknown, path = 'server'): void {
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.t === 'fhc') {
    const lf = (o.Children as Array<Record<string, unknown>> | undefined)?.find(c => c.t === 'lf');
    console.log(`  fhc ${path} DesignName=${JSON.stringify(o.DesignName)} Caption=${JSON.stringify(o.Caption)} Visible=${o.Visible} keys=${Object.keys(o).join(',')}`);
    if (lf) console.log(`    lf ServerId=${lf.ServerId} Caption=${JSON.stringify(lf.Caption)} State=${lf.State} IsSubForm=${lf.IsSubForm} IsPart=${lf.IsPart} PageType=${lf.PageType} children=${(lf.Children as unknown[] | undefined)?.length ?? 0}`);
    else console.log('    (no lf child)');
  }
  (o.Children as unknown[] | undefined)?.forEach((c, i) => dumpHosts(c, `${path}/c[${i}]`));
}

async function main(): Promise<void> {
  const pageId = process.argv[2] ?? '370';
  const bookmark = process.argv[3];
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  { const a = await auth.authenticate(); if (isErr(a)) { console.error("AUTH FAILED", a.error.message); process.exit(1); } }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const session = unwrap(await sf.create());

  const origInvoke = session.invoke.bind(session);
  let firstOpen: BCEvent[] | undefined;
  (session as unknown as { invoke: typeof session.invoke }).invoke = async (i, p, o) => {
    const r = await origInvoke(i, p, o);
    if (!firstOpen && i.type === 'OpenForm' && !isErr(r)) firstOpen = r.value;
    if (i.type !== 'OpenForm') {
      console.log(`  >> ${JSON.stringify(i).slice(0, 200)}`);
      if (isErr(r)) console.log(`  << ERR ${r.error.message}`);
      else console.log(`  << ${r.value.map(e => e.type === "DataLoaded" ? `DataLoaded(form=${e.formId} ref=${(e as {refFormId?: string}).refFormId} path=${(e as {controlPath?: string}).controlPath} rows=${JSON.stringify(e).length > 0 ? ((e as unknown as {rows?: unknown[]}).rows?.length ?? JSON.stringify(e).slice(0, 160)) : ""})` : e.type).join(",")}`);
    }
    return r;
  };

  const pages = new PageService(session, repo, quiet);
  const opened = unwrap(await pages.openPage(pageId, bookmark ? { bookmark } : undefined));
  const ctx = repo.get(opened.pageContextId)!;
  console.log(`opened pageType=${ctx.pageType}`);
  console.log('open events:', firstOpen?.map(e => e.type).join(','));
  for (const e of firstOpen ?? []) {
    if ((e.type === 'DialogOpened' || e.type === 'FormCreated') && 'controlTree' in e) dumpHosts(e.controlTree);
    if (e.type === 'ControlInserted') { console.log('  ControlInserted', JSON.stringify(e).slice(0, 600)); }
  }
  // Every caption-bearing node under the root, to spot factbox containers that are not fhc.
  const rootEv = firstOpen?.find(e => e.type === 'FormCreated');
  const walk = (n: unknown, p: string): void => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.t !== 'lf' || p === 'server') {
      if (/fhc|lf|gc|tab|fbx|part/i.test(String(o.t)) && (o.MappingHint || o.Caption)) console.log(`  node ${p} t=${o.t} MappingHint=${o.MappingHint} Caption=${JSON.stringify(o.Caption)} DesignName=${o.DesignName}`);
      (o.Children as unknown[] | undefined)?.forEach((c, i) => walk(c, `${p}/c[${i}]`));
    }
  };
  if (rootEv && 'controlTree' in rootEv) (rootEv.controlTree as { Children?: unknown[] }).Children?.forEach((c, i) => walk(c, `server/c[${i}]`));
  if (rootEv && "controlTree" in rootEv) (rootEv.controlTree as { Children?: Array<Record<string, unknown>> }).Children?.forEach((c, i) => console.log(`  top c[${i}] t=${c.t} MappingHint=${c.MappingHint} Caption=${JSON.stringify(c.Caption)} Visible=${c.Visible} keys=${Object.keys(c).join(",")} json=${JSON.stringify(c).slice(0, 400)}`));
  for (const [id, s] of ctx.sections) {
    const f = ctx.forms.get(s.formId);
    const rows = s.repeaterControlPath ? f?.rows.get(s.repeaterControlPath)?.length : undefined;
    console.log(`  section ${JSON.stringify(id)} kind=${s.kind} valid=${s.valid} fields=${f ? treeFields(f.root).length : '-'} repeaters=${f ? treeRepeaters(f.root).size : '-'} rep=${s.repeaterControlPath ?? '-'} rows=${rows ?? '-'}`);
  }
  console.log('openPage sections:', [...opened.sections.keys()].join(', '));

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
