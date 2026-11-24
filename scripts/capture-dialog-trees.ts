/**
 * Captures raw DialogOpened events for test fixtures: report 6's request page
 * (MappingHint RequestPage) and the discard confirm (ConfirmDialog) that Refresh
 * raises once "Maximum rows" holds an invalid value. Reads only: request page
 * values are never saved on close (see tests/integration/modal-recovery.test.ts).
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/capture-dialog-trees.ts tests/fixtures/dialogs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { buildFormTree } from '../src/protocol/form-tree-builder.js';
import { fields } from '../src/protocol/form-views.js';
import { SystemAction, type DialogOpenedEvent } from '../src/protocol/types.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const outDir = process.argv[2] ?? 'tests/fixtures/dialogs';
const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };
const done = (e: { type: string }) => e.type === 'InvokeCompleted';

const cfg = loadConfig();
const auth = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
if (isErr(await auth.authenticate())) throw new Error('auth failed');
const sf = new SessionFactory(new ConnectionFactory(auth, cfg.bc, quiet), new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
const session = unwrap(await sf.create());
mkdirSync(outDir, { recursive: true });

const opened = unwrap(await session.invoke({ type: 'OpenForm', query: `report=6&tenant=${cfg.bc.tenantId}`, controlPath: 'server:c[0]' }, done));
const requestPage = opened.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened')!;
writeFileSync(join(outDir, 'request-page-report6.json'), JSON.stringify(requestPage, null, 2));

const maxRows = fields(buildFormTree(requestPage.controlTree)).find(f => f.properties.caption === 'Maximum rows')!;
unwrap(await session.invoke({ type: 'SaveValue', formId: requestPage.formId, controlPath: maxRows.controlPath, newValue: 'abc' }, done));
const refreshed = unwrap(await session.invoke({ type: 'InvokeAction', formId: requestPage.formId, controlPath: 'server:c[0]', systemAction: SystemAction.Refresh }, done));
const confirm = refreshed.find((e): e is DialogOpenedEvent => e.type === 'DialogOpened')!;
writeFileSync(join(outDir, 'discard-confirm.json'), JSON.stringify(confirm, null, 2));

// No on the confirm, then close the request page (cancels the report, saves nothing).
unwrap(await session.invoke({ type: 'InvokeAction', formId: confirm.formId, controlPath: 'server:', systemAction: SystemAction.No }, done));
await session.invoke({ type: 'CloseForm', formId: requestPage.formId }, done);
await session.close();
console.log(`wrote ${outDir}/request-page-report6.json, discard-confirm.json`);
