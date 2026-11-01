// tests/unit/execute-action-messages-rowindex.test.ts
//
// #49: AL Message() (MessageToShow Info/Warning/None) reaches the caller as `messages`.
// #51: a rowIndex past the loaded rows is an argument error, not a protocol error.

import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { ok } from '../../src/core/result.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { collectMessages } from '../../src/protocol/mutation-result.js';
import { toBcErrorBody } from '../../src/mcp/error-envelope.js';
import type { BCEvent } from '../../src/protocol/types.js';

const msg = (text: string, messageType: string): BCEvent =>
  ({ type: 'MessageToShow', formId: '', text, messageType, actions: ['Ok'], defaultAction: 'Ok' }) as BCEvent;

function makeRepoWithEmptyRepeater() {
  const repo = new PageContextRepository();
  repo.create('pc:1', 'F1', { isModal: false, wizardState: null });
  repo.applyEvents([{
    type: 'FormCreated',
    formId: 'F1',
    controlTree: { t: 'lf', ServerId: 'F1', PageType: 1, Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.' }] }] },
  } as BCEvent]);
  return repo;
}

function makeOp(events: BCEvent[], repo = makeRepoWithEmptyRepeater()) {
  const actionService = {
    executeAction: vi.fn(async () => ok({ success: true, events })),
    isCurrentRowOnlyAction: () => false,
  } as any;
  const nav = { selectRow: vi.fn(async () => ok({})) } as any;
  const downloads = { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any;
  return { op: new ExecuteActionOperation(actionService, repo, nav, downloads, 100), actionService };
}

describe('AL Message() in results (#49)', () => {
  it('returns Info/Warning messages from bc_execute_action', async () => {
    const { op } = makeOp([msg('1 document(s) will be sent in the background.', 'Info'), msg('Careful', 'Warning')]);
    const result = await op.execute({ pageContextId: 'pc:1', action: 'Send' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages).toEqual([
        { text: '1 document(s) will be sent in the background.', type: 'Info' },
        { text: 'Careful', type: 'Warning' },
      ]);
    }
  });

  it('collectMessages leaves Error/Fatal to classifyBusinessError', () => {
    expect(collectMessages([msg('a', 'None'), msg('b', 'Error'), msg('c', 'Fatal')])).toEqual([{ text: 'a', type: 'None' }]);
  });
});

describe('rowIndex out of range (#51)', () => {
  it('is INVALID_ARGUMENT with a non-retry next step, and nothing is sent', async () => {
    const { op, actionService } = makeOp([]);
    const result = await op.execute({ pageContextId: 'pc:1', action: 'Delete', rowIndex: 0 });
    expect(result.ok).toBe(false);
    expect(actionService.executeAction).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error.code).toBe('INPUT_VALIDATION_ERROR');
      expect(result.error.message).toMatch(/rowIndex: 0 is out of range \(0 rows loaded\)/);
      const body = toBcErrorBody('bc_execute_action', result.error) as any;
      expect(JSON.stringify(body)).toMatch(/INVALID_ARGUMENT/);
      expect(JSON.stringify(body)).not.toMatch(/Retry/);
    }
  });
});
