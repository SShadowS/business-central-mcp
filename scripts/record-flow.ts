/**
 * Records a realistic, non-destructive MCP session: spawns the real stdio
 * server, runs a normal user flow, and writes every tool request/response
 * (exactly what an LLM client sees) to a JSONL file.
 *
 * Run: BC_BASE_URL=http://cronus29/BC BC_USERNAME=sshadows BC_PASSWORD=1234 \
 *      BC_TENANT_ID=default npx tsx scripts/record-flow.ts <out.jsonl>
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const out = process.argv[2] ?? 'flow.jsonl';
writeFileSync(out, '');
let step = 0;
const log = (o: unknown): void => appendFileSync(out, JSON.stringify(o) + '\n');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['node_modules/tsx/dist/cli.mjs', 'src/stdio-server.ts'],
  env: { ...process.env, LOG_LEVEL: 'warn' } as Record<string, string>,
  stderr: 'ignore',
});
const client = new Client({ name: 'flow-recorder', version: '1.0.0' });
await client.connect(transport);

log({ step: 'init', label: 'initialize instructions', response: { instructions: client.getInstructions() } });
const tools = await client.listTools();
log({ step: step++, label: 'tools/list', response: tools });

// deno-lint-ignore no-explicit-any
type Any = any;
async function call(label: string, name: string, args: Record<string, unknown>): Promise<Any> {
  const t0 = Date.now();
  let res: Any;
  try {
    // Raw request: skips the SDK's output-schema check so mismatching payloads are recorded, not thrown.
    res = await client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, { timeout: 300_000 });
  } catch (e) {
    res = { thrown: String(e) };
  }
  log({ step: step++, label, tool: name, args, durationMs: Date.now() - t0, response: res });
  console.log(`${step - 1}. ${label} -> ${res.isError ? 'ERROR' : res.thrown ? 'THROWN' : 'ok'} (${Date.now() - t0}ms)`);
  if (res.structuredContent) return res.structuredContent;
  try { return JSON.parse(res.content?.[0]?.text ?? 'null'); } catch { return null; }
}
const rowsOf = (r: Any): Any[] => r?.section?.rows ?? r?.sections?.find((s: Any) => s.rows)?.rows ?? r?.rows ?? [];

// --- Discovery: search, then open the hit by its pageId
const found = await call('search pages', 'bc_search_pages', { query: 'customers' });
await call('list companies', 'bc_list_companies', {});
const hitId = found?.results?.find((r: Any) => r.runTarget === 'Customer List')?.pageId ?? 22;

// --- List page: read, filter, sort, paginate
const list = await call('open Customer List (pageId from search)', 'bc_open_page', { pageId: hitId });
const listPc = list?.pageContextId;
await call('read list range 0..3 (hasMore)', 'bc_read_data', { pageContextId: listPc, range: { offset: 0, limit: 3 } });
await call('read list range past the end', 'bc_read_data', { pageContextId: listPc, range: { offset: 50, limit: 3 } });
await call('filter + sort + columns', 'bc_read_data', {
  pageContextId: listPc, filters: [{ column: 'No.', value: '10000..40000' }],
  sort: { column: 'Name', direction: 'desc' }, columns: ['No.', 'Name', 'Balance (LCY)'],
});
await call('filter no match', 'bc_read_data', { pageContextId: listPc, clearFilters: true, filters: [{ column: 'Name', value: 'ZZZ-nomatch*' }] });
const cleared = await call('clear filters', 'bc_read_data', { pageContextId: listPc, clearFilters: true, range: { offset: 0, limit: 3 } });
const bm = rowsOf(cleared)[0]?.bookmark;

// --- Drill-down to card, factbox, lookup, validation error, dimensions
await call('select row', 'bc_navigate', { pageContextId: listPc, bookmark: bm, action: 'select' });
const card = await call('drill down to Customer Card', 'bc_navigate', { pageContextId: listPc, bookmark: bm, action: 'drill_down' });
const cardPc = card?.openedPages?.[0]?.pageContextId;
await call('read card tab General', 'bc_read_data', { pageContextId: cardPc, tab: 'General' });
await call('read card with includeActions', 'bc_read_data', { pageContextId: cardPc, includeActions: true, columns: ['No.', 'Name'] });
const fb = (card?.sections ?? []).find((s: Any) => String(s.sectionId).startsWith('factbox:'))?.sectionId;
if (fb) await call(`read factbox ${fb}`, 'bc_read_data', { pageContextId: cardPc, section: fb });
await call('lookup Payment Terms Code', 'bc_lookup', { pageContextId: cardPc, field: 'Payment Terms Code', maxRows: 3 });
const dims = await call('action Dimensions (before any error)', 'bc_execute_action', { pageContextId: cardPc, action: 'Dimensions' });
const dimPc = dims?.openedPages?.[0]?.pageContextId;
if (dimPc) {
  await call('read dimensions', 'bc_read_data', { pageContextId: dimPc });
  await call('close dimensions', 'bc_close_page', { pageContextId: dimPc });
}
await call('write invalid Payment Terms Code (validation error)', 'bc_write_data', { pageContextId: cardPc, fields: { 'Payment Terms Code': 'ZZNOPE' } });
await call('action Dimensions while the value is rejected (ACTION_DISABLED)', 'bc_execute_action', { pageContextId: cardPc, action: 'Dimensions' });
await call('unknown action', 'bc_execute_action', { pageContextId: cardPc, action: 'Does Not Exist' });
const closeCard = await call('close card (blocked by discard confirm)', 'bc_close_page', { pageContextId: cardPc });
const discard = closeCard?.dialogsOpened?.[0];
if (discard) await call('answer discard confirm yes', 'bc_respond_dialog', { pageContextId: discard.pageContextId, dialogFormId: discard.formId, response: 'yes' });
await call('read the closed card context', 'bc_read_data', { pageContextId: cardPc });

// --- Document page: header + lines
const so = await call('open Sales Orders list', 'bc_open_page', { pageId: 9305 });
const soBm = rowsOf(so)[0]?.bookmark;
const doc = await call('drill down to Sales Order', 'bc_navigate', { pageContextId: so?.pageContextId, bookmark: soBm, action: 'drill_down' });
const docPc = doc?.openedPages?.[0]?.pageContextId;
await call('read sales order lines', 'bc_read_data', { pageContextId: docPc, section: 'lines' });
await call('close sales order', 'bc_close_page', { pageContextId: docPc });
await call('close sales orders list', 'bc_close_page', { pageContextId: so?.pageContextId });

// --- Role Center (cues)
const rc = await call('open Role Center 9022', 'bc_open_page', { pageId: 9022 });
await call('close role center', 'bc_close_page', { pageContextId: rc?.pageContextId });

// --- Report request page: invalid value, then a missing page while it is still open
// (reconcile closes it; the session and the Customer List must survive), then a clean run + cancel.
const rep = await call('run report 6 (request page)', 'bc_run_report', { reportId: 6 });
const repPc = rep?.dialogsOpened?.[0]?.pageContextId;
if (repPc) await call('write invalid Maximum rows', 'bc_write_data', { pageContextId: repPc, fields: { 'Maximum rows': '-5' } });
await call('open nonexistent page while a dialog is pending', 'bc_open_page', { pageId: 999999 });
await call('read customer list after that (session alive?)', 'bc_read_data', { pageContextId: listPc, range: { offset: 0, limit: 2 } });
const rep2 = await call('run report 6 again', 'bc_run_report', { reportId: 6 });
const rp2 = rep2?.dialogsOpened?.[0];
if (rp2) await call('cancel request page', 'bc_respond_dialog', { pageContextId: rp2.pageContextId, dialogFormId: rp2.formId, response: 'cancel' });

// --- OData query paging + error states
await call('bc_query customers top 3', 'bc_query', { entity: 'customers', select: 'number,displayName,balanceDue', top: 3 });
await call('bc_query customers skip 3', 'bc_query', { entity: 'customers', select: 'number,displayName', top: 3, skip: 3 });
await call('open nonexistent page (no dialog pending)', 'bc_open_page', { pageId: 999999 });
await call('read bogus page context', 'bc_read_data', { pageContextId: listPc ? `${listPc}-bogus` : 'bogus' });
await call('sort by unknown column', 'bc_read_data', { pageContextId: listPc, sort: { column: 'Nope', direction: 'asc' } });
await call('close customer list', 'bc_close_page', { pageContextId: listPc });

await client.close();
console.log(`wrote ${out}`);
