// tests/unit/api-actions-operation.test.ts
//
// bc_api_* operations against a real in-process MCP server
// (tests/helpers/fake-bc-mcp-server.ts). Tool answers are live BC 29.1 texts
// (Cronus291, customers API page 30009 enabled for writes).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BCMcpClient } from '../../src/bcmcp/bc-mcp-client.js';
import { BCMcpToolRunner } from '../../src/bcmcp/bc-mcp-tools.js';
import { ApiActionsOperation, isReplaySafe } from '../../src/operations/api-actions.js';
import { ApiActionError, InputValidationError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import { createToolDefinition as apiInvokeTool } from '../../src/operations/api-invoke.tool.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { FakeBCMcpServer, text } from '../helpers/fake-bc-mcp-server.js';

const COMPANY = 'CRONUS Danmark A/S';
const API_TOOLS = ['bc_actions_search', 'bc_actions_describe', 'bc_actions_invoke', 'list_companies'];
// Live BC 29.1 answers.
const SEARCH = 'Here are Business Central action names matching your search (use bc_actions_describe to get details):\n["Create_Customer_PAG30009","Delete_Customer_PAG30009","Modify_Customer_PAG30009"]';
const NO_MATCH = 'No matching Business Central actions found. Try adjusting your search query or action type filter.';
const DESCRIBE = 'Here is the action schema you requested:\n{"name":"Delete_Customer_PAG30009","description":"Deletes records for an entity Customer.","schema":{"type":"object","properties":{"id":{"type":"string","format":"uuid"}},"required":["id"]}}\n\nNote: Pass the schema properties as \'RequestParameters\' to invoke this action using bc_actions_invoke.';
const LIST_SUMMARY = 'Returned 2 of 5 total records. Use \'top\' and \'skip\' in \'RequestParameters\' to paginate.';
const LIST = '{"@odata.count":5,"value":[{"@odata.etag":"W/\\"JzE5OzY3ODg4MzUwNjQ4MDAyMDIwODQxOzAwOyc=\\"","number":"10000","displayName":"Kontorcentralen A/S"},{"@odata.etag":"W/\\"JzE5OzQzMjYyMTM0ODQ3NjQ2MzY1NzkxOzAwOyc=\\"","number":"20000","displayName":"Ravel Møbler"}]}';
const CREATED = '{"@odata.etag":"W/\\"JzE5OzU2NDU4MDgyMjQ1NDExMTQ2NjMxOzAwOyc=\\"","id":"cd732f40-f7d3-f111-bcd2-a1958654e546","number":"C00010","displayName":"bc-mcp probe customer"}';
const ENTITY_CHANGED = '{\n  "error": {\n    "code": "Request_EntityChanged",\n    "message": "Another user has already changed the record."\n  }\n}';

let server: FakeBCMcpServer | undefined;
let client: BCMcpClient | undefined;
let ledgerDir: string | undefined;
afterEach(async () => {
  await client?.close();
  await server?.stop();
  if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
  server = undefined;
  client = undefined;
  ledgerDir = undefined;
});

async function setup() {
  server = await FakeBCMcpServer.start({ tools: API_TOOLS });
  client = new BCMcpClient({
    mcpUrl: server.url, tenantId: 'default', appendTenantQuery: true, username: 'sshadows', password: '1234',
    requireBearer: false, requestTimeoutMs: 10_000, logger: createNullLogger(),
  });
  return { server, op: new ApiActionsOperation(new BCMcpToolRunner(client, () => COMPANY, undefined)) };
}

describe('ApiActionsOperation', () => {
  it('search extracts the action names from BC\'s sentence, searching every action type by keyword', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_search', () => text(SEARCH));
    const r = await op.search({ searchText: 'customer' });
    expect(r).toEqual({ ok: true, value: { company: COMPANY, actions: ['Create_Customer_PAG30009', 'Delete_Customer_PAG30009', 'Modify_Customer_PAG30009'] } });
    expect(server.calls.at(-1)!.args).toEqual({
      SearchText: 'customer', SearchMode: 'keyword', ActionType: ['List', 'Create', 'Modify', 'Delete', 'BoundAction', 'UnboundAction'], company: COMPANY,
    });
  });

  it('search returns no actions for BC\'s "No matching" answer', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_search', () => text(NO_MATCH));
    expect(await op.search({ searchText: 'nothing', actionTypes: ['Create'] })).toEqual({ ok: true, value: { company: COMPANY, actions: [] } });
  });

  it('describe parses the schema between BC\'s intro line and its trailing note', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_describe', () => text(DESCRIBE));
    const r = await op.describe({ actionName: 'Delete_Customer_PAG30009' });
    expect(r.ok && r.value).toEqual({
      company: COMPANY, name: 'Delete_Customer_PAG30009', description: 'Deletes records for an entity Customer.',
      schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    });
  });

  it('list sends the OData options as a JSON string and returns rows, totalCount and hasMore', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_invoke', () => text(LIST_SUMMARY, LIST));
    const r = await op.list({ actionName: 'List_Customers_PAG30009', select: 'number,displayName', top: 2 });
    expect(r.ok && r.value).toMatchObject({ company: COMPANY, actionName: 'List_Customers_PAG30009', rowCount: 2, totalCount: 5, hasMore: true });
    expect(r.ok && (r.value.rows[0] as Record<string, unknown>).number).toBe('10000');
    expect(server.calls.at(-1)!.args).toEqual({ ActionName: 'List_Customers_PAG30009', RequestParameters: '{"select":"number,displayName","top":2}', company: COMPANY });
  });

  it('list refuses a non-List action and invoke refuses a List action, without calling BC', async () => {
    const { server, op } = await setup();
    const list = await op.list({ actionName: 'Delete_Customer_PAG30009' });
    const invoke = await op.invoke({ actionName: 'List_Customers_PAG30009', parameters: {} });
    expect(!list.ok && list.error).toBeInstanceOf(InputValidationError);
    expect(!invoke.ok && invoke.error).toBeInstanceOf(InputValidationError);
    expect(server.calls).toHaveLength(0);
  });

  it('invoke Create returns the saved record and is not replay-safe', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_invoke', () => text(CREATED));
    const r = await op.invoke({ actionName: 'Create_Customer_PAG30009', parameters: { displayName: 'bc-mcp probe customer' } });
    expect(r.ok && r.value).toEqual({ company: COMPANY, actionName: 'Create_Customer_PAG30009', result: JSON.parse(CREATED), replaySafe: false });
    expect(server.calls.at(-1)!.args.RequestParameters).toBe('{"displayName":"bc-mcp probe customer"}');
  });

  it('invoke Delete answers no result and is replay-safe', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_invoke', () => ({ content: [] }));
    const r = await op.invoke({ actionName: 'Delete_Customer_PAG30009', parameters: { id: 'cd732f40-f7d3-f111-bcd2-a1958654e546' } });
    expect(r).toEqual({ ok: true, value: { company: COMPANY, actionName: 'Delete_Customer_PAG30009', result: undefined, replaySafe: true } });
  });

  it('maps BC\'s OData error JSON to API_ACTION_ERROR "<code>: <message>"', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_invoke', () => ({ ...text(ENTITY_CHANGED), isError: true }));
    const r = await op.invoke({ actionName: 'Modify_Customer_PAG30009', parameters: { id: 'x', 'If-Match': 'W/"stale"', displayName: 'y' } });
    expect(!r.ok && r.error).toBeInstanceOf(ApiActionError);
    expect(!r.ok && r.error.message).toBe('Request_EntityChanged: Another user has already changed the record.');
    expect(!r.ok && (r.error as ApiActionError).odataCode).toBe('Request_EntityChanged');
  });

  it('marks only Modify and Delete replay-safe', () => {
    expect(['Create_Customer_PAG30009', 'Modify_Customer_PAG30009', 'Delete_Customer_PAG30009', 'Post_SalesInvoice_PAG30012'].map(isReplaySafe))
      .toEqual([false, true, true, false]);
  });
});

describe('bc_api_invoke through the MCP handler', () => {
  it('is gated: a retry with the same operationId replays without calling BC again', async () => {
    const { server, op } = await setup();
    server.scripts.set('bc_actions_invoke', () => text(CREATED));
    ledgerDir = mkdtempSync(join(tmpdir(), 'bcmcp-api-ledger-'));
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = new MCPHandler([apiInvokeTool({ apiActions: op } as unknown as Operations)], log, [], { gate: new IdempotencyGate(new OperationLedger(ledgerDir), log) });
    const params = { name: 'bc_api_invoke', arguments: { actionName: 'Create_Customer_PAG30009', parameters: { displayName: 'bc-mcp probe customer' }, operationId: 'op-create-1' } };
    const first = await handler.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const second = await handler.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    expect((first.result as { structuredContent: unknown }).structuredContent).toMatchObject({ actionName: 'Create_Customer_PAG30009', replaySafe: false });
    expect((second.result as { structuredContent: unknown }).structuredContent).toEqual((first.result as { structuredContent: unknown }).structuredContent);
    expect(server.calls.filter((c) => c.name === 'bc_actions_invoke')).toHaveLength(1);
  });
});
