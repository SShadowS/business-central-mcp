/**
 * Protocol probe — decisive experiment for PATH 1 (imperative upload).
 *
 * Question: does POST DynamicFileUploadHandler.axd?form=<FileUploadForm-dialog-id>
 * actually fire the AL OnUpload trigger when the target is an IMPERATIVE upload
 * (AL Upload/UploadIntoStream builds a FileUploadForm + applies the one-shot
 * token)? All earlier end-to-end attempts used the declarative "Upload
 * Extension..." target, which by construction returns silent 200 (no token is
 * ever applied to a declarative form) — see memory protocol_file_upload.
 *
 * Target: Custom Report Layouts (page 9650), action "Import Layout"
 * (UploadIntoStream in AL base app).
 *
 * Oracles for "the trigger ran" (HTTP 200 alone proves nothing — the handler
 * returns empty 200 when CheckAndRevokeSecurityToken fails):
 *   1. The POST response BODY (dropped by earlier probes): {error: ...} JSON
 *      surfaces AL-side exceptions.
 *   2. Any DialogOpened/MessageToShow/FormCreated arriving AFTER the POST
 *      (import confirmation / validation-error dialog) = AL ran on our stream.
 *   3. Row count of the layouts list changes.
 *
 * Run: BC_BASE_URL=http://cronus28/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default \
 *      npx tsx scripts/probe-imperative-upload.ts
 */
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { buildUploadUrl } from '../src/services/upload-service.js';
import type { BCSession } from '../src/session/bc-session.js';
import type { BCHttpClient } from '../src/connection/bc-http.js';
import type { PageContext } from '../src/protocol/page-context-repo.js';
import type { FormNode } from '../src/protocol/form-node.js';
import type { BCEvent } from '../src/protocol/types.js';
import { isErr, isOk, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };

function nodeTypes(node: FormNode, out: Map<string, string[]> = new Map()): Map<string, string[]> {
  const t = node.type;
  const cap = 'properties' in node ? String((node.properties as Record<string, unknown>).caption ?? '') : '';
  out.set(t, [...(out.get(t) ?? []), cap]);
  if ('children' in node && Array.isArray((node as { children?: FormNode[] }).children)) {
    for (const c of (node as { children: FormNode[] }).children) nodeTypes(c, out);
  }
  return out;
}

function dumpEvents(tag: string, events: BCEvent[]): void {
  const interesting = events.filter(e =>
    e.type === 'DialogOpened' || e.type === 'MessageToShow' || e.type === 'FormCreated' ||
    e.type === 'InvokeCompleted' || e.type === 'PropertyChanged' || e.type === 'DataLoaded');
  console.log(`  [${tag}] ${events.length} events; types: ${events.map(e => e.type).join(',').slice(0, 300)}`);
  for (const e of interesting.slice(0, 20)) {
    const any = e as unknown as Record<string, unknown>;
    console.log(`    - ${e.type} formId=${String(any.formId ?? '').slice(0, 10)} msg=${String(any.message ?? any.caption ?? '').slice(0, 80)}`);
  }
}

