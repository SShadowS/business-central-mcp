import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { errorBodySchema } from '@sshadows/bc-toolbox-envelope';
import { MCPHandler } from '../../src/mcp/handler.js';
import type { ToolDefinition } from '../../src/mcp/tool-registry.js';
import { BC_EXTENSION_CODES } from '../../src/mcp/error-envelope.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import {
  AuthenticationError,
  SignInRequiredError,
  OAuthNotConfiguredError,
  DataQueryUnavailableError,
  DataQueryError,
  SessionLostError,
  TimeoutError,
} from '../../src/core/errors.js';
import {
  OpenPageOutputSchema,
  ReadDataOutputSchema,
  WriteDataOutputSchema,
  ExecuteActionOutputSchema,
  ClosePageOutputSchema,
  SearchPagesOutputSchema,
  NavigateOutputSchema,
  RespondDialogOutputSchema,
  SwitchCompanyOutputSchema,
  ListCompaniesOutputSchema,
  RunReportOutputSchema,
  WizardNavigateOutputSchema,
  LookupOutputSchema,
  QueryOutputSchema,
  DataFindTablesOutputSchema,
  DataTableSchemaOutputSchema,
  DataTableRelationsOutputSchema,
  DataQueryOutputSchema,
  UploadFileOutputSchema,
  GetOperationOutputSchema,
  RunTestsOutputSchema,
} from '../../src/mcp/schemas.js';

// The body the server EMITS must validate against core ∪ BC extension codes.
const ErrBody = errorBodySchema(BC_EXTENSION_CODES);

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function makeTool(
  name: string,
  execute: ToolDefinition['execute'],
  opts: { zodSchema?: z.ZodType; readOnly?: boolean } = {},
): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    zodSchema: opts.zodSchema ?? z.object({}),
    execute,
    annotations: opts.readOnly === false
      ? { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false },
  };
}

const call = (h: MCPHandler, name: string, args: Record<string, unknown> = {}) =>
  h.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    .then(r => r.result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> });

/** Universal invariant: EITHER a valid error body, OR structuredContent valid vs the output schema. */
function assertEnvelope(result: { isError?: boolean; structuredContent?: unknown }, outputSchema?: z.ZodType) {
  if (result.isError) {
    expect(() => ErrBody.parse(result.structuredContent)).not.toThrow();
    const body = result.structuredContent as { nextSteps: string[] };
    expect(body.nextSteps.length).toBeGreaterThan(0);
  } else if (outputSchema) {
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
  }
}

