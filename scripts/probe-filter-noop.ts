/**
 * Probe, read-only: why does Filter(AddLine) leave the rows unchanged on some servers?
 * Opens a list page, applies one filter through FilterService, then a raw SaveValue on the
 * filter line's value control, and prints every raw handler BC answers with
 * (LogicalClientChange entries in full, other handlers by type). Found that BC 23.3 ignores
 * AddLine's FilterValue while SaveValue on the line filters.
 *
 * Run: BC_ENV_FILE=.env [LINE_INDEX=2] npx tsx scripts/probe-filter-noop.ts [pageId] [column] [value]
 */
import { loadDotenv } from '../src/core/dotenv-loader.js';
import { loadConfig } from '../src/core/config.js';
import { createAuthProvider } from '../src/connection/auth/create-auth-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { applicationIdProbeFor } from '../src/connection/application-id-probe.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { FilterService } from '../src/services/filter-service.js';
import { decompressPayload } from '../src/protocol/decompression.js';
import { filterControlPath } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  loadDotenv();
  const [pageId = '22', column = 'No.', value = '10000'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = createAuthProvider(cfg, quiet, {});
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId), quiet, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs, cfg.bc.profile,
    { pollIntervalMs: cfg.bc.isExecutingPollIntervalMs, maxDurationMs: cfg.bc.invokeMaxDurationMs }, applicationIdProbeFor(cfg.bc)).create());
  const pages = new PageService(session, repo, quiet);
  const filters = new FilterService(session, repo, quiet);
  const page = unwrap(await pages.openPage(pageId));
  const root = page.forms.get(page.rootFormId)!.root;
  console.log('filc:', filterControlPath(root));

  let on = false;
  (session as unknown as { ws: { onMessage(h: (raw: unknown) => void): () => void } }).ws.onMessage((raw) => {
    if (!on || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    const p = (m['params'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const res = m['result'] as Record<string, unknown> | undefined;
    const c = (p?.['compressedData'] ?? res?.['compressedResult'] ?? m['compressedResult']) as string | undefined;
    if (!c) { console.log('   (uncompressed)', JSON.stringify(raw).slice(0, 600)); return; }
    const d = decompressPayload(c);
    if (isErr(d) || !Array.isArray(d.value)) return;
    for (const h of d.value as Array<{ handlerType: string; parameters: unknown[] }>) {
      if (h.handlerType !== 'DN.LogicalClientChangeHandler') { console.log(`  ${h.handlerType} ${JSON.stringify(h.parameters).slice(0, 400)}`); continue; }
      for (const ch of (h.parameters[1] as Array<Record<string, unknown>>) ?? []) {
        console.log(`   change ${JSON.stringify(ch, (k, v) => (k === "Items" ? `[${v.length} items]` : v))}`);
      }
    }
  });

  on = true;
  console.log(`--- AddLine ${column}=${value}`);
  const r = await filters.applyFilters(page.pageContextId, [{ column, value }]);
  if (isErr(r)) console.log('applyFilters error:', r.error.message);
  const rows = () => [...(repo.get(page.pageContextId)!.forms.get(page.rootFormId)!.rows.values())][0]?.length;
  console.log('rows after AddLine:', rows());
  const fvc = `${filterControlPath(root)}/c[${process.env.LINE_INDEX ?? '2'}]/c[1]`;
  console.log(`--- SaveValue ${fvc} = ${value}`);
  const sv = await session.invoke({ type: 'SaveValue', formId: page.rootFormId, controlPath: fvc, newValue: value }, (e) => e.type === 'InvokeCompleted' || e.type === 'DataLoaded');
  if (isErr(sv)) console.log('SaveValue error:', sv.error.message);
  else { repo.applyToPage(page.pageContextId, sv.value); console.log('events:', sv.value.map(e => e.type).join(',')); }
  console.log('rows after SaveValue:', rows());
  on = false;
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
