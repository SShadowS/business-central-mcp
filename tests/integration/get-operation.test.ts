/**
 * Integration test: bc_get_operation (#25) against live BC.
 *
 * Read-only: seeds ledger entries for document and card targets and checks
 * bc_get_operation re-opens and reads them back. The case that writes a real
 * customer through the replay gate is in get-operation-destructive.test.ts.
 *
 * Run with:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/get-operation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { GetOperationOperation, type GetOperationOutput } from '../../src/operations/get-operation.js';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { createToolDefinition as writeDataTool } from '../../src/operations/write-data.tool.js';
import { createToolDefinition as getOperationTool } from '../../src/operations/get-operation.tool.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('bc_get_operation (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let openPageOp: OpenPageOperation;
  let handler: MCPHandler;
  let stateDir: string;
  let ledger: OperationLedger;

  const logger = createNullLogger();
  const openedPages: string[] = [];

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
    const dataSvc = new DataService(session, repo, logger);
    openPageOp = new OpenPageOperation(pageService);
    stateDir = mkdtempSync(join(tmpdir(), 'bcmcp-getop-int-'));
    ledger = new OperationLedger(stateDir);
    const ops = {
      writeData: new WriteDataOperation(dataSvc, repo),
      getOperation: new GetOperationOperation(ledger, pageService, () => session.companyName, () => session.modalStackSnapshot().length > 0),
    } as unknown as Operations;
    handler = new MCPHandler([writeDataTool(ops), getOperationTool(ops)], logger, [], {
      gate: new IdempotencyGate(ledger, logger, createTargetDescriber(repo, () => session.companyName)),
    });
    dataService = dataSvc;
  }, 60_000);

  afterAll(async () => {
    for (const ctxId of [...openedPages].reverse()) {
      try { await pageService.closePage(ctxId, { discardChanges: true }); } catch { /* ignore */ }
    }
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  }, 60_000);

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const res = await handler.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  }

  // The write + read-back case (writes Address 2 on a real customer) lives in
  // get-operation-destructive.test.ts.

  it('reads a document target back with its lines (commit-sensitive state, e.g. Quantity Shipped)', async () => {
    const orders = unwrap(await openPageOp.execute({ pageId: '9305' }));
    openedPages.push(orders.pageContextId);
    const bookmark = unwrap(dataService.readRows(orders.pageContextId))[0]!.bookmark;
    const order = unwrap(await openPageOp.execute({ pageId: '42', bookmark }));
    const target = createTargetDescriber(repo, () => session.companyName)({ pageContextId: order.pageContextId, dialogFormId: 'x', response: 'ok' });
    expect(isOk(await pageService.closePage(order.pageContextId, { discardChanges: true }))).toBe(true);
    const id = `getop-doc-${randomUUID()}`;
    await ledger.claim(id, 'bc_respond_dialog', 'digest', target);
    await ledger.settle(id, { status: 'unknown', replaySafe: false });

    const g = JSON.parse((await call('bc_get_operation', { operationId: id })).text) as GetOperationOutput;
    expect(g.readBackError).toBeUndefined();
    expect(g.readBack).toMatchObject({ pageId: '42', sectionId: 'header', bookmark: target.page!.bookmark });
    expect(g.readBack!.lines!.length).toBeGreaterThan(0);
    expect(Object.keys(g.readBack!.lines![0]!.cells)).toContain('Quantity Shipped');
    // #33/#34: Sales Header key is (Document Type=1, No.=3). Live: field 1 has no control on
    // page 42, so it is decoded from the record bookmark (Order = ordinal 1); "No." is a
    // hidden control, read by TableFieldNo, not caption.
    expect(target.keyFields?.map(k => k.fieldNo)).toEqual([1, 3]);
    expect(target.keyFields![0]).toEqual({ fieldNo: 1, caption: 'Document Type', value: '1', source: 'bookmark' });
    expect(target.keyFields![1]!.source).toBeUndefined();
    expect(target.keyFields![1]!.value).toBeTruthy();
    expect(target.fields).toBeUndefined();
    expect(g.readBack!.keyFields).toEqual(target.keyFields);
  }, 120_000);

  it('identifies a card by its primary key (Customer Card 21: field 1 "No.")', async () => {
    const list = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(list.pageContextId);
    const row = unwrap(dataService.readRows(list.pageContextId))[0]!;
    const card = unwrap(await openPageOp.execute({ pageId: '21', bookmark: row.bookmark }));
    const target = createTargetDescriber(repo, () => session.companyName)({ pageContextId: card.pageContextId, action: 'Statistics' });
    expect(isOk(await pageService.closePage(card.pageContextId, { discardChanges: true }))).toBe(true);
    expect(target.keyFields).toEqual([{ fieldNo: 1, caption: 'No.', value: expect.stringMatching(/\S/) }]);
    const id = `getop-card-${randomUUID()}`;
    await ledger.claim(id, 'bc_execute_action', 'digest', target);
    await ledger.settle(id, { status: 'unknown', replaySafe: false });

    const g = JSON.parse((await call('bc_get_operation', { operationId: id })).text) as GetOperationOutput;
    expect(g.readBackError).toBeUndefined();
    expect(g.readBack!.keyFields).toEqual(target.keyFields);
    expect(g.readBack!.fields).toBeUndefined();
    expect(g.evidenceHash).toBe(digestInput(g.readBack));
  }, 120_000);
});