describe('tool envelope contract — the four required failure classes', () => {
  it('1. invalid input -> INVALID_ARGUMENT (validation)', async () => {
    const h = new MCPHandler([makeTool('bc_write_data', vi.fn(), {
      zodSchema: z.object({ pageContextId: z.string(), fields: z.record(z.string(), z.string()) }),
    })], logger());
    const res = await call(h, 'bc_write_data', {}); // missing pageContextId + fields
    expect(res.isError).toBe(true);
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string } };
    expect(body.error.code).toBe('INVALID_ARGUMENT');
    expect(body.error.category).toBe('validation');
  });

  it('2a. missing auth (returned Err) -> AUTHENTICATION_FAILED (auth)', async () => {
    const h = new MCPHandler([makeTool('bc_open_page',
      vi.fn().mockResolvedValue({ ok: false, error: new AuthenticationError('bad creds') }))], logger());
    const res = await call(h, 'bc_open_page');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string } };
    expect(body.error.code).toBe('AUTHENTICATION_FAILED');
    expect(body.error.category).toBe('auth');
  });

  it('2b. sign-in required (thrown) -> SIGN_IN_REQUIRED (auth)', async () => {
    const signIn = new SignInRequiredError('A display is required.', { openedWindow: false, reason: 'no_display' });
    const h = new MCPHandler([makeTool('bc_open_page', vi.fn().mockRejectedValue(signIn))], logger());
    const res = await call(h, 'bc_open_page');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('SIGN_IN_REQUIRED');
    expect(body.error.category).toBe('auth');
    expect(body.error.details.openedWindow).toBe(false);
    expect(body.error.details.reason).toBe('no_display');
  });

  it('3. unsupported feature config -> OAUTH_NOT_CONFIGURED (configuration)', async () => {
    const h = new MCPHandler([makeTool('bc_query',
      vi.fn().mockResolvedValue({ ok: false, error: new OAuthNotConfiguredError('BC_CLIENT_ID missing') }))], logger());
    const res = await call(h, 'bc_query');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string } };
    expect(body.error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(body.error.category).toBe('configuration');
  });

  it('3b. data query tools switched off -> DATA_QUERY_UNAVAILABLE (configuration) with the reason', async () => {
    const h = new MCPHandler([makeTool('bc_data_query',
      vi.fn().mockResolvedValue({ ok: false, error: new DataQueryUnavailableError('not offered', 'tools-disabled') }))], logger());
    const res = await call(h, 'bc_data_query');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('DATA_QUERY_UNAVAILABLE');
    expect(body.error.category).toBe('configuration');
    expect(body.error.details.reason).toBe('tools-disabled');
  });

  it('3c. AL compile error -> DATA_QUERY_ERROR (validation) keeping BC\'s diagnostics', async () => {
    const h = new MCPHandler([makeTool('bc_data_query',
      vi.fn().mockResolvedValue({ ok: false, error: new DataQueryError('Compilation failed:\n\n(1,67): error AL0345: ...') }))], logger());
    const res = await call(h, 'bc_data_query');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string; message: string } };
    expect(body.error.code).toBe('DATA_QUERY_ERROR');
    expect(body.error.category).toBe('validation');
    expect(body.error.message).toContain('AL0345');
  });

  it('4. server disconnect (thrown SessionLostError) -> SESSION_LOST (network), ids as JSON detail', async () => {
    const h = new MCPHandler([makeTool('bc_execute_action',
      vi.fn().mockRejectedValue(new SessionLostError('reconnected', ['pc1', 'pc2'])))], logger());
    const res = await call(h, 'bc_execute_action');
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('SESSION_LOST');
    expect(body.error.category).toBe('network');
    // Arrays are scalar-illegal in details, so they are JSON-stringified.
    expect(body.error.details.impactedPageContextIds).toBe('["pc1","pc2"]');
  });
});

