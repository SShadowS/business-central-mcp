/**
 * Fix-pass probe: does a lookup load all candidates inline, and does ScrollRepeater on the
 * lookup form load more? Customer Card -> Lookup on "Country/Region Code" (a larger table),
 * count inline rows, scroll the lookup repeater, count again, cancel. Reads only.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-lookup-scroll.ts
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { fields, repeaters } from '../src/protocol/form-views.js';
import { buildFormTree } from '../src/protocol/form-tree-builder.js';
import { SystemAction, type BCEvent } from '../src/protocol/types.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };
const cfg = loadConfig();
const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
if (isErr(await auth.authenticate())) throw new Error('auth failed');
const session = unwrap(await new SessionFactory(new ConnectionFactory(auth, cfg.bc, quiet), new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
const repo = new PageContextRepository();
const card = unwrap(await new PageService(session, repo, quiet).openPage('21'));
const root = card.forms.get(card.rootFormId)!.root;
const field = fields(root).find(f => f.properties.caption === 'Country/Region Code')!;

const opened = unwrap(await session.invoke({ type: 'InvokeAction', formId: card.rootFormId, controlPath: field.controlPath, systemAction: SystemAction.Lookup }, e => e.type === 'InvokeCompleted' || e.type === 'FormCreated'));
const form = opened.find(e => e.type === 'FormCreated') as (BCEvent & { formId: string; controlTree: Record<string, unknown> }) | undefined;
if (!form) { console.log('no lookup form:', opened.map(e => e.type).join(',')); process.exit(0); }
const rep = [...repeaters(buildFormTree(form.controlTree)).values()][0]!;
const countInline = (t: unknown): number => {
  let n = 0;
  (function walk(o: unknown) {
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    const rows = (r.Data as { Rows?: { LoadedRows?: unknown[] } } | undefined)?.Rows?.LoadedRows;
    if (r.t === 'rc' && Array.isArray(rows)) n += rows.length;
    for (const v of Object.values(r)) if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
  })(t);
  return n;
};
console.log(`inline rows: ${countInline(form.controlTree)} repeater ${rep.controlPath}`);
const dlOpen = opened.filter(e => e.type === 'DataLoaded') as Array<{ rows: unknown[]; formId: string; controlPath: string }>;
console.log(`DataLoaded in lookup response: ${dlOpen.map(d => `${d.formId}${d.controlPath}:${d.rows.length}`).join(' ')} | events: ${[...new Set(opened.map(e => e.type))].join(',')}`);
const pageSize = (form.controlTree as { PageSize?: unknown }).PageSize ?? (rep.properties as Record<string, unknown>);
console.log('repeater props sample:', JSON.stringify(pageSize).slice(0, 200));
for (let i = 0; i < 3; i++) {
  const r = await session.invoke({ type: 'ScrollRepeater', formId: form.formId, controlPath: rep.controlPath, delta: 1 }, e => e.type === 'InvokeCompleted' || e.type === 'DataLoaded');
  if (isErr(r)) { console.log(`scroll ${i}: ERR ${r.error.message.slice(0, 300)}`); break; }
  const dl = r.value.filter(e => e.type === 'DataLoaded') as Array<{ rows: unknown[] }>;
  console.log(`scroll ${i}: ${r.value.map(e => e.type).join(',')} rows+=${dl.reduce((s, d) => s + d.rows.length, 0)}`);
}
await session.invoke({ type: 'InvokeAction', formId: form.formId, controlPath: 'server:', systemAction: SystemAction.LookupCancel }, e => e.type === 'InvokeCompleted');
console.log('session alive:', session.isAlive);
await session.close();
