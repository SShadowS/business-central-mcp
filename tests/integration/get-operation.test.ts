/**
 * Integration test: bc_get_operation (#25) against live BC.
 *
 * Writes Address 2 on the first customer through the MCP replay gate with an
 * operationId, then looks the operation up:
 *   - a changed value is echoed -> completed + replaySafe -> no read-back
 *   - rewriting the same value is unproven (replaySafe false) -> bc_get_operation
 *     re-opens the card by its record bookmark in the current session, reads the
 *     written field back, and hashes it
 * Restores the original value afterwards.
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
import { ActionService } from '../../src/services/action-service.js';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { GetOperationOperation, type GetOperationOutput } from '../../src/operations/get-operation.js';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { createToolDefinition as writeDataTool } from '../../src/operations/write-data.tool.js';
import { createToolDefinition as getOperationTool } from '../../src/operations/get-operation.tool.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { SystemAction } from '../../src/protocol/types.js';
import { fields as treeFields } from '../../src/protocol/form-views.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('bc_get_operation (integration)', () => {
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let pageService: PageService;
  let dataService: DataService;
  let actionService: ActionService;
  let openPageOp: OpenPageOperation;
  let writeDataOp: WriteDataOperation;
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
    writeDataOp = new WriteDataOperation(dataSvc, repo);
    stateDir = mkdtempSync(join(tmpdir(), 'bcmcp-getop-int-'));
    ledger = new OperationLedger(stateDir);
    const ops = {
      writeData: writeDataOp,
      getOperation: new GetOperationOperation(ledger, pageService, () => session.companyName, () => session.modalStackSnapshot().length > 0),
    } as unknown as Operations;
    handler = new MCPHandler([writeDataTool(ops), getOperationTool(ops)], logger, [], {
      ledger, describeTarget: createTargetDescriber(repo, () => session.companyName),
    });
    dataService = dataSvc;
    actionService = new ActionService(session, repo, logger);
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

  it('returns the ledger entry, and reads the record back when the write is not replay-safe', async () => {
    const list = unwrap(await openPageOp.execute({ pageId: '22' }));
    openedPages.push(list.pageContextId);
    const bookmark = unwrap(dataService.readRows(list.pageContextId))[0]!.bookmark;
    const editCard = async (): Promise<string> => {
      const card = unwrap(await openPageOp.execute({ pageId: '21', bookmark }));
      openedPages.push(card.pageContextId);
      expect(isOk(await actionService.executeSystemAction(card.pageContextId, SystemAction.Edit))).toBe(true);
      return card.pageContextId;
    };
    const cardId = await editCard();

    const ctx = repo.get(cardId)!;
    const original = treeFields(ctx.forms.get(ctx.rootFormId)!.root)
      .find(f => f.properties.caption === 'Address 2')?.properties.stringValue ?? '';
    const probe = original === 'GETOP' ? 'GETOP2' : 'GETOP';
    const op1 = `getop-${randomUUID()}`;
    const op2 = `getop-${randomUUID()}`;

    try {
      const w1 = await call('bc_write_data', { pageContextId: cardId, fields: { 'Address 2': probe }, operationId: op1 });
      expect(w1.isError).toBeFalsy();
      const g1 = JSON.parse((await call('bc_get_operation', { operationId: op1 })).text) as GetOperationOutput;
      expect(g1.entry).toMatchObject({ operationId: op1, tool: 'bc_write_data', status: 'completed', replaySafe: true });
      expect(g1.readBack).toBeUndefined();

      // Same value again: BC does not echo an unchanged value, so it is unproven.
      const w2 = await call('bc_write_data', { pageContextId: cardId, fields: { 'Address 2': probe }, operationId: op2 });
      expect(w2.isError).toBeFalsy();
      // The card holds the change until it is closed (SaveOnNavigate); close it so
      // a fresh read sees the stored record.
      expect(isOk(await pageService.closePage(cardId))).toBe(true);
      const g2 = JSON.parse((await call('bc_get_operation', { operationId: op2 })).text) as GetOperationOutput;
      expect(g2.entry).toMatchObject({ status: 'completed', replaySafe: false });
      expect(g2.entry.target?.page?.bookmark).toBeTruthy();
      expect(g2.readBackError).toBeUndefined();
      // The card's own record, not a factbox's (hosted-part PropertyChanged must not clobber it).
      expect(g2.entry.target!.page!.bookmark).toBe(bookmark);
      expect(g2.readBack).toMatchObject({ pageId: '21', sectionId: 'header', bookmark });
      expect(g2.readBack!.fields!['Address 2']).toBe(probe);
      expect(g2.evidenceHash).toBe(digestInput(g2.readBack));
      expect(g2.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      const restoreId = await editCard();
      await writeDataOp.execute({ pageContextId: restoreId, fields: { 'Address 2': original } });
      await pageService.closePage(restoreId);
    }
  }, 120_000);

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
  }, 120_000);
});
