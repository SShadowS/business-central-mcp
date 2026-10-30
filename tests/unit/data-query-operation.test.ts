// tests/unit/data-query-operation.test.ts
//
// bc_data_* operations + BCMcpClient against a real in-process MCP server
// (tests/helpers/fake-bc-mcp-server.ts). Tool answers are live BC 29.1 texts.

import { afterEach, describe, expect, it } from 'vitest';
import { BCMcpClient, type BCMcpClientConfig } from '../../src/bcmcp/bc-mcp-client.js';
import { DataQueryOperation } from '../../src/operations/data-query.js';
import { BCMcpToolRunner } from '../../src/bcmcp/bc-mcp-tools.js';
import { DataQueryError, BCMcpUnavailableError, DeviceLoginRequiredError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import { FakeBCMcpServer, text, type FakeBCMcpServerOptions } from '../helpers/fake-bc-mcp-server.js';

const COMPANY = 'CRONUS Danmark A/S';
// Live BC 29.1 answers (Cronus291).
const LIST_COMPANIES = '[{"Name":"CRONUS Danmark A/S","DisplayName":"CRONUS Danmark A/S","isDefault":true},{"Name":"My Company","DisplayName":"My Company","isDefault":false}]';
const FIND_TABLES = '{"tables":[{"tableId":6,"tableName":"Customer Price Group"},{"tableId":18,"tableName":"Customer"}]}';
const SCHEMA = 'Table: Customer (ID: 18)\nPrimary Key: No.\nShowing: 2 fields (2 normal, 0 FlowField, 0 FlowFilter) (filtered by: nameContains=No.)\n\nNo. | Code\nPhone No. | Text\n';
const RELATIONS = '{"tableId":18,"tableName":"Customer","outgoing":[{"targetTableId":9,"targetTableName":"Country/Region","viaFields":[{"fieldNo":35,"fieldName":"Country/Region Code"}]}]}';
const COMPILED = '{"status":"compiled","columns":[{"name":"No","type":"Code"},{"name":"Name","type":"Text"}],"dataItems":[{"alias":"Cust","tableId":18,"tableName":"Customer"}]}';
const DATA_SUMMARY = 'Returned 3 of 5 total records (skip=0). Use \'top\' and \'skip\' to paginate.';
const DATA = '{"skip":0,"top":3,"rowCount":3,"columns":["No","Name"],"rows":[["10000","Kontorcentralen A/S"],["20000","Ravel Møbler"],["30000","Lauritzen Kontormøbler A/S"]],"totalCount":5}';
const COMPILE_ERROR = 'Compilation failed:\n\n(1,65): error AL0345: The source of a Column or Filter must be a field defined on the table referenced by its parent DataItem\n\nTip: Verify field names with bc_data_get_table_schema. Check AL syntax.';
const QUERY = 'query 50100 TopCustomers { elements { dataitem(Cust; Customer) { column(No; "No.") { } column(Name; Name) { } } } }';

let server: FakeBCMcpServer | undefined;
let client: BCMcpClient | undefined;
afterEach(async () => {
  await client?.close();
  await server?.stop();
  server = undefined;
  client = undefined;
});

async function setup(opts: {
  sessionCompany?: string;
  configuredCompany?: string;
  serverOptions?: FakeBCMcpServerOptions;
  client?: Partial<BCMcpClientConfig>;
  url?: (s: FakeBCMcpServer) => string;
} = {}) {
  server = await FakeBCMcpServer.start(opts.serverOptions);
  server.scripts.set('list_companies', () => text(LIST_COMPANIES));
  client = new BCMcpClient({
    mcpUrl: opts.url ? opts.url(server) : server.url,
    tenantId: 'default',
    appendTenantQuery: true,
    username: 'sshadows',
    password: '1234',
    requireBearer: false,
    requestTimeoutMs: 10_000,
    logger: createNullLogger(),
    ...opts.client,
  });
  const op = new DataQueryOperation(new BCMcpToolRunner(client, () => opts.sessionCompany, opts.configuredCompany));
  return { server, op };
}

describe('DataQueryOperation', () => {
  it('findTables returns BC\'s tables and passes the session company', async () => {
    const { server, op } = await setup({ sessionCompany: 'My Company' });
    server.scripts.set('bc_data_find_tables', () => text(FIND_TABLES));
    const r = await op.findTables({ searchText: 'customer', searchMode: 'keyword', top: 2 });
    expect(r).toEqual({ ok: true, value: { company: 'My Company', tables: [{ tableId: 6, tableName: 'Customer Price Group' }, { tableId: 18, tableName: 'Customer' }] } });
    expect(server.calls.at(-1)).toMatchObject({ name: 'bc_data_find_tables', args: { searchText: 'customer', searchMode: 'keyword', top: 2, company: 'My Company' } });
  });

  it('getTableSchema returns BC\'s pipe-delimited text unchanged and drops undefined args', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_get_table_schema', () => text(SCHEMA));
    const r = await op.getTableSchema({ tableId: 18, nameContains: ['No.'] });
    expect(r).toEqual({ ok: true, value: { company: COMPANY, tableId: 18, schema: SCHEMA } });
    expect(server.calls.at(-1)!.args).toEqual({ tableId: 18, nameContains: ['No.'], company: COMPANY });
  });

  it('getTableRelations returns BC\'s relation object', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_get_table_relations', () => text(RELATIONS));
    const r = await op.getTableRelations({ tableId: 18, direction: 'outgoing' });
    expect(r.ok && r.value).toEqual({ company: COMPANY, ...JSON.parse(RELATIONS) });
  });

  it('query without returnData returns the compiled schema', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_query', () => text(COMPILED));
    const r = await op.query({ queryText: QUERY });
    expect(r).toEqual({ ok: true, value: { company: COMPANY, status: 'compiled', ...JSON.parse(COMPILED) } });
  });

  it('query with returnData parses the JSON block after BC\'s summary line and computes hasMore', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_query', () => text(DATA_SUMMARY, DATA));
    const r = await op.query({ queryText: QUERY, returnData: true, top: 3 });
    expect(r).toEqual({
      ok: true,
      value: {
        company: COMPANY, status: 'executed', columns: ['No', 'Name'],
        rows: [['10000', 'Kontorcentralen A/S'], ['20000', 'Ravel Møbler'], ['30000', 'Lauritzen Kontormøbler A/S']],
        rowCount: 3, skip: 0, top: 3, totalCount: 5, hasMore: true,
      },
    });
  });

  it('hasMore without totalCount (skip > 0) means a full page', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_query', (args) => text(JSON.stringify({ skip: args.skip, top: 2, rowCount: (args.skip as number) < 4 ? 2 : 1, columns: ['No'], rows: [] })));
    const full = await op.query({ queryText: QUERY, returnData: true, top: 2, skip: 2 });
    const last = await op.query({ queryText: QUERY, returnData: true, top: 2, skip: 4 });
    expect(full.ok && full.value.status === 'executed' && full.value.hasMore).toBe(true);
    expect(last.ok && last.value.status === 'executed' && last.value.hasMore).toBe(false);
  });

  it('maps BC\'s isError answer to DATA_QUERY_ERROR carrying BC\'s text', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_query', () => ({ ...text(COMPILE_ERROR), isError: true }));
    const r = await op.query({ queryText: QUERY });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBeInstanceOf(DataQueryError);
    expect(!r.ok && r.error.message).toContain('AL0345');
  });

  it('prefers an explicit company, then the session company, then BC_ODATA_COMPANY', async () => {
    const { server, op } = await setup({ sessionCompany: 'Session Co', configuredCompany: 'Config Co' });
    server.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    await op.findTables({ searchText: 'x', searchMode: 'keyword', company: 'Explicit Co' });
    await op.findTables({ searchText: 'x', searchMode: 'keyword' });
    expect(server.calls.map((c) => c.args.company)).toEqual(['Explicit Co', 'Session Co']);
  });

  it('falls back to BC_ODATA_COMPANY, and without it to BC\'s default company (asked once)', async () => {
    const configured = await setup({ configuredCompany: 'Config Co' });
    configured.server.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    await configured.op.findTables({ searchText: 'x', searchMode: 'keyword' });
    expect(configured.server.calls.map((c) => c.args.company)).toEqual(['Config Co']);
    await client!.close();
    await server!.stop();

    const { server: s, op } = await setup();
    s.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    const r = await op.findTables({ searchText: 'x', searchMode: 'keyword' });
    await op.findTables({ searchText: 'y', searchMode: 'keyword' });
    expect(r.ok && r.value.company).toBe(COMPANY);
    expect(s.calls.map((c) => c.name)).toEqual(['list_companies', 'bc_data_find_tables', 'bc_data_find_tables']);
  });
});

