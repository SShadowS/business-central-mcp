/**
 * Task 6 probe: can a Tell Me result (which names its target by AL name, never by id)
 * be opened? A: OpenForm with `page=<AL name>`. B: invoke the result row in the Tell Me
 * form (the web client's path). Prints what BC answers for each. Reads only.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-open-by-name.ts
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { SystemAction, type BCEvent } from '../src/protocol/types.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };
const done = (e: BCEvent) => e.type === 'InvokeCompleted';
const summary = (events: BCEvent[]) => events.map(e => e.type === 'FormCreated' || e.type === 'DialogOpened'
  ? `${e.type}(${e.formId} "${(e.controlTree as { Caption?: string })?.Caption ?? ''}" page=${JSON.stringify((e.controlTree as { Metadata?: { id?: unknown } })?.Metadata?.id)})`
  : e.type).join(', ');

const cfg = loadConfig();
const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
if (isErr(await auth.authenticate())) throw new Error('auth failed');
const session = unwrap(await new SessionFactory(new ConnectionFactory(auth, cfg.bc, quiet), new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());

// A: OpenForm by AL name.
for (const name of ['Customer List', 'Customer%20List']) {
  const r = await session.invoke({ type: 'OpenForm', query: `page=${name}&tenant=${cfg.bc.tenantId}`, controlPath: 'server:c[0]' }, done);
  console.log(`A page=${name}:`, isErr(r) ? `ERR ${r.error.message.slice(0, 300)}` : summary(r.value));
  if (!isErr(r)) for (const e of r.value) if (e.type === 'FormCreated' && !e.parentFormId) await session.invoke({ type: 'CloseForm', formId: e.formId }, done);
}

// B: search, then invoke the first page result's row.
const open = unwrap(await session.invoke({ type: 'SessionAction', actionName: 'InvokeSessionAction', namedParameters: { SystemAction: 220 } }, e => e.type === 'InvokeCompleted' || e.type === 'FormCreated'));
const tellMe = open.find(e => e.type === 'FormCreated')!;
const fid = (tellMe as { formId: string }).formId;
await session.invoke({ type: 'SaveValue', formId: fid, controlPath: 'server:c[0]/c[0]', newValue: '' }, done);
const res = unwrap(await session.invoke({ type: 'SaveValue', formId: fid, controlPath: 'server:c[0]/c[0]', newValue: 'customers' }, done));
type Row = { bookmark: string; cells: Record<string, { stringValue?: string }> };
// Raw rows are wrapped: { drich: [index, { bookmark, cells }] } (see tell-me-extractor.ts).
const unwrapRow = (raw: unknown): Row => {
  const arr = Object.values(raw as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined;
  const p = (arr?.[1] ?? {}) as Partial<Row>;
  return { bookmark: p.bookmark ?? '', cells: p.cells ?? {} };
};
console.log('raw row sample:', JSON.stringify((res.find(e => e.type === 'DataLoaded') as { rows: unknown[] } | undefined)?.rows[0]).slice(0, 600));
const loaded = res.filter(e => e.type === 'DataLoaded')
  .map(e => ({ controlPath: (e as { controlPath: string }).controlPath, rows: (e as { rows: unknown[] }).rows.map(unwrapRow) }));
for (const dl of loaded) for (const r of dl.rows.slice(0, 8)) console.log(`C ${dl.controlPath} ${r.cells.Name?.stringValue} | ${r.cells.Source?.stringValue} | CacheKey=${r.cells.CacheKey?.stringValue}`);
if (process.env.PROBE_ONLY_C) { await session.close(); process.exit(0); }
const first = loaded.find(dl => dl.rows.some(r => r.cells.Source?.stringValue?.includes('"page"')));
const row = first?.rows.find(r => r.cells.Source?.stringValue?.includes('"page"'));
if (first && row) {
  await session.invoke({ type: 'SetCurrentRow', formId: fid, controlPath: first.controlPath, key: row.bookmark } as never, done);
  for (const [label, sa] of [['DrillDown', SystemAction.DrillDown], ['Edit', SystemAction.Edit], ['View', SystemAction.View]] as const) {
    const r = await session.invoke({ type: 'InvokeAction', formId: fid, controlPath: `${first.controlPath}/cr/c[1]`, systemAction: sa }, e => e.type === 'InvokeCompleted' || e.type === 'FormCreated');
    console.log(`B ${label} on "${row.cells.Name?.stringValue}":`, isErr(r) ? `ERR ${r.error.message.slice(0, 300)}` : summary(r.value));
    if (!isErr(r) && r.value.some(e => e.type === 'FormCreated' && e.formId !== fid)) break;
  }
}
await session.close();
