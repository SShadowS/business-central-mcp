/**
 * Seed probe: create one Custom Report Layout row on page 9650 so the
 * "Import Layout" action (imperative UploadIntoStream) has a current row.
 * The decisive upload probe needs this because invoking Import Layout on the
 * empty list errors with "There is no record in the list." before ever
 * reaching UploadIntoStream.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-seed-9650.ts
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
import { ActionService } from '../src/services/action-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { fields as treeFields } from '../src/protocol/form-views.js';
import { isErr, isOk, unwrap } from '../src/core/result.js';
import type { BCSession } from '../src/session/bc-session.js';
import type { BCEvent } from '../src/protocol/types.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`seed 9650 against ${cfg.bc.baseUrl}`);
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED:', sessRes.error.message); process.exit(1); }
  const session: BCSession = unwrap(sessRes);

  const pageService = new PageService(session, repo, quiet);
  const actionService = new ActionService(session, repo, quiet);

  const opened = await new OpenPageOperation(pageService).execute({ pageId: '9650' });
  if (isErr(opened)) { console.error('open 9650 failed:', opened.error.message); await session.close(); process.exit(1); }
  const pcId = opened.value.pageContextId;
  console.log(`  opened ${pcId}`);

  const act = await actionService.executeAction(pcId, 'New...');
  if (isErr(act)) { console.error('New... failed:', act.error.message); await session.close(); process.exit(1); }
  console.log(`  New... invoked; events: ${act.value.events.map(e => e.type).join(',')}`);
  const dlg = act.value.dialog;
  console.log(`  dialog: ${dlg ? `${dlg.formId.slice(0, 8)} (tree keys: ${Object.keys((dlg.controlTree as Record<string, unknown>) ?? {}).join(',')})` : 'none'}`);
  if (dlg) writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-9650-new-tree.json', JSON.stringify(dlg.controlTree, null, 2));

  // Dump every form now in the context (the dialog's tree) for offline design
  // of the fill+OK step.
  const ctx = repo.get(pcId)!;
  const dump: unknown[] = [];
  for (const [fid, form] of ctx.forms) {
    const fs = treeFields(form.root).map(f => ({ path: f.controlPath, caption: f.properties?.caption ?? '', type: f.type, value: f.properties?.stringValue ?? f.properties?.objectValue ?? null, options: (f.properties as Record<string, unknown> | undefined)?.options ?? null }));
    dump.push({ formId: fid, caption: (form.root.properties as Record<string, unknown>)?.caption ?? '', fields: fs });
  }
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-9650-new-dialog.json', JSON.stringify(dump, null, 2));
  console.log(`  forms dumped: ${dump.length} -> probe-9650-new-dialog.json`);
  for (const d of dump as Array<{ formId: string; caption: unknown; fields: Array<{ caption: string; type: string; value: unknown }> }>) {
    console.log(`  - form ${d.formId.slice(0, 8)} "${String(d.caption).slice(0, 40)}": ${d.fields.map(f => `${f.caption}(${f.type})=${String(f.value ?? '').slice(0, 20)}`).slice(0, 12).join(', ')}`);
  }

  // ---- Fill the 9651 "Insert Built-in Layout" dialog and press OK ----
  // Raw tree (probe-9650-new-tree.json): Children[1]=Report ID (i32c),
  // Children[3]="Insert Word Layout" (bc, StringValue "No"), OK via the
  // respond-dialog pattern: InvokeAction{controlPath:'server:c[0]', systemAction:Ok}.
  if (dlg) {
    const REPORT_ID = process.env.SEED_REPORT_ID ?? '1306'; // Standard Sales - Invoice
    const sv = async (controlPath: string, newValue: string) => {
      const r = await session.invoke(
        { type: 'SaveValue', formId: dlg.formId, controlPath, newValue },
        (e: BCEvent) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'MessageToShow',
      );
      console.log(`  SaveValue ${controlPath}="${newValue}": ${isOk(r) ? r.value.map(e => e.type).join(',') : 'ERR ' + r.error.message}`);
      if (isOk(r)) repo.applyToPage(pcId, r.value);
      return isOk(r);
    };
    if (!await sv('server:c[1]', REPORT_ID)) { await session.close(); process.exit(1); }
    await sv('server:c[3]', 'Yes');
    const okInvoke = await session.invoke(
      { type: 'InvokeAction', formId: dlg.formId, controlPath: 'server:c[0]', systemAction: 300 },
      (e: BCEvent) => e.type === 'InvokeCompleted' || e.type === 'DialogOpened' || e.type === 'MessageToShow' || e.type === 'FormClosed',
    );
    console.log(`  OK: ${isOk(okInvoke) ? okInvoke.value.map(e => `${e.type}:${(e as { formId?: string }).formId ?? ''}`).join(',') : 'ERR ' + okInvoke.error.message}`);
    if (isOk(okInvoke)) repo.applyToPage(pcId, okInvoke.value);
    // Read back the list — did a layout row appear?
    const { ReadDataOperation } = await import('../src/operations/read-data.js');
    const { DataService } = await import('../src/services/data-service.js');
    const { FilterService } = await import('../src/services/filter-service.js');
    const { SortService } = await import('../src/services/sort-service.js');
    const read = await new ReadDataOperation(new DataService(session, repo, quiet), new FilterService(session, repo, quiet), new SortService(session, repo, quiet), repo)
      .execute({ pageContextId: pcId, range: { offset: 0, limit: 5 } });
    const rows = isOk(read) ? (read.value.section.rows ?? []) : [];
    console.log(`  rows after seed: ${rows.length}; cells: ${JSON.stringify(rows[0]?.cells ?? {}).slice(0, 300)}`);
    console.log(rows.length > 0 ? '  => SEEDED — Import Layout now has a current row' : '  => still empty — try a different report id via SEED_REPORT_ID');
  }

  // Leave the dialog open? No — close it cleanly so the session dies tidy.
  const dlgs = [act.value.dialog?.formId, ...(act.value.events.filter(e => e.type === 'DialogOpened') as Array<{ formId: string }>).map(e => e.formId)].filter((x): x is string => Boolean(x) && x !== dlg?.formId);
  for (const fid of dlgs) {
    const close = await session.invoke({ type: 'CloseForm', formId: fid }, (e: BCEvent) => e.type === 'InvokeCompleted');
    console.log(`  closed ${fid.slice(0, 8)}: ${isOk(close) ? 'ok' : close.error.message}`);
  }
  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
