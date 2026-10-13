// "Committed then dropped" end to end (issue #26): BC pushes InvokeCompleted for
// the posting and the socket dies before the RPC response frame. The path runs
// through a real BCWebSocket, BCSession, bc_respond_dialog and the MCPHandler
// replay gate; the ledger must end in 'unknown' and a retry must not re-send.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { createToolDefinition } from '../../src/operations/respond-dialog.tool.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import { createFakeBCSocket, invokeCompleted, type FakeScript } from '../helpers/fake-bc-socket.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
type ToolResult = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function harness(script: FakeScript, ledgerDir: string) {
  const { bcws, server } = createFakeBCSocket(script);
  const session = new BCSession(bcws, new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger() as never, 'default', 5_000, '',
    { pollIntervalMs: 60_000, maxDurationMs: 600_000 });
  Object.assign(session as unknown as Record<string, unknown>, { sessionId: 's', sessionKey: 'k', company: 'CRONUS', _initialized: true });
  const repo = new PageContextRepository();
  repo.create('pc:so:1', 'root-1');
  const op = new RespondDialogOperation(session, repo, { capture: async () => ({ downloads: [], externalUris: [] }) } as never);
  const handler = new MCPHandler([createToolDefinition({ respondDialog: op } as unknown as Operations)], logger(), [], { ledger: new OperationLedger(ledgerDir) });
  const post = () => handler.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'bc_respond_dialog', arguments: { pageContextId: 'pc:so:1', dialogFormId: 'dlg-1', response: 'yes', operationId: 'op-post' } },
  }).then(r => r.result as ToolResult);
  return { server, session, post, ledger: new OperationLedger(ledgerDir) };
}

describe('commit then drop', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-drop-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records the operation as unknown and refuses to re-send on retry', async () => {
    const { server, session, post, ledger } = harness((req, s) => {
      s.message([invokeCompleted(req.interactions[0]!.callbackId!)]); // BC committed...
      s.drop(); // ...and the socket died before the response frame.
    }, dir);

    const first = await post();
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toContain('WebSocket closed');
    expect(server.sent.map(r => r.interactions[0]!.interactionName)).toEqual(['InvokeAction']);
    expect(session.isAlive).toBe(false);
    expect(await ledger.get('op-post')).toMatchObject({ status: 'unknown', tool: 'bc_respond_dialog', error: { code: 'PROTOCOL_ERROR' } });

    const retry = await post();
    expect(retry.structuredContent).toMatchObject({ code: 'OPERATION_IN_DOUBT', operationId: 'op-post', status: 'unknown' });
    expect(server.sent).toHaveLength(1); // nothing re-sent to BC
  });

  it('records a normal reply as completed (fake reply path)', async () => {
    const { post, ledger } = harness((req, s) => s.reply(req.id, [invokeCompleted(req.interactions[0]!.callbackId!)]), dir);
    expect((await post()).isError).toBeUndefined();
    expect(await ledger.get('op-post')).toMatchObject({ status: 'completed' });
  });
});