describe('tool envelope contract — gate failures become envelopes', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-contract-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('5. in-doubt retry -> OPERATION_IN_DOUBT (state) with JSON-string details', async () => {
    const gate = new IdempotencyGate(new OperationLedger(dir), logger());
    const timeout = vi.fn().mockResolvedValue({ ok: false, error: new TimeoutError('watchdog') });
    const h = new MCPHandler([makeTool('bc_write_data', timeout, { zodSchema: z.object({}), readOnly: false })], logger(), [], { gate });
    await call(h, 'bc_write_data', { operationId: 'op-1' }); // settles unknown
    const res = await call(h, 'bc_write_data', { operationId: 'op-1' }); // in doubt
    expect(res.isError).toBe(true);
    assertEnvelope(res);
    const body = res.structuredContent as { error: { code: string; category: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('OPERATION_IN_DOUBT');
    expect(body.error.category).toBe('state');
    expect(body.error.details.operationId).toBe('op-1');
    expect(body.error.details.status).toBe('unknown');
    expect(JSON.parse(body.error.details.error as string).code).toBe('TIMEOUT_ERROR');
  });
});

describe('tool envelope contract — every tool success validates against its outputSchema', () => {
  const cases: Array<[string, z.ZodType, Record<string, unknown>]> = [
    ['bc_open_page', OpenPageOutputSchema, { pageContextId: 'p', pageType: 'Card', caption: 'c', isModal: false, sections: [], stateVersion: 0 }],
    ['bc_read_data', ReadDataOutputSchema, { section: {}, stateVersion: 0 }],
    ['bc_write_data', WriteDataOutputSchema, { results: [], allSucceeded: true, changedSections: [], dialogsOpened: [], requiresDialogResponse: false, validationWarnings: [], replaySafe: true }],
    ['bc_execute_action', ExecuteActionOutputSchema, { success: true, changedSections: [], openedPages: [], dialogsOpened: [], requiresDialogResponse: false, downloads: [], externalUris: [], replaySafe: true }],
    ['bc_close_page', ClosePageOutputSchema, { success: true, dialogsOpened: [], requiresDialogResponse: false, replaySafe: true }],
    ['bc_search_pages', SearchPagesOutputSchema, { results: [] }],
    ['bc_navigate', NavigateOutputSchema, { changedSections: [], dialogsOpened: [], requiresDialogResponse: false }],
    ['bc_respond_dialog', RespondDialogOutputSchema, { success: true, changedSections: [], dialogsOpened: [], requiresDialogResponse: false, openedPages: [], downloads: [], externalUris: [], replaySafe: true }],
    ['bc_switch_company', SwitchCompanyOutputSchema, { previousCompany: 'a', newCompany: 'b', invalidatedPageContextIds: [], replaySafe: true }],
    ['bc_list_companies', ListCompaniesOutputSchema, { currentCompany: 'a', companies: [] }],
    ['bc_run_report', RunReportOutputSchema, { success: true, reportId: 6, dialogsOpened: [], requiresDialogResponse: false, downloads: [], externalUris: [], replaySafe: false }],
    ['bc_wizard_navigate', WizardNavigateOutputSchema, { success: true, caption: 'c', fields: [], availableNav: [], closed: false, changedSections: [], dialogsOpened: [], downloads: [], externalUris: [], replaySafe: true }],
    ['bc_lookup', LookupOutputSchema, { rows: [], totalFound: 0 }],
    ['bc_query', QueryOutputSchema, { entity: 'customers', rows: [], rowCount: 0, hasMore: false }],
    ['bc_upload_file', UploadFileOutputSchema, { success: true, fileName: 'f', sizeBytes: 0, formId: 'form', dialogsOpened: [], replaySafe: false }],
    ['bc_get_operation', GetOperationOutputSchema, { entry: {} }],
    ['bc_run_tests', RunTestsOutputSchema, { outcome: 'failed', summary: { total: 1, passed: 0, failed: 1, skipped: 0, notRun: 0, durationMs: 4 }, results: [{ codeunitId: 50491, codeunitName: 'I49 SelfStart Tests', method: 'MockStoppedAfterSelfStart', status: 'failed', durationMs: 4, output: 'Assert.IsFalse failed.', callStack: 'Library Assert(CodeUnit 130002).IsFalse line 3' }], failedTests: [{ codeunitId: 50491, method: 'MockStoppedAfterSelfStart' }], suiteName: 'MCP', testRunnerCodeunitId: 130450, replaySafe: false }],
    ['bc_data_find_tables', DataFindTablesOutputSchema, { company: 'CRONUS Danmark A/S', tables: [{ tableId: 18, tableName: 'Customer' }] }],
    ['bc_data_get_table_schema', DataTableSchemaOutputSchema, { company: 'CRONUS Danmark A/S', tableId: 18, schema: 'Table: Customer (ID: 18)\nPrimary Key: No.\n' }],
    ['bc_data_get_table_relations', DataTableRelationsOutputSchema, { company: 'CRONUS Danmark A/S', tableId: 18, tableName: 'Customer', outgoing: [{ targetTableId: 9, targetTableName: 'Country/Region', viaFields: [{ fieldNo: 35, fieldName: 'Country/Region Code' }] }] }],
    ['bc_data_query', DataQueryOutputSchema, { company: 'CRONUS Danmark A/S', status: 'executed', columns: ['No', 'Name'], rows: [['10000', 'Kontorcentralen A/S']], rowCount: 1, skip: 0, top: 1, totalCount: 5, hasMore: true }],
  ];

  it('covers all 21 tools', () => {
    expect(cases).toHaveLength(21);
  });

  it.each(cases)('%s success carries schema-valid structuredContent', async (name, schema, value) => {
    const h = new MCPHandler([makeTool(name, vi.fn().mockResolvedValue({ ok: true, value }))], logger());
    const res = await call(h, name);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual(value);
    assertEnvelope(res, schema);
  });
});
