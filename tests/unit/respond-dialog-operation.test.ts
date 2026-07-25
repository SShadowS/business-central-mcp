// tests/unit/respond-dialog-operation.test.ts
//
// Unit tests for RespondDialogOperation.
// Key behaviors:
//   - 'close' response uses CloseForm interaction (NOT InvokeAction)
//   - Other responses map to SystemAction codes via RESPONSE_MAP
//   - Unknown pageContextId returns err before any session calls
//   - Invalid response string returns PROTOCOL_ERROR before any session calls
//   - Output shape: { success, changedSections, dialogsOpened, requiresDialogResponse, openedPages }

import { describe, it, expect, vi } from 'vitest';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeSession(overrides?: Record<string, unknown>) {
  return {
    invoke: vi.fn(async () => ok([] as BCEvent[])),
    ...overrides,
  } as any;
}

function makeRepo(withPageContext = true) {
  const repo = new PageContextRepository();
  if (withPageContext) {
    repo.create('pc:dialog:1', 'root-form-1');
  }
  return repo;
}

// Minimal stub for DownloadService — captures nothing.
function makeDownloadService() {
  return { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any;
}

describe('RespondDialogOperation — pageContextId validation', () => {
  it('returns PROTOCOL_ERROR for unknown pageContextId without invoking session', async () => {
    const session = makeSession();
    const repo = makeRepo(false); // no page contexts
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:does-not-exist',
      dialogFormId: 'dlg1',
      response: 'ok',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Page context not found');
      expect(result.error.message).toContain('pc:does-not-exist');
    }
    expect(session.invoke).not.toHaveBeenCalled();
  });
});

describe('RespondDialogOperation — "close" response', () => {
  it('sends CloseForm interaction (not InvokeAction) for response="close"', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'close',
    });

    expect(session.invoke).toHaveBeenCalledOnce();
    const [interaction] = session.invoke.mock.calls[0]!;
    expect(interaction.type).toBe('CloseForm');
    expect(interaction.formId).toBe('dlg1');
  });

  it('"close" response returns success=true with empty openedPages', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'close',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect(result.value.openedPages).toEqual([]);
    expect(result.value.requiresDialogResponse).toBe(false);
  });

  it('"close" propagates session error', async () => {
    const session = makeSession({
      invoke: vi.fn(async () => err(new ProtocolError('session closed unexpectedly'))),
    });
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'close',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('session closed unexpectedly');
    }
  });
});

describe('RespondDialogOperation — RESPONSE_MAP routing', () => {
  const responseToSystemAction: Array<[string, number]> = [
    ['ok', 300],       // SystemAction.Ok
    ['cancel', 310],   // SystemAction.Cancel
    ['yes', 380],      // SystemAction.Yes
    ['no', 390],       // SystemAction.No
    ['abort', 320],    // SystemAction.Abort
  ];

  for (const [response, expectedSystemAction] of responseToSystemAction) {
    it(`response="${response}" sends InvokeAction with systemAction=${expectedSystemAction}`, async () => {
      const session = makeSession();
      const repo = makeRepo();
      const op = new RespondDialogOperation(session, repo, makeDownloadService());

      await op.execute({
        pageContextId: 'pc:dialog:1',
        dialogFormId: 'dlg-form-1',
        response: response as any,
      });

      expect(session.invoke).toHaveBeenCalledOnce();
      const [interaction] = session.invoke.mock.calls[0]!;
      expect(interaction.type).toBe('InvokeAction');
      expect(interaction.formId).toBe('dlg-form-1');
      expect(interaction.systemAction).toBe(expectedSystemAction);
    });
  }

  it('response="ok" sends InvokeAction (NOT CloseForm)', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'ok',
    });

    const [interaction] = session.invoke.mock.calls[0]!;
    expect(interaction.type).toBe('InvokeAction');
    expect(interaction.type).not.toBe('CloseForm');
  });
});

describe('RespondDialogOperation — output shape', () => {
  it('returns success=true with empty changedSections, dialogsOpened, openedPages when no events emitted', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'ok',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
    expect(result.value.changedSections).toEqual([]);
    expect(result.value.dialogsOpened).toEqual([]);
    expect(result.value.requiresDialogResponse).toBe(false);
    expect(result.value.openedPages).toEqual([]);
  });

  it('sets requiresDialogResponse=true and includes dialog when DialogOpened event received', async () => {
    const dialogEvent: BCEvent = {
      type: 'DialogOpened',
      formId: 'confirm-dlg',
      controlTree: { t: 'lf', ServerId: 'confirm-dlg', Caption: 'Confirm deletion', Children: [] },
    } as any;
    const session = makeSession({
      invoke: vi.fn(async () => ok([dialogEvent])),
    });
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'yes',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiresDialogResponse).toBe(true);
    expect(result.value.dialogsOpened).toHaveLength(1);
    expect(result.value.dialogsOpened[0]!.formId).toBe('confirm-dlg');
    expect(result.value.dialogsOpened[0]!.message).toBe('Confirm deletion');
  });

  it('propagates InvokeAction session error unchanged', async () => {
    const session = makeSession({
      invoke: vi.fn(async () => err(new ProtocolError('invoke failed'))),
    });
    const repo = makeRepo();
    const op = new RespondDialogOperation(session, repo, makeDownloadService());

    const result = await op.execute({
      pageContextId: 'pc:dialog:1',
      dialogFormId: 'dlg1',
      response: 'cancel',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('invoke failed');
    }
  });
});
