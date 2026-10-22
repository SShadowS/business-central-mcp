// bc_write_data must not fold a failed invoke into a per-field result: BCSession reports a
// timeout or a lost socket as ProtocolError, so the value may have reached BC. The call
// fails, nothing more is sent, and the ledger records it as unknown (not completed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { DataService } from '../../src/services/data-service.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { createToolDefinition } from '../../src/operations/write-data.tool.js';
import { MCPHandler } from '../../src/mcp/handler.js';
import { OperationLedger } from '../../src/mcp/operation-ledger.js';
import { IdempotencyGate } from '../../src/mcp/idempotency-gate.js';
import type { Operations } from '../../src/mcp/tool-registry.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { createFakeBCSocket, invokeCompleted, type FakeScript } from '../helpers/fake-bc-socket.js';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
type ToolResult = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function harness(script: FakeScript, ledgerDir: string) {
  const { bcws, server } = createFakeBCSocket(script);
  const session = new BCSession(bcws, new EventDecoder(), new InteractionEncoder('28.0.0.0'), logger() as never, 'default', 5_000, '',
    { pollIntervalMs: 60_000, maxDurationMs: 600_000 });
  Object.assign(session as unknown as Record<string, unknown>, { sessionId: 's', sessionKey: 'k', company: 'CRONUS', _initialized: true });
  const repo = new PageContextRepository();
  repo.create('pc:card', 'CARD');
  repo.applyToPage('pc:card', [{
    type: 'FormCreated', formId: 'CARD', isReload: false,
    controlTree: { t: 'lf', ServerId: 'CARD', PageType: 1, Children: [{ t: 'gc', Children: [
      { t: 'sc', Caption: 'Name', Editable: true, Visible: true, StringValue: '' },
      { t: 'sc', Caption: 'City', Editable: true, Visible: true, StringValue: '' },
    ] }] },
  } as BCEvent]);
  const op = new WriteDataOperation(new DataService(session, repo, logger() as never), repo);
  const handler = new MCPHandler([createToolDefinition({ writeData: op } as unknown as Operations)], logger(), [], { gate: new IdempotencyGate(new OperationLedger(ledgerDir), logger() as never) });
  const write = (fields: Record<string, string>) => handler.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'bc_write_data', arguments: { pageContextId: 'pc:card', fields, operationId: 'op-write' } },
  }).then(r => r.result as ToolResult);
  return { server, write, ledger: new OperationLedger(ledgerDir) };
}

describe('bc_write_data on a failed invoke', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bcmcp-write-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('fails the call, stops writing and leaves the ledger unknown', async () => {
    const { server, write, ledger } = harness((req, s) => {
      s.message([invokeCompleted(req.interactions[0]!.callbackId!)]); // BC stored Name...
      s.drop(); // ...and the socket died before the response frame.
    }, dir);

    const result = await write({ Name: 'Contoso', City: 'London' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('WebSocket closed');
    expect(server.sent.map(r => r.interactions[0]!.interactionName)).toEqual(['SaveValue']);
    expect(await ledger.get('op-write')).toMatchObject({ status: 'unknown', tool: 'bc_write_data', error: { code: 'PROTOCOL_ERROR' } });
  });

  it('still reports an unknown field per field, next to the fields BC stored', async () => {
    const { server, write } = harness((req, s) => s.reply(req.id, [invokeCompleted(req.interactions[0]!.callbackId!)]), dir);

    const result = await write({ Nmae: 'Contoso', City: 'London' });
    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as { allSucceeded: boolean; results: Array<{ fieldName: string; success: boolean; error?: string }> };
    expect(out.allSucceeded).toBe(false);
    expect(out.results).toMatchObject([
      { fieldName: 'Nmae', success: false, error: expect.stringContaining('Field not found') },
      { fieldName: 'City', success: true },
    ]);
    expect(server.sent).toHaveLength(1);
  });
});
