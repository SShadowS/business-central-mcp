/**
 * Probe (issue #53): where does an error raised AFTER a confirm go?
 * Creates a draft Sales Invoice with one Item line at Quantity 0, Posts it, answers
 * Yes to both confirms (Sales-Post then refuses with "There is nothing to post"),
 * and logs every raw frame with a timestamp for 5s after the last Yes. Deletes the
 * draft invoice at the end.
 *
 * Run: BC_BASE_URL=http://cronus291/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-post-error.ts [customerNo] [itemNo]
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
import { DataService } from '../src/services/data-service.js';
import { ActionService } from '../src/services/action-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { DownloadService } from '../src/services/download-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { WriteDataOperation } from '../src/operations/write-data.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { RespondDialogOperation } from '../src/operations/respond-dialog.js';
import { decompressPayload } from '../src/protocol/decompression.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };
const t0 = Date.now();
const ts = (): string => `+${String(Date.now() - t0).padStart(6)}ms`;

async function main(): Promise<void> {
  const [customerNo = '10000', itemNo = '1896-S'] = process.argv.slice(2);
  const cfg = loadConfig();
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const decoder = new EventDecoder();
  const sf = new SessionFactory(conn, decoder, new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const session = unwrap(await sf.create());
  const actionService = new ActionService(session, repo, quiet);
  const download = new DownloadService(conn.createHttpClient(), conn.httpBaseUrl, cfg.bc.downloadLimits, quiet);
  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const write = new WriteDataOperation(new DataService(session, repo, quiet), repo);
  const exec = new ExecuteActionOperation(actionService, repo, new NavigationService(session, repo, quiet), download, 100);
  const respond = new RespondDialogOperation(session, repo, download);

  // Raw frame log: every message on the socket, decoded to event types.
  let logFrames = false;
  (session as unknown as { ws: { onMessage(h: (raw: unknown) => void): () => void } }).ws.onMessage((raw) => {
    if (!logFrames || !raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    const kind = 'id' in msg ? `response id=${String(msg['id'])}` : `notify ${String(msg['method'])}`;
    let data: unknown;
    const p = (msg['params'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const res = msg['result'] as Record<string, unknown> | undefined;
    const compressed = (p?.['compressedData'] ?? res?.['compressedResult'] ?? msg['compressedResult']) as string | undefined;
    if (compressed) { const d = decompressPayload(compressed); if (!isErr(d)) data = d.value; }
    if (Array.isArray(data)) {
      const handlers = (data as Array<Record<string, unknown>>).map(h => String(h['handlerType'] ?? h['handler'] ?? '?'));
      console.log(`    handlers: ${handlers.join(', ')}`);
      const text = JSON.stringify(data);
      if (/nothing to post/i.test(text)) writeFileSync(process.env.DUMP ?? 'post-error-frame.json', JSON.stringify(data, null, 1));
      for (const m of text.matchAll(/nothing to post|"(?:Message|ErrorMessage|Text)":"[^"]{0,200}"/gi)) console.log(`    hit: ${m[0]}`);
    }
    const events = Array.isArray(data) ? decoder.decode(data) : [];
    const summary = events.map(e => {
      if (e.type === 'DialogOpened') { const t = e.controlTree as Record<string, unknown>; return `DialogOpened(${String(t?.['MappingHint'])}: ${String(t?.['Message'] ?? t?.['Caption'])})`; }
      if (e.type === 'MessageToShow') return `MessageToShow(${e.messageType}: ${e.text})`;
      if (e.type === 'InvokeCompleted') return `InvokeCompleted(${e.completedInteractions.map(c => c.invocationId.slice(0, 8)).join(',')})`;
      return e.type;
    });
    console.log(`${ts()} ${kind} ${'error' in msg ? `ERROR ${JSON.stringify(msg['error'])}` : ''} ${summary.join(' | ')}`);
    if (events.length === 0) console.log(`    RAW: ${JSON.stringify(data ?? msg).slice(0, 4000)}`);
  });

  const card = unwrap(await openPage.execute({ pageId: '43' }));
  const nw = unwrap(await exec.execute({ pageContextId: card.pageContextId, action: 'New' }));
  const pc = nw.openedPages?.[0]?.pageContextId ?? card.pageContextId;
  console.log('New ->', pc);
  console.log('customer:', JSON.stringify(unwrap(await write.execute({ pageContextId: pc, fields: { 'Customer No.': customerNo } })).results ?? 'ok'));
  console.log('line New:', isErr(await exec.execute({ pageContextId: pc, action: 'New', section: 'lines' })) ? 'ERR' : 'ok');
  const lw = await write.execute({ pageContextId: pc, section: 'lines', rowIndex: 0, fields: { Type: 'Item', 'No.': itemNo, Quantity: '0' } });
  console.log('line write:', isErr(lw) ? lw.error.message : 'ok');

  try {
    logFrames = true;
    console.log(`${ts()} --- Post`);
    let r: unknown = unwrap(await exec.execute({ pageContextId: pc, action: 'Post' }));
    for (let i = 0; i < 3; i++) {
      const dialogs = (r as { dialogsOpened?: Array<{ pageContextId: string; formId: string; message?: string }> }).dialogsOpened ?? [];
      if (dialogs.length === 0) break;
      const d = dialogs[0]!;
      console.log(`${ts()} --- answering Yes to "${d.message}"`);
      const a = await respond.execute({ pageContextId: d.pageContextId, dialogFormId: d.formId, response: 'yes' });
      r = isErr(a) ? { error: a.error.message } : a.value;
      console.log(`${ts()} --- respond result: ${JSON.stringify(r)}`);
    }
    await new Promise(res => setTimeout(res, 5000));
    console.log(`${ts()} --- modal stack after 5s: ${JSON.stringify(session.modalStackSnapshot())}`);
  } finally {
    logFrames = false;
    // Clean up: dismiss any leftover dialog, then delete the draft invoice.
    for (const f of session.modalStackSnapshot().reverse()) await session.invoke({ type: 'CloseForm', formId: f }, e => e.type === 'InvokeCompleted');
    const del = await exec.execute({ pageContextId: pc, action: 'Delete' });
    const dd = isErr(del) ? [] : (del.value as { dialogsOpened?: Array<{ pageContextId: string; formId: string }> }).dialogsOpened ?? [];
    if (dd[0]) {
      const y = await respond.execute({ pageContextId: dd[0].pageContextId, dialogFormId: dd[0].formId, response: 'yes' });
      console.log('delete:', isErr(y) ? y.error.message : 'ok');
    } else console.log('delete:', isErr(del) ? del.error.message : 'no confirm?');
    await session.close();
  }
  process.exit(0);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
