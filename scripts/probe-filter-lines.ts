/**
 * Probe (issue #57), read-only: which raw changes does BC send for the filter control
 * (filc) on Filter(AddLine) and Filter(Reset)? Prints every change whose ControlReference
 * path starts with the filc path, with its wire type.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-filter-lines.ts [pageId] [column] [value]
 */
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { FilterService } from '../src/services/filter-service.js';
import { decompressPayload } from '../src/protocol/decompression.js';
import { filterControlPath } from '../src/protocol/form-views.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

async function main(): Promise<void> {
  const [pageId = '22', column = 'No.', value = '10000'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const session = unwrap(await new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId).create());
  const pages = new PageService(session, repo, quiet);
  const filters = new FilterService(session, repo, quiet);
  const page = unwrap(await pages.openPage(pageId));
  const fpath = filterControlPath(page.forms.get(page.rootFormId)!.root)!;
  console.log('filc:', fpath);

  let on = false;
  (session as unknown as { ws: { onMessage(h: (raw: unknown) => void): () => void } }).ws.onMessage((raw) => {
    if (!on || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    const p = (m['params'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const c = (p?.['compressedData'] ?? m['compressedResult']) as string | undefined;
    if (!c) return;
    const d = decompressPayload(c);
    if (isErr(d) || !Array.isArray(d.value)) return;
    for (const h of d.value as Array<{ handlerType: string; parameters: unknown[] }>) {
      if (h.handlerType !== 'DN.LogicalClientChangeHandler') continue;
      for (const ch of (h.parameters[1] as Array<Record<string, unknown>>) ?? []) {
        const path = (ch['ControlReference'] as { controlPath?: string } | undefined)?.controlPath ?? '';
        if (path.startsWith(fpath)) console.log(`   ${String(ch['t'])} ${path} ${JSON.stringify(ch).slice(0, 260)}`);
      }
    }
  });

  on = true;
  console.log(`--- AddLine ${column}=${value}`);
  unwrap(await filters.applyFilters(page.pageContextId, [{ column, value }]));
  console.log('--- AddLine Name=A*');
  unwrap(await filters.applyFilters(page.pageContextId, [{ column: 'Name', value: 'A*' }]));
  console.log('--- Reset');
  unwrap(await filters.clearFilters(page.pageContextId));
  on = false;
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
