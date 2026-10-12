/**
 * Protocol probe — PATH 1 (imperative upload) with a REAL file and a REAL
 * observable side effect: upload a PNG as an Item picture.
 *
 * Flow (all verified from decompiled source):
 *   1. Item Card -> Picture field is an editable ByteStreamControl
 *      (SelectFileForByteStreamAction.CanInvoke).
 *   2. AssistEdit (SystemAction 100) on the picture control ->
 *      NavWebFileDialogProvider.FileOpen -> FileUploadForm dialog (token
 *      applied) shown as DialogOpened.
 *   3. POST the PNG to DynamicFileUploadHandler.axd?form=<dialog formId>
 *      (feeds the dialog's ByteStreamControl, sets Caption=fileName).
 *   4. CloseForm the dialog -> ShowDialog returns -> FileOpen returns the
 *      stream -> SelectFileForByteStreamAction.InvokeCore ReadStreamAsync
 *      copies it into the CARD's picture control (client.js does exactly this:
 *      rootForm.close() after i.post(o)).
 *
 * Oracle: a PropertyChanged on the card's picture control (value/media set),
 * a UriToShow image URL, or the picture field reading back non-empty after
 * the upload. A/B control: `nopost` arg skips step 3.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default \
 *      npx tsx scripts/probe-picture-upload.ts [nopost]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { PageContextRepository } from '../src/protocol/page-context-repo.js';
import { PageService } from '../src/services/page-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { buildUploadUrl } from '../src/services/upload-service.js';
import { SystemAction } from '../src/protocol/types.js';
import { isErr, isOk, unwrap } from '../src/core/result.js';
import type { BCSession } from '../src/session/bc-session.js';
import type { BCHttpClient } from '../src/connection/bc-http.js';
import type { BCEvent } from '../src/protocol/types.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };

const PNG_PATH = 'U:/git/bc-mcp/bc-customer-list.png';

function dumpEvents(tag: string, events: BCEvent[]): void {
  console.log(`  [${tag}] ${events.length} events; types: ${events.map(e => e.type).join(',').slice(0, 300)}`);
  for (const e of events.slice(0, 25)) {
    const any = e as unknown as Record<string, unknown>;
    console.log(`    - ${e.type} formId=${String(any.formId ?? '').slice(0, 10)} controlPath=${String(any.controlPath ?? '')} msg=${String(any.message ?? any.caption ?? any.uri ?? '').slice(0, 100)}`);
  }
}

async function main(): Promise<void> {
  const nopost = process.argv[2] === 'nopost';
  const cfg = loadConfig();
  console.log(`probe picture upload against ${cfg.bc.baseUrl}${nopost ? ' (nopost A/B control)' : ''}`);
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
  const navService = new NavigationService(session, repo, quiet);

  // ---- 1. Open Item List (31), take the first row, drill into the card ----
  console.log('\n=== 1. Open Item List + drill into first item card ===');
  const { OpenPageOperation } = await import('../src/operations/open-page.js');
  const { ReadDataOperation } = await import('../src/operations/read-data.js');
  const { DataService } = await import('../src/services/data-service.js');
  const { FilterService } = await import('../src/services/filter-service.js');
  const { SortService } = await import('../src/services/sort-service.js');
  const { ActionService } = await import('../src/services/action-service.js');
  const dataService = new DataService(session, repo, quiet);
  const readData = new ReadDataOperation(dataService, new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo);
  const actionService = new ActionService(session, repo, quiet);

  const opened = await new OpenPageOperation(pageService).execute({ pageId: '31' });
  if (isErr(opened)) { console.error('open page 31 failed:', opened.error.message); await session.close(); process.exit(1); }
  const listPc = opened.value.pageContextId;
  const read = await readData.execute({ pageContextId: listPc, range: { offset: 0, limit: 3 } });
  const rows = isOk(read) ? (read.value.section.rows ?? []) : [];
  console.log(`  item list rows: ${rows.length}; first: ${rows[0]?.cells?.['No.'] ?? rows[0]?.cells?.['No'] ?? JSON.stringify(Object.keys(rows[0]?.cells ?? {})).slice(0, 120)}`);
  if (rows.length === 0) { console.error('no items — aborting'); await session.close(); process.exit(1); }

  const drill = await navService.drillDown(listPc, rows[0]!.bookmark, read.value.section.sectionId ?? 'header');
  if (isErr(drill)) { console.error('drillDown failed:', drill.error.message); await session.close(); process.exit(1); }
  const cardPc = drill.value.targetPageContext.pageContextId;
  console.log(`  card pageContextId=${cardPc}`);

  // ---- 2. Find the Picture field on the card ----
  // The picture lives in a CardPart hosted by an fhc (FormHostContainer) — a
  // SEPARATE form with its own formId. Last run's AssistEdit against the card
  // root form's server:c[12] resolved to the card's "No." field (its AssistEdit
  // opens the "No. Series" dialog) — proof the path belongs to another form.
  // So: search EVERY form in the page context, and target the form that
  // actually owns the picture node.
  console.log('\n=== 2. Find the Picture control (across all forms in the page context) ===');
  const ctx = repo.get(cardPc)!;
  console.log(`  forms in context: ${[...ctx.forms.keys()].map(k => k.slice(0, 8)).join(', ')} (root=${ctx.rootFormId.slice(0, 8)})`);
  type Hit = { formId: string; path: string; caption: string; binder: string; type: string };
  const hits: Hit[] = [];
  for (const [formId, form] of ctx.forms) {
    const walk = (node: unknown): void => {
      const n = node as { type: string; controlPath: string; properties?: Record<string, unknown>; columnBinder?: { name: string }; children?: unknown[] };
      if (!n || !n.type) return;
      const cap = String(n.properties?.caption ?? '');
      const binder = n.columnBinder?.name ?? '';
      if (n.controlPath && (/picture/i.test(cap) || /picture/i.test(binder))) {
        hits.push({ formId, path: n.controlPath, caption: cap, binder, type: n.type });
      }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(form.root);
  }
  console.log(`  picture nodes found: ${JSON.stringify(hits, null, 1)}`);
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-card-forms.json',
    JSON.stringify([...ctx.forms.entries()].map(([fid, f]) => {
      const nodes: unknown[] = [];
      const walk = (node: unknown): void => {
        const n = node as { type: string; controlPath: string; properties?: Record<string, unknown>; children?: unknown[] };
        if (!n || !n.type) return;
        if (n.controlPath) nodes.push({ t: n.type, path: n.controlPath, cap: String((n.properties as Record<string, unknown> | undefined)?.caption ?? '') });
        if (Array.isArray(n.children)) n.children.forEach(walk);
      };
      walk(f.root);
      return { formId: fid, nodes };
    }), null, 2));
  const picture = hits.find(h => h.formId !== ctx.rootFormId) ?? hits[0];
  if (!picture) {
    console.error('  no picture node in any form — inspect probe-card-forms.json');
    await session.close(); process.exit(1);
  }
  console.log(`  target: formId=${picture.formId} path=${picture.path} (type=${picture.type})`);

  // ---- 3. AssistEdit (100) on the picture control -> FileUploadForm dialog ----
  console.log('\n=== 3. AssistEdit(100) on the picture control ===');
  // Tap raw frames BEFORE the invoke so the DialogOpened handler payload (the
  // dialog's control tree, incl. MappingHint "FileUploadForm" + the
  // ByteStreamControl) is captured for direct inspection.
  const tapPre = session as unknown as { ws: { onMessage: (h: (raw: unknown) => void) => () => void } };
  const preFrames: unknown[] = [];
  const unsubPre = tapPre.ws.onMessage((raw: unknown) => { preFrames.push(raw); });
  const assist = await session.invoke(
    { type: 'InvokeAction', formId: picture!.formId, controlPath: picture!.path, systemAction: SystemAction.AssistEdit },
    (e) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'MessageToShow',
  );
  if (isErr(assist)) { console.error('AssistEdit failed:', assist.error.message); await session.close(); process.exit(1); }
  unsubPre();
  dumpEvents('assistedit', assist.value);
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-assist-raw-frames.json', JSON.stringify(preFrames, null, 2).slice(0, 500_000));
  console.log(`  raw frames captured during assist invoke: ${preFrames.length} (dumped to probe-assist-raw-frames.json)`);
  // Identity-check every dialog/form the invoke produced: the real
  // FileUploadForm carries MappingHint "FileUploadForm".
  {
    const { gunzipSync } = await import('node:zlib');
    for (const raw of preFrames) {
      const f = raw as { compressedResult?: string };
      if (!f.compressedResult) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(gunzipSync(Buffer.from(f.compressedResult, 'base64')).toString('utf8')); } catch { continue; }
      for (const h of Array.isArray(decoded) ? (decoded as unknown[]) : [decoded]) {
        const hh = h as { handlerType?: string; parameters?: unknown[] };
        if (!Array.isArray(hh.parameters)) continue;
        const evt = typeof hh.parameters[0] === 'string' ? hh.parameters[0] : '';
        const payload = JSON.stringify(hh.parameters);
        if (/Dialog|FormCreated/i.test(evt) || payload.includes('FileUploadForm')) {
          const p = (hh.parameters[1] ?? {}) as Record<string, unknown>;
          console.log(`  [frame-scan] ${evt} ServerId=${String(p.ServerId ?? '')} Caption="${String(p.Caption ?? '').slice(0, 60)}" MappingHint="${String(p.MappingHint ?? '')}" Message="${String(p.Message ?? '').slice(0, 120)}"`);
        }
      }
    }
  }
  const ctxAfter = repo.get(cardPc)!;
  // ctx.dialogs tracking missed it on the last run — take the DialogOpened
  // straight from the invoke events (it IS the upload dialog; the repo's dialog
  // tracker is a separate gap).
  const dialogEvent = assist.value.find(e => e.type === 'DialogOpened') as { formId: string } | undefined;
  const dialogFormId = ctxAfter.dialogs.length > 0
    ? ctxAfter.dialogs[ctxAfter.dialogs.length - 1]!.formId
    : dialogEvent?.formId;
  if (!dialogFormId) {
    console.error('  NO upload dialog opened — picture AssistEdit may not use SelectFileForByteStreamAction here.');
    writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-assistedit-events.json', JSON.stringify(assist.value, null, 2));
    await session.close(); process.exit(1);
  }
  console.log(`  FileUploadForm dialog formId=${dialogFormId}`);

  // ---- 4. POST the real PNG ----
  console.log('\n=== 4. POST real PNG to DynamicFileUploadHandler.axd ===');
  const tap = session as unknown as { ws: { onMessage: (h: (raw: unknown) => void) => () => void } };
  const asyncFrames: unknown[] = [];
  const unsub = tap.ws.onMessage((raw: unknown) => { asyncFrames.push(raw); });
  if (!nopost) {
    const png = readFileSync(PNG_PATH);
    console.log(`  uploading ${PNG_PATH} (${png.byteLength} bytes)`);
    const csrfToken = await http.fetchCsrfToken();
    const url = buildUploadUrl(dialogFormId, session.serverSessionId);
    const post = await http.postFile(url, { bytes: png, fileName: 'probe-picture.png', contentType: 'image/png' }, { csrfToken });
    console.log(`  POST result: status=${post.status} body="${post.body.slice(0, 200)}"`);
  } else {
    console.log('  (nopost mode: skipping the POST — A/B control)');
  }
  await new Promise(r => setTimeout(r, 1000));

  // ---- 5. CloseForm the dialog -> AL/ReadStreamAsync resumes ----
  console.log('\n=== 5. CloseForm the upload dialog ===');
  const close = await session.invoke(
    { type: 'CloseForm', formId: dialogFormId },
    (e) => e.type === 'InvokeCompleted' || e.type === 'FormClosed' || e.type === 'PropertyChanged' || e.type === 'UriToShow' || e.type === 'DialogOpened' || e.type === 'MessageToShow',
  );
  if (isOk(close)) dumpEvents('close-upload-dialog', close.value);
  else console.log('  CloseForm failed:', close.error.message);
  await new Promise(r => setTimeout(r, 1500));
  unsub();
  // Full payloads (mode-suffixed) for the POST-vs-nopost diff: the discriminator
  // is a Caption PropertyChanged on the dialog's ByteStreamControl
  // (SaveStreamToLogicalControlAsync sets Caption=fileName during the POST).
  const mode = nopost ? 'nopost' : 'post';
  writeFileSync(`C:/Users/SShadowS/AppData/Local/Temp/probe-pic-close-events-${mode}.json`, JSON.stringify(isOk(close) ? close.value : [], null, 2));
  writeFileSync(`C:/Users/SShadowS/AppData/Local/Temp/probe-pic-async-frames-${mode}.json`, JSON.stringify(asyncFrames, null, 2).slice(0, 500_000));
  console.log(`  async frames captured: ${asyncFrames.length}`);

  // ---- 6. Read back the picture field ----
  console.log('\n=== 6. Read back the card state (picture set?) ===');
  const ctxFinal = repo.get(cardPc)!;
  const cardFinal = ctxFinal.forms.get(ctxFinal.rootFormId)!;
  const finalFields: Array<{ path: string; caption: string; binder: string; value: unknown }> = [];
  const walk2 = (node: unknown): void => {
    const n = node as { type: string; controlPath: string; properties?: Record<string, unknown>; columnBinder?: { name: string }; children?: unknown[] };
    if (!n || !n.type) return;
    const cap = String(n.properties?.caption ?? '');
    const binder = n.columnBinder?.name ?? '';
    if (n.controlPath && (/picture/i.test(cap) || /picture/i.test(binder))) {
      finalFields.push({ path: n.controlPath, caption: cap, binder, value: n.properties?.stringValue ?? n.properties?.objectValue ?? n.properties });
    }
    if (Array.isArray(n.children)) n.children.forEach(walk2);
  };
  walk2(cardFinal.root);
  console.log('  picture control after upload:', JSON.stringify(finalFields, null, 2).slice(0, 1500));

  console.log('\n================ VERDICT ================');
  const closeEvents = isOk(close) ? close.value : [];
  const uriEvents = closeEvents.filter(e => e.type === 'UriToShow');
  const propEvents = closeEvents.filter(e => e.type === 'PropertyChanged');
  console.log(`  UriToShow events: ${uriEvents.length}; PropertyChanged: ${propEvents.length}`);
  const success = uriEvents.length > 0 || finalFields.some(f => f.value !== null && f.value !== undefined && f.value !== '' && f.value !== {});
  console.log(success
    ? '  => PICTURE SET — imperative upload works end-to-end (POST + CloseForm)'
    : '  => picture appears unchanged — inspect probe-pic-async-frames.json and the card dump above');

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
