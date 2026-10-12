/**
 * End-to-end verification of bc_upload_file THROUGH the real operation stack
 * (same wiring as server.ts): openPage -> executeAction("Import Layout") ->
 * uploadFile -> observe AL reaction. Proves the MCP-layer flow, not just the
 * raw protocol (which scripts/probe-imperative-upload.ts verified with an A/B
 * control on 2026-10-12).
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/probe-upload-mcp.ts
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
import { FilterService } from '../src/services/filter-service.js';
import { SortService } from '../src/services/sort-service.js';
import { DownloadService } from '../src/services/download-service.js';
import { NavigationService } from '../src/services/navigation-service.js';
import { UploadService } from '../src/services/upload-service.js';
import { OpenPageOperation } from '../src/operations/open-page.js';
import { ReadDataOperation } from '../src/operations/read-data.js';
import { ExecuteActionOperation } from '../src/operations/execute-action.js';
import { UploadFileOperation } from '../src/operations/upload-file.js';
import { RespondDialogOperation } from '../src/operations/respond-dialog.js';
import { isErr, isOk, unwrap } from '../src/core/result.js';
import type { BCSession } from '../src/session/bc-session.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`MCP-flow upload verification against ${cfg.bc.baseUrl}`);
  const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  if (isErr(await auth.authenticate())) { console.error('AUTH FAILED'); process.exit(1); }
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const repo = new PageContextRepository();
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED:', sessRes.error.message); process.exit(1); }
  const session: BCSession = unwrap(sessRes);

  const dataService = new DataService(session, repo, quiet);
  const actionService = new ActionService(session, repo, quiet);
  const filterService = new FilterService(session, repo, quiet);
  const sortService = new SortService(session, repo, quiet);
  const navService = new NavigationService(session, repo, quiet);
  const downloadService = new DownloadService(session, conn.createHttpClient(), repo, quiet);
  const uploadService = new UploadService(session, repo, conn.createHttpClient(), quiet);

  const openPage = new OpenPageOperation(new PageService(session, repo, quiet));
  const readData = new ReadDataOperation(dataService, filterService, sortService, repo);
  const executeAction = new ExecuteActionOperation(actionService, repo, navService, downloadService, 100);
  const uploadFile = new UploadFileOperation(uploadService);
  const respondDialog = new RespondDialogOperation(session, repo, downloadService);

  // 1. Open 9650 and check for a current row (row-bound action; seeded via
  // probe-seed-9650 on 2026-10-12 — re-seed if this fails with an ErrorDialog).
  const opened = await openPage.execute({ pageId: '9650' });
  if (isErr(opened)) { console.error('open 9650 failed:', opened.error.message); await session.close(); process.exit(1); }
  const pcId = opened.value.pageContextId;
  const rows = await readData.execute({ pageContextId: pcId, range: { offset: 0, limit: 5 } });
  console.log(`1. opened 9650 (${pcId}); rows: ${isOk(rows) ? (rows.value.section.rows ?? []).length : 'ERR'}`);
  if (!isOk(rows) || (rows.value.section.rows ?? []).length === 0) {
    console.error('   no rows — run scripts/probe-seed-9650.ts first'); await session.close(); process.exit(1);
  }

  // 2. Invoke "Import Layout" — must open a FileUploadForm dialog.
  const act = await executeAction.execute({ pageContextId: pcId, action: 'Import Layout' });
  if (isErr(act)) { console.error('2. Import Layout failed:', act.error.message); await session.close(); process.exit(1); }
  console.log(`2. Import Layout ok; dialogsOpened: ${JSON.stringify(act.value.dialogsOpened.map(d => d.formId))}`);
  if (act.value.dialogsOpened.length === 0) {
    console.error('   no dialog opened — cannot upload'); await session.close(); process.exit(1);
  }

  // 3. Upload a garbage file through the real operation (auto-resolve the dialog).
  const bytes = Buffer.from('not a layout file — probe-upload-mcp\n', 'utf-8');
  const up = await uploadFile.execute({
    pageContextId: pcId,
    base64: bytes.toString('base64'),
    fileName: 'probe-mcp.txt',
  });
  console.log(`3. uploadFile: ${isErr(up) ? 'ERR ' + up.error.message : 'ok; formId=' + up.value.formId + ' dialogsOpened=' + JSON.stringify(up.value.dialogsOpened)}`);
  if (isErr(up)) { await session.close(); process.exit(1); }

  // 4. The discriminator (from the A/B-verified protocol): AL opened a NEW
  //    dialog reacting to our garbage file. Respond 'ok' to close it cleanly.
  const dialogs = up.value.dialogsOpened;
  let alReacted = false;
  for (const d of dialogs) {
    alReacted = true;
    console.log(`4. responding ok to AL dialog ${d.formId}: ${JSON.stringify(d.message ?? '').slice(0, 200)}`);
    const resp = await respondDialog.execute({ pageContextId: pcId, dialogFormId: d.formId, response: 'ok' });
    if (isErr(resp)) console.log('   respond failed:', resp.error.message);
  }
  if (!alReacted) console.log('4. no AL dialog surfaced (unexpected for garbage input — check probe-async frames)');

  // 5. Read back the list.
  const after = await readData.execute({ pageContextId: pcId, range: { offset: 0, limit: 5 } });
  console.log(`5. rows after: ${isOk(after) ? (after.value.section.rows ?? []).length : 'ERR'}`);

  console.log('\n================ VERDICT ================');
  console.log(alReacted
    ? '  => MCP-FLOW VERIFIED: executeAction opened FileUploadForm, uploadFile POSTed + closed it, AL reacted to the uploaded bytes.'
    : '  => AL did not visibly react — inspect events; the protocol-level A/B (probe-imperative-upload) remains the source of truth.');
  writeFileSync('C:/Users/SShadowS/AppData/Local/Temp/probe-upload-mcp.json', JSON.stringify({ act: act.value, up: isErr(up) ? up.error : up.value }, null, 2));

  await session.close();
  process.exit(0);
}
main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