describe('BCMcpClient', () => {
  it('uses one session and sends Basic auth on every request', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    await op.findTables({ searchText: 'b', searchMode: 'keyword' });
    expect(server.initializeCount).toBe(1);
    expect(new Set(server.calls.map((c) => c.sessionId)).size).toBe(1);
    expect(server.calls.every((c) => c.authorization === `Basic ${Buffer.from('sshadows:1234').toString('base64')}`)).toBe(true);
  });

  it('reconnects once when BC no longer knows the session', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY });
    server.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    server.expireSessions();
    const r = await op.findTables({ searchText: 'b', searchMode: 'keyword' });
    expect(r.ok).toBe(true);
    expect(server.initializeCount).toBe(2);
  });

  it('reports BC_MCP_UNAVAILABLE (tools-disabled) when BC does not list the tool', async () => {
    const { op } = await setup({ sessionCompany: COMPANY, serverOptions: { tools: ['bc_actions_search', 'list_companies'] } });
    const r = await op.query({ queryText: QUERY });
    expect(!r.ok && r.error).toBeInstanceOf(BCMcpUnavailableError);
    expect(!r.ok && (r.error as BCMcpUnavailableError).reason).toBe('tools-disabled');
  });

  it('reports BC_MCP_UNAVAILABLE (endpoint-missing) when there is no /mcp endpoint', async () => {
    const { op } = await setup({ sessionCompany: COMPANY, url: (s) => s.url.replace('/BC/mcp', '/BC/nope') });
    const r = await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    expect(!r.ok && (r.error as BCMcpUnavailableError).reason).toBe('endpoint-missing');
  });

  it('reports BC_MCP_UNAVAILABLE (mcp-disabled) on BC\'s 412 feature gate, and retries the connect next call', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY, serverOptions: { initializeStatus: 412 } });
    const first = await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    const second = await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    expect(!first.ok && (first.error as BCMcpUnavailableError).reason).toBe('mcp-disabled');
    expect(!second.ok && second.error.code).toBe('BC_MCP_UNAVAILABLE');
    expect(server.initializeCount).toBe(2);
  });

  it('sends the Bearer token when the auth provider has one', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY, client: { getAuthorization: async () => 'Bearer tok-1' } });
    server.scripts.set('bc_data_find_tables', () => text('{"tables":[]}'));
    await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    expect(server.calls.at(-1)!.authorization).toBe('Bearer tok-1');
  });

  it('never falls back to Basic when a Bearer token is required', async () => {
    const { server, op } = await setup({ sessionCompany: COMPANY, client: { requireBearer: true, getAuthorization: async () => undefined } });
    const r = await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    expect(!r.ok && r.error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(server.initializeCount).toBe(0);
  });

  it('surfaces a device-login prompt from the auth provider unchanged', async () => {
    const login = new DeviceLoginRequiredError('https://microsoft.com/devicelogin', 'ABCD-1234', Date.now() + 600_000);
    const { op } = await setup({ sessionCompany: COMPANY, client: { requireBearer: true, getAuthorization: async () => { throw login; } } });
    const r = await op.findTables({ searchText: 'a', searchMode: 'keyword' });
    expect(!r.ok && r.error).toBe(login);
  });
});