async function main(): Promise<void> {
  // Page + action are parameterizable: the original 9650 "Import Layout" turned
  // out to fail with "There is no record in the list." (empty layout list — the
  // generic row-bound-action-on-empty-list error), so the action never reached
  // UploadIntoStream and the "dialog" we POSTed to was an ErrorDialog.
  const pageId = process.argv[2] ?? '9650';
  const actionName = process.argv[3] ?? 'Import Layout';
  const cfg = loadConfig();
  console.log(`probe imperative upload against ${cfg.bc.baseUrl}: page ${pageId}, action "${actionName}"`);
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const http: BCHttpClient = conn.createHttpClient();
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED:', sessRes.error.message); process.exit(1); }
  const session: BCSession = unwrap(sessRes);

  const pageService = new PageService(session, repo, quiet);
  const dataService = new DataService(session, repo, quiet);
  const actionService = new ActionService(session, repo, quiet);
  const readData = new ReadDataOperation(dataService, new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);
  const openPage = new OpenPageOperation(pageService);

  // ---- 1. Open Custom Report Layouts (page 9650) ----
  console.log('\n=== 1. Open page ===');
  const opened = await openPage.execute({ pageId });
  if (isErr(opened)) { console.error('open page failed:', opened.error.message); await session.close(); process.exit(1); }
  const pcId = opened.value.pageContextId;
  const ctx = repo.get(pcId)!;
  const rootForm = ctx.forms.get(ctx.rootFormId)!;
  console.log(`  pageContextId=${pcId} caption="${String((rootForm.root.properties as Record<string, unknown>).caption ?? '?')}"`);
  // Always print row count + every action (incl. section grouping) so target
  // selection is empirical, not from stale page-id memory.
  {
    const { actions } = await import('../src/protocol/form-views.js');
    const acts = actions(rootForm.root);
    console.log(`  actions (${acts.length}): ${acts.map(a => a.properties?.caption ?? a.name ?? '?').join(' | ').slice(0, 600)}`);
  }
  {
    const rows = await readData.execute({ pageContextId: pcId, range: { offset: 0, limit: 5 } });
    console.log(`  rows: ${isOk(rows) ? (rows.value.section.rows ?? []).length : 'read failed'}`);
  }

  // ---- 2. Invoke "Import Layout" (imperative UploadIntoStream) ----
  console.log('\n=== 2. Invoke action "Import Layout" ===');
  // Tap raw frames BEFORE the invoke so every DialogToShow/DialogOpened payload
  // the action produces can be identity-checked: the real FileUploadForm carries
  // MappingHint "FileUploadForm" + a ByteStreamControl; an intermediate dialog
  // (confirm/StrMenu) means UploadIntoStream hasn't run yet and POSTing to THAT
  // dialog would silently no-op (exactly what the picture probe found: its
  // "dialog" was an unrelated "No. Series" task dialog).
  const privPre = session as unknown as { ws: { onMessage: (h: (raw: unknown) => void) => () => void } };
  const rawFrames: unknown[] = [];
  const unsubRaw = privPre.ws.onMessage((raw: unknown) => { rawFrames.push(raw); });
  const act = await actionService.executeAction(pcId, actionName);
  unsubRaw();
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-9650-raw-frames.json', JSON.stringify(rawFrames, null, 2).slice(0, 500_000));
  // Decompress + scan every frame for upload-form identity markers.
  let sawFileUploadForm = false;
  for (const raw of rawFrames) {
    const f = raw as { compressedResult?: string };
    if (!f.compressedResult) continue;
    let decoded: unknown;
    try { decoded = JSON.parse(gunzipSync(Buffer.from(f.compressedResult, 'base64')).toString('utf8')); } catch { continue; }
    const handlers = Array.isArray(decoded) ? (decoded as unknown[]) : [decoded];
    for (const h of handlers) {
      const hh = h as { handlerType?: string; parameters?: unknown[] };
      if (!Array.isArray(hh.parameters)) continue;
      const handlerName = String(hh.handlerType ?? '');
      // Event name rides in parameters[0] for DN.LogicalClientEventRaisingHandler
      // (e.g. "DialogToShow"), NOT in handlerType — the first scan missed it.
      const evt = typeof hh.parameters[0] === 'string' ? hh.parameters[0] : '';
      const payload = JSON.stringify(hh.parameters);
      if (/Dialog|FormCreated/i.test(evt) || payload.includes('FileUploadForm') || payload.includes('ByteStream')) {
        const p0 = hh.parameters[1] ?? hh.parameters[0];
        const obj = (p0 ?? {}) as Record<string, unknown>;
        const cap = String(obj.Caption ?? obj.caption ?? '');
        const hint = String(obj.MappingHint ?? '');
        const msg = String(obj.Message ?? '');
        console.log(`  [frame-scan] ${evt || handlerName.slice(0, 50)} ServerId=${String(obj.ServerId ?? '')} Caption="${cap.slice(0, 60)}" MappingHint="${hint}" Message="${msg.slice(0, 120)}"`);
        if (payload.includes('FileUploadForm')) { sawFileUploadForm = true; console.log('    !! FileUploadForm marker PRESENT in this payload'); }
        if (payload.includes('ByteStream')) console.log('    !! ByteStream marker PRESENT in this payload');
      }
    }
  }
  console.log(`  raw frames: ${rawFrames.length}; FileUploadForm seen: ${sawFileUploadForm}`);
  if (isErr(act)) {
    console.error('  action not found:', act.error.message);
    const avail = (act.error.details as Record<string, unknown>)?.availableActions as string[] | undefined;
    if (avail) console.error('  available actions:', JSON.stringify(avail));
    writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-9650-state.json', JSON.stringify({ sections: [...ctx.sections.keys()], forms: [...ctx.forms.keys()] }, null, 2));
    await session.close(); process.exit(1);
  }
  console.log('  action invoked.');
  dumpEvents('import-layout-invoke', act.value.events);

  // ---- 3. Find the FileUploadForm dialog opened by the action ----
  console.log('\n=== 3. Locate FileUploadForm dialog ===');
  const ctxAfter = repo.get(pcId)!;
  console.log(`  ctx.dialogs: ${JSON.stringify(ctxAfter.dialogs.map(d => ({ formId: d.formId.slice(0, 10), caption: d.caption ?? '' })))}`);
  const dialogFormId = ctxAfter.dialogs.length > 0 ? ctxAfter.dialogs[ctxAfter.dialogs.length - 1]!.formId : undefined;
  if (!dialogFormId) {
    console.error('  NO dialog opened by "Import Layout" — the action may not be imperative, or it opened as a form.');
    dumpEvents('all-action-events', act.value.events);
    writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-9650-action-events.json', JSON.stringify(act.value.events, null, 2));
    await session.close(); process.exit(1);
  }
  console.log(`  dialog formId=${dialogFormId}`);
  const dialogForm = ctxAfter.forms.get(dialogFormId);
  if (dialogForm) {
    const types = nodeTypes(dialogForm.root);
    console.log('  dialog control types: ' + [...types.entries()].map(([t, caps]) => `${t}(${caps.length})${caps[0] ? `:"${caps[0]}"` : ''}`).join(', '));
    writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-fileuploadform-tree.json', JSON.stringify(dialogForm.root, null, 2));
  } else {
    console.log('  (dialog form not in ctx.forms — tree not built)');
  }

  // ---- 4. POST the file to DynamicFileUploadHandler.axd ----
  // A/B mode: `npx tsx scripts/probe-imperative-upload.ts nopost` skips the POST
  // entirely (dialog opened, then closed with no file). If the post-close async
  // frame in that run shows NO Query/Built-In filter change on the main form,
  // the filter change seen in POST runs is attributable to AL consuming OUR
  // uploaded file — airtight proof the trigger ran on our stream.
  const nopost = process.argv.includes('nopost');
  const probeName = process.argv.find(a => a.endsWith('.txt')) ?? 'probe-layout.txt';
  console.log('\n=== 4. POST file to DynamicFileUploadHandler.axd ===');
  let post: { status: number; body: string } = { status: 0, body: '(skipped — nopost A/B control run)' };
  if (!nopost) {
    // Garbage .txt: AL's Import Layout validates the file type and may show a
    // "file type not supported"-style error dialog — an error dialog after
    // CloseForm would be airtight proof the AL trigger ran on OUR file.
    const bytes = Buffer.from('not a layout file — probe-imperative-upload\n', 'utf-8');
    const csrfToken = await http.fetchCsrfToken();
    const url = buildUploadUrl(dialogFormId, session.serverSessionId);
    console.log(`  POST ${url.slice(0, 60)}... (${bytes.byteLength} bytes, fileName=${probeName})`);
    post = await http.postFile(url, { bytes, fileName: probeName, contentType: 'text/plain' }, { csrfToken });
    console.log(`  POST result: status=${post.status} body="${post.body.slice(0, 200)}"`);
    if (post.body.includes('error')) console.log('  !! SERVER RETURNED AN ERROR JSON — AL-side exception surfaced');
  } else {
    console.log('  (nopost mode: skipping the POST — A/B control)');
  }

  // ---- 5. Close the FileUploadForm — what the web client does after a
  // successful POST (client.js FileUploadDropAdapter:
  //   `e.logicalControl.rootForm.close().finally(s)` after `i.post(o)`)
  // This makes the server-side ShowDialog return, so FileOpen returns
  // byteStreamControl.Value and AL's UploadIntoStream RESUMES.
  // Without it the AL trigger stays suspended and any other invoke violates
  // modal modality (exactly the LogicalModalityViolation + session death the
  // first probe run hit).
  console.log('\n=== 5. CloseForm the upload dialog ===');
  // Tap raw WS frames to see async events arriving between invokes
  const priv = session as unknown as { ws: { onMessage: (h: (raw: unknown) => void) => () => void } };
  const asyncFrames: unknown[] = [];
  const unsub = priv.ws.onMessage((raw: unknown) => { asyncFrames.push(raw); });
  await new Promise(r => setTimeout(r, 1000));
  console.log(`  async frames during 1s wait: ${asyncFrames.length}`);

  const close = await session.invoke(
    { type: 'CloseForm', formId: dialogFormId },
    (e) => e.type === 'InvokeCompleted' || e.type === 'FormClosed' || e.type === 'DialogOpened' || e.type === 'MessageToShow' || e.type === 'FormCreated' || e.type === 'PropertyChanged',
  );
  if (isOk(close)) {
    dumpEvents('close-upload-dialog', close.value);
    // AL resumed after the close — give trailing async events time to arrive
    await new Promise(r => setTimeout(r, 1500));
  } else {
    console.log('  CloseForm failed:', close.error.message);
  }
  unsub();
  console.log(`  async frames total (incl. 1.5s post-close wait): ${asyncFrames.length}`);
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-async-frames.json', JSON.stringify(asyncFrames, null, 2).slice(0, 200_000));

  // ---- 6. Observe AL side effects ----
  console.log('\n=== 6. Observe AL side effects (did Import Layout resume on our stream?) ===');
  const after = (await readData.execute({ pageContextId: pcId, range: { offset: 0, limit: 50 } }));
  const afterRows = isOk(after) ? (after.value.section.rows ?? []).length : -1;
  console.log(`  layouts rows after: ${afterRows} (was 0 before upload)`);

  console.log('\n================ VERDICT ================');
  console.log(`  POST status: ${post.status}, body: "${post.body.slice(0, 100)}"`);
  console.log(`  close events: ${isOk(close) ? close.value.map(e => e.type).join(',') : 'FAILED: ' + close.error.message}`);
  const alActivity = (isOk(close) && close.value.some(e => e.type === 'DialogOpened' || e.type === 'MessageToShow' || e.type === 'FormCreated')) || afterRows !== 0;
  console.log(alActivity
    ? '  => AL ACTIVITY OBSERVED — UploadIntoStream resumed after CloseForm (see events above)'
    : '  => no observable AL activity — inspect C:/Users/SShadowS/AppData/Local/Temp/probe-async-frames.json for raw frames');

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
