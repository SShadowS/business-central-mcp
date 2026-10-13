/**
 * Destructive tier (epic #17, #27): the operationId replay gate on a real posting.
 *
 * Each case creates a Sales Order (page 42) for customer 10000 with one line
 * (item 1996-S, Quantity 2, Qty. to Ship 1) and posts it with the default
 * "Ship and Invoice" choice. Half the line ships and invoices; the order stays,
 * so its line's "Quantity Shipped" counts how many times the posting committed.
 *
 *   (a) the committing bc_respond_dialog is sent twice through MCPHandler with one
 *       operationId: the second call replays the stored result without an invoke,
 *       and the order is shipped exactly once.
 *   (b) the client socket is killed after BC commits but before the response frame
 *       arrives: the ledger records 'unknown', a retry is OPERATION_IN_DOUBT, and
 *       bc_get_operation in a NEW session (new ledger instance on the same STATE_DIR)
 *       re-reads the order and returns it with an evidence hash; the line shows the
 *       posting did commit, once.
 *
 * Posts real documents. Run only against a disposable database:
 *   npx vitest run --config vitest.destructive.config.ts tests/integration/replay-post-destructive.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import type { BCWebSocket } from '../../src/connection/bc-websocket.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ActionService } from '../../src/services/action-service.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { GetOperationOperation, type GetOperationOutput } from '../../src/operations/get-operation.js';
import { createTargetDescriber } from '../../src/operations/target-descriptor.js';
import { createToolDefinition as respondDialogTool } from '../../src/operations/respond-dialog.tool.js';
import { createToolDefinition as getOperationTool } from '../../src/operations/get-operation.tool.js';
import { OperationLedger, digestInput } from '../../src/mcp/operation-ledger.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { actions as treeActions } from '../../src/protocol/form-views.js';
import { detectDialogs } from '../../src/protocol/mutation-result.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';
import { stubDownloadService } from './helpers/download-service.js';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

interface Rig {
  lease: PooledLease;
  session: BCSession;
  repo: PageContextRepository;
  pageService: PageService;
  dataService: DataService;
  actionService: ActionService;
  respond: RespondDialogOperation;
  ledger: OperationLedger;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

const logger = createNullLogger();

/** A fresh session + MCPHandler over a ledger on `stateDir` (a new instance each time, as after a process restart). */
async function rig(stateDir: string): Promise<Rig> {
  const lease = await integrationPool.checkOut();
  const session = lease.session;
  const repo = new PageContextRepository();
  const pageService = new PageService(session, repo, logger);
  const respond = new RespondDialogOperation(session, repo, stubDownloadService(logger));
  const ledger = new OperationLedger(stateDir);
  const ops = {
    respondDialog: respond,
    getOperation: new GetOperationOperation(ledger, pageService, () => session.companyName, () => session.modalStackSnapshot().length > 0),
  } as unknown as Operations;
  const handler = new MCPHandler([respondDialogTool(ops), getOperationTool(ops)], logger, [], {
    ledger, describeTarget: createTargetDescriber(repo, () => session.companyName),
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await handler.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result as ToolResult;
  return {
    lease, session, repo, pageService, respond, ledger, call,
    dataService: new DataService(session, repo, logger),
    actionService: new ActionService(session, repo, logger),
  };
}

/** Answer every dialog (and the dialogs those open) outside the replay gate. */
async function settleDialogs(r: Rig, pcId: string, dialogs: Array<{ formId: string }>, response: 'ok' | 'no'): Promise<void> {
  for (const d of dialogs) {
    const res = await r.respond.execute({ pageContextId: pcId, dialogFormId: d.formId, response });
    if (isOk(res)) await settleDialogs(r, pcId, res.value.dialogsOpened, response);
  }
}
const dialogsIn = (events: BCEvent[] | undefined) => (events ? detectDialogs(events) : []);

const rootBookmark = (r: Rig, pcId: string): string | undefined => {
  const ctx = r.repo.get(pcId)!;
  return ctx.forms.get(ctx.rootFormId)?.root.properties.bookmark;
};

const linesSectionOf = (r: Rig, pcId: string): string => {
  const id = [...r.repo.get(pcId)!.sections.entries()].find(([, s]) => s.kind === 'lines')?.[0];
  expect(id).toBeDefined();
  return id!;
};

/** Sales Order for 10000: one 1996-S line, Quantity 2, Qty. to Ship 1. Returns the open card and its record bookmark. */
async function createHalfShippableOrder(r: Rig): Promise<{ pcId: string; bookmark: string }> {
  const pcId = unwrap(await r.pageService.openPage('42')).pageContextId;
  const cust = await r.dataService.writeField(pcId, 'Customer No.', '10000');
  expect(isOk(cust)).toBe(true);
  await settleDialogs(r, pcId, dialogsIn(isOk(cust) ? cust.value.events : undefined), 'ok');

  const lines = linesSectionOf(r, pcId);
  expect(isOk(await r.actionService.executeAction(pcId, 'New', lines))).toBe(true);
  for (const [field, value] of [['Type', '2'], ['No.', '1996-S'], ['Quantity', '2'], ['Qty. to Ship', '1']] as const) {
    const w = await r.dataService.writeField(pcId, field, value, { sectionId: lines, rowIndex: 0 });
    if (!isOk(w)) throw new Error(`write ${field}=${value} failed: ${w.error.message}`);
    await settleDialogs(r, pcId, dialogsIn(w.value.events), 'ok');
  }

  const bookmark = rootBookmark(r, pcId);
  expect(bookmark).toBeTruthy();
  console.error(`[#27] order created, bookmark=${bookmark}`);
  return { pcId, bookmark: bookmark! };
}

/** Runs "Post..." and returns the dialog whose answer commits the posting. */
async function openPostDialog(r: Rig, pcId: string): Promise<{ dialogFormId: string; response: 'ok' | 'yes' }> {
  const ctx = r.repo.get(pcId)!;
  const post = treeActions(ctx.forms.get(ctx.rootFormId)!.root)
    .find(a => a.properties.visible !== false && a.properties.enabled !== false && /^P&?ost\.\.\.$/.test(a.properties.caption ?? ''));
  expect(post).toBeDefined();
  const ar = unwrap(await r.actionService.executeAction(pcId, post!.properties.caption!));
  const dialog = detectDialogs(ar.events)[0];
  expect(dialog).toBeDefined();
  console.error(`[#27] post dialog: "${dialog!.message ?? ''}"`);
  // An order's Post opens the Ship/Invoice choice (OK = default "Ship and Invoice");
  // a plain "Do you want to post ...?" confirm is answered Yes.
  return { dialogFormId: dialog!.formId, response: /want to/i.test(dialog!.message ?? '') ? 'yes' : 'ok' };
}

/** Re-opens the order and returns its line's "Quantity Shipped" (number of shipments x 1). */
async function quantityShipped(r: Rig, bookmark: string): Promise<number> {
  const pcId = unwrap(await r.pageService.openPage('42', { bookmark })).pageContextId;
  try {
    const row = buildSection(r.repo.get(pcId)!, linesSectionOf(r, pcId))?.rows?.[0];
    expect(row).toBeDefined();
    const raw = row!.cells['Quantity Shipped'];
    const text = typeof raw === 'string' ? raw : (raw as { stringValue?: string } | undefined)?.stringValue;
    if (text === undefined) throw new Error(`no "Quantity Shipped" cell; columns: ${Object.keys(row!.cells).join(', ')}`);
    return Number.parseFloat(text.replace(',', '.'));
  } finally {
    await r.pageService.closePage(pcId, { discardChanges: true }).catch(() => undefined);
  }
}

/**
 * Kills the socket the moment the response to the next Invoke arrives, before
 * BCWebSocket routes it: BC has finished (and committed) the interaction, the
 * client never sees the answer.
 */
function dropNextInvokeResponse(session: BCSession): void {
  const bcws = (session as unknown as { ws: BCWebSocket }).ws;
  const raw = (bcws as unknown as { ws: WebSocket }).ws;
  let invokeId: string | undefined;
  const send = raw.send.bind(raw) as (...a: unknown[]) => void;
  (raw as unknown as { send: (...a: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
    if (invokeId === undefined) {
      const msg = JSON.parse(String(data)) as { id?: unknown; method?: string };
      if (msg.method === 'Invoke') invokeId = String(msg.id);
    }
    send(data, ...rest);
  };
  const listeners = raw.listeners('message') as Array<(...a: unknown[]) => void>;
  raw.removeAllListeners('message');
  raw.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (invokeId !== undefined) {
      const msg = JSON.parse(data.toString()) as { id?: unknown; method?: string };
      if (msg.method === undefined && String(msg.id) === invokeId) {
        console.error('[#27] response frame arrived; killing the socket before it is routed');
        raw.terminate();
        return;
      }
    }
    for (const l of listeners) l.call(raw, data, isBinary);
  });
}

describe.sequential('Destructive: replay gate on a real posting (#27)', () => {
  let stateDir: string;
  let r: Rig;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'bcmcp-replay-post-'));
    r = await rig(stateDir);
  }, 60_000);

  afterAll(async () => {
    if (r) await integrationPool.checkIn(r.lease, { poisoned: !r.session.isAlive });
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('(a) posting twice with one operationId posts exactly once', async () => {
    const order = await createHalfShippableOrder(r);
    const dlg = await openPostDialog(r, order.pcId);
    const args = { pageContextId: order.pcId, ...dlg, operationId: `post-a-${randomUUID()}` };

    const first = await r.call('bc_respond_dialog', args);
    expect(first.isError).toBeFalsy();
    const out = JSON.parse(first.content[0]!.text) as { dialogsOpened: Array<{ formId: string; message?: string }>; replaySafe: boolean };
    console.error(`[#27] (a) posted; replaySafe=${out.replaySafe}, follow-up dialogs=${out.dialogsOpened.map(d => d.message).join(' | ')}`);
    expect(await r.ledger.get(args.operationId)).toMatchObject({ status: 'completed', tool: 'bc_respond_dialog' });
    await settleDialogs(r, order.pcId, out.dialogsOpened, 'no');

    const invoke = vi.spyOn(r.session, 'invoke');
    const invokeSequence = vi.spyOn(r.session, 'invokeSequence');
    try {
      const second = await r.call('bc_respond_dialog', args);
      expect(second).toEqual(first);
      expect(invoke).not.toHaveBeenCalled();
      expect(invokeSequence).not.toHaveBeenCalled();
    } finally {
      invoke.mockRestore();
      invokeSequence.mockRestore();
    }

    await r.pageService.closePage(order.pcId, { discardChanges: true });
    expect(await quantityShipped(r, order.bookmark)).toBe(1);
  }, 180_000);

  it('(b) a kill after commit leaves the operation in doubt, and bc_get_operation reads the committed record back', async () => {
    const order = await createHalfShippableOrder(r);
    const dlg = await openPostDialog(r, order.pcId);
    const args = { pageContextId: order.pcId, ...dlg, operationId: `post-b-${randomUUID()}` };

    dropNextInvokeResponse(r.session);
    const killed = await r.call('bc_respond_dialog', args);
    expect(killed.isError).toBe(true);
    expect(killed.structuredContent).toMatchObject({ replaySafe: false });
    expect(r.session.isAlive).toBe(false);
    expect(await r.ledger.get(args.operationId)).toMatchObject({ status: 'unknown', replaySafe: false });

    const retry = await r.call('bc_respond_dialog', args);
    expect(retry.structuredContent).toMatchObject({ code: 'OPERATION_IN_DOUBT', operationId: args.operationId, status: 'unknown' });

    // The client is gone: new session, new ledger instance over the same STATE_DIR.
    await integrationPool.checkIn(r.lease, { poisoned: true });
    r = await rig(stateDir);

    const got = await r.call('bc_get_operation', { operationId: args.operationId });
    expect(got.isError).toBeFalsy();
    const g = JSON.parse(got.content[0]!.text) as GetOperationOutput;
    console.error(`[#27] (b) readBack=${JSON.stringify(g.readBack)} evidenceHash=${g.evidenceHash}`);
    expect(g.entry).toMatchObject({ operationId: args.operationId, tool: 'bc_respond_dialog', status: 'unknown' });
    expect(g.entry.target?.page).toMatchObject({ pageId: '42', bookmark: order.bookmark });
    expect(g.readBackError).toBeUndefined();
    expect(g.readBack).toMatchObject({ pageId: '42', sectionId: 'header', bookmark: order.bookmark });
    expect(g.evidenceHash).toBe(digestInput(g.readBack));
    expect(g.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    // The response was lost, but the posting committed, once.
    expect(await quantityShipped(r, order.bookmark)).toBe(1);
  }, 240_000);
});
