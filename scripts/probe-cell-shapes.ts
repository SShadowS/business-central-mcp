/**
 * Task 7 probe: raw repeater cells and column nodes. Prints the Customer List (22) columns
 * with their raw node data, one raw row, and the raw cells of a Sales Order's lines
 * (incl. one DraftRecord row). Reads only.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-cell-shapes.ts <out.json>
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { repeaters } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { PageContext } from '../src/protocol/page-context.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };
const cfg = loadConfig();
const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
if (isErr(await auth.authenticate())) throw new Error('auth failed');
const session = unwrap(await new SessionFactory(new ConnectionFactory(auth, cfg.bc, quiet), new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
const repo = new PageContextRepository();
const pages = new PageService(session, repo, quiet);
const nav = new NavigationService(session, repo, quiet);

function dump(ctx: PageContext, sectionId: string) {
  const section = ctx.sections.get(sectionId)!;
  const form = ctx.forms.get(section.formId)!;
  const rep = [...repeaters(form.root).values()][0]!;
  const rows = [...(form.rows.get(rep.controlPath) ?? [])];
  return {
    columns: rep.columns.map(c => ({ caption: c.properties.caption, type: c.type, binder: c.columnBinder?.name, raw: (c as { raw?: unknown }).raw })),
    rows: rows.slice(0, 2).concat(rows.filter(r => r.bookmark.startsWith('DraftRecord')).slice(0, 1)),
    rowCount: rows.length,
    draftCount: rows.filter(r => r.bookmark.startsWith('DraftRecord')).length,
  };
}

// Raw row-cell templates of page 22's repeater (t, binder, caption): the column's real control type.
const raw = unwrap(await session.invoke({ type: 'OpenForm', query: `page=22&tenant=${cfg.bc.tenantId}`, controlPath: 'server:c[0]' }, e => e.type === 'InvokeCompleted'));
const tree = (raw.find(e => e.type === 'FormCreated') as { controlTree: unknown; formId: string });
const templates: unknown[] = [];
(function walk(n: unknown) {
  if (!n || typeof n !== 'object') return;
  const o = n as Record<string, unknown>;
  if (o.t === 'rc' && Array.isArray(o.Children)) for (const c of o.Children as Record<string, unknown>[]) {
    const { Children: _c, ...rest } = c;
    templates.push(Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'object' || v === null).concat([['ColumnBinder', rest.ColumnBinder]])));
  }
  for (const v of Object.values(o)) if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
})(tree.controlTree);
await session.invoke({ type: 'CloseForm', formId: tree.formId }, e => e.type === 'InvokeCompleted');

const list = unwrap(await pages.openPage('22'));
const out: Record<string, unknown> = { customerListTemplates: templates, customerList: dump(list, 'header') };
const soList = unwrap(await pages.openPage('9305'));
const first = dump(soList, 'header').rows[0] as { bookmark: string };
const doc = unwrap(await nav.drillDown(soList.pageContextId, first.bookmark));
out.salesLines = dump(doc.targetPageContext, 'lines');
writeFileSync(process.argv[2] ?? 'cells.json', JSON.stringify(out, null, 2));
await session.close();
console.log('wrote', process.argv[2]);
