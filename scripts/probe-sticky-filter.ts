/**
 * Probe (issue #57), read-only: does a column filter survive clearFilters, an empty
 * value and close/reopen within one session? Replays the issue's sequence on Posted
 * Sales Invoices (page 143) and prints the row count after each step, plus every event
 * BC sends on the filter control (filc) path.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-sticky-filter.ts [pageId] [docNo]
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
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { ClosePageOperation } from '../src/operations/close-page.js';
import { filterControlPath } from '../src/protocol/form-views.js';
import { walkTree } from '../src/protocol/form-tree-walk.js';
import { resolveSection } from '../src/protocol/section-resolver.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCEvent } from '../src/protocol/types.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  const [pageId = '143', docNo] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const pages = new PageService(session, repo, quiet);
  const filters = new FilterService(session, repo, quiet);
  const openPage = new OpenPageOperation(pages);
  const read = new ReadDataOperation(new DataService(session, repo, quiet), filters, new SortService(session, repo, quiet), repo);
  const close = new ClosePageOperation(pages, repo, filters);

  // Log what BC sends on the filter control path.
  const origInvoke = session.invoke.bind(session);
  (session as unknown as { invoke: typeof session.invoke }).invoke = async (i, p, ...rest) => {
    const r = await origInvoke(i, p, ...rest);
    if (i.type === 'Filter' && !isErr(r)) {
      const fc = (r.value as BCEvent[]).filter(e => 'controlPath' in e && String((e as { controlPath: string }).controlPath).includes('/c[') && e.type === 'PropertyChanged');
      console.log(`    Filter(op=${(i as { filterOperation: number }).filterOperation}) -> ${r.value.length} events; types=${[...new Set(r.value.map(e => e.type))].join(',')}`);
      for (const e of fc.slice(0, 6)) console.log(`      ${JSON.stringify(e).slice(0, 300)}`);
    }
    return r;
  };

  let pc = unwrap(await openPage.execute({ pageId })).pageContextId;
  const count = async (label: string, input: Record<string, unknown> = {}): Promise<number> => {
    const r = await read.execute({ pageContextId: pc, ...input } as never);
    if (isErr(r)) { console.log(`${label}: ERR ${r.error.message}`); return -1; }
    const n = r.value.section.rows?.length ?? -1;
    const ctx = repo.get(pc)!;
    const s = resolveSection(ctx, undefined);
    const fpath = 'error' in s ? null : filterControlPath(s.form.root);
    const filc = 'error' in s ? undefined : [...walkTree(s.form.root)].find(x => x.type === 'filc');
    const kids = (filc as { children?: Array<{ type: string; controlPath: string }> } | undefined)?.children ?? [];
    console.log(`${label}: ${n} rows (filc=${fpath}, children: ${kids.map(k => `${k.type}@${k.controlPath}`).join(' ') || 'none'})`);
    return n;
  };

  const base = await count('open');
  const first = (await read.execute({ pageContextId: pc })) as { value?: { section: { rows?: Array<{ cells: Record<string, { stringValue?: string }> }> } } };
  const no = docNo ?? Object.values(first.value?.section.rows?.[0]?.cells ?? {}).find(c => /^\d{6}$/.test(c?.stringValue ?? ''))?.stringValue;
  console.log('doc no:', no, 'base rows:', base);
  await count('clear + Customer No.=10000 + Output Status=Not Sent', { clearFilters: true, filters: [{ column: 'Customer No.', value: '10000' }, ...(process.env.EXTRA_COL ? [{ column: process.env.EXTRA_COL, value: process.env.EXTRA_VAL ?? '' }] : [])] });
  await count(`clear + No.=${no}`, { clearFilters: true, filters: [{ column: 'No.', value: no }] });
  await count('No.=""', { filters: [{ column: 'No.', value: '' }] });
  if (process.env.CLEAR_BEFORE_CLOSE) await count('clearFilters only', { clearFilters: true });
  unwrap(await close.execute({ pageContextId: pc }));
  pc = unwrap(await openPage.execute({ pageId })).pageContextId;
  await count('reopen');
  await count('reopen + clearFilters', { clearFilters: true });
  await count('reopen + clear + Customer No.=10000 + Output Status=Not Sent', { clearFilters: true, filters: [{ column: 'Customer No.', value: '10000' }, ...(process.env.EXTRA_COL ? [{ column: process.env.EXTRA_COL, value: process.env.EXTRA_VAL ?? '' }] : [])] });
  await count('reopen + clear + Customer No.=10000', { clearFilters: true, filters: [{ column: 'Customer No.', value: '10000' }] });

  // Experiments on the stuck filter. EXPERIMENT=execute: Filter(Execute) on the LogicalForm
  // with UserFilter '' (BindingManager.UserFilter.Clear + refill). EXPERIMENT=remove:
  // Filter(RemoveLine) on each filter line (filc/c[N]) until BC refuses.
  const rootFormId = (): string => repo.get(pc)!.rootFormId;
  if (process.env.EXPERIMENT === 'execute' || process.env.EXPERIMENT === 'execute2') {
    const r = await session.invoke({ type: 'Filter', formId: rootFormId(), controlPath: 'server:', filterOperation: 0, userFilter: '' }, e => e.type === 'InvokeCompleted');
    if (!isErr(r)) repo.applyToPage(pc, r.value);
    console.log('execute UserFilter="":', isErr(r) ? r.error.message : 'ok');
  }
  if (process.env.EXPERIMENT === 'execute2') {
    // Then run the filter control itself so FormFilterPersistencePattern.FilterExecuted
    // saves the (now empty) current filters as the session's stored filter.
    const r = await session.invoke({ type: 'Filter', formId: rootFormId(), controlPath: 'server:c[2]', filterOperation: 0, filterColumnId: '', filterValue: '' }, e => e.type === 'InvokeCompleted');
    if (!isErr(r)) repo.applyToPage(pc, r.value);
    console.log('execute filc:', isErr(r) ? r.error.message.slice(0, 160) : `ok (${r.value.length} events)`);
  }
  if (process.env.EXPERIMENT === 'remove') {
    for (let i = 5; i >= 0; i--) {
      const r = await session.invoke({ type: 'Filter', formId: rootFormId(), controlPath: `server:c[2]/c[${i}]`, filterOperation: 2 }, e => e.type === 'InvokeCompleted');
      if (!isErr(r)) repo.applyToPage(pc, r.value);
      console.log(`remove line c[${i}]:`, isErr(r) ? r.error.message.slice(0, 120) : `ok (${r.value.length} events)`);
      if (isErr(r) && /session|dead/i.test(r.error.message)) break;
    }
  }
  if (process.env.EXPERIMENT) {
    await count(`after ${process.env.EXPERIMENT}`);
    unwrap(await close.execute({ pageContextId: pc }));
    pc = unwrap(await openPage.execute({ pageId })).pageContextId;
    await count(`reopen after ${process.env.EXPERIMENT}`);
  }
  await close.execute({ pageContextId: pc });
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
