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

describe('RespondDialogOperation — "abort" BC ignored (#38)', () => {
  const run = (events: BCEvent[]) => new RespondDialogOperation(
    makeSession({ invoke: vi.fn(async () => ok(events)) }), makeRepo(), makeDownloadService(),
  ).execute({ pageContextId: 'pc:dialog:1', dialogFormId: 'dlg-x', response: 'abort' });

  it('fails definitely when BC answers Abort without closing the dialog (no Abort action)', async () => {
    const result = await run([{ type: 'InvokeCompleted' } as BCEvent]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INPUT_VALIDATION_ERROR'); // not ambiguous: the replay gate releases the id
      expect(result.error.message).toContain('still open');
    }
  });

  it('succeeds when the dialog closed (State=0)', async () => {
    const result = await run([{ type: 'PropertyChanged', formId: 'dlg-x', controlPath: 'server:', changes: { State: 0 } } as BCEvent]);
    expect(result.ok && result.value.replaySafe).toBe(true);
  });
});

// #55: "ok" must press the dialog's own OK button. InvokeAction(Ok) on server:c[0] runs a
// generic context action that closes a StandardDialog page (364 "Send Document to")
// without its OK, so the caller's RunModal() = Action::OK is false and nothing is sent.
describe('RespondDialogOperation: presses the dialog button', () => {
  function dialogRepo(children: unknown[]) {
    const repo = new PageContextRepository();
    repo.create('pc:dlg', 'D1', { isModal: true });
    repo.applyToPage('pc:dlg', [{
      type: 'DialogOpened', formId: 'D1',
      controlTree: { t: 'lf', ServerId: 'D1', PageType: 1, Caption: 'Send Document to', Children: children },
    } as BCEvent]);
    return repo;
  }

  it('invokes the OK action control of a StandardDialog page', async () => {
    const session = makeSession();
    const repo = dialogRepo([
      { t: 'gc', Children: [{ t: 'sc', Caption: 'Email' }] },
      { t: 'gc', Children: [
        { t: 'ac', Caption: 'OK', SystemAction: 300 },
        { t: 'ac', Caption: 'Cancel', SystemAction: 310 },
      ] },
    ]);
    await new RespondDialogOperation(session, repo, makeDownloadService())
      .execute({ pageContextId: 'pc:dlg', dialogFormId: 'D1', response: 'ok' });
    expect(session.invoke.mock.calls[0][0]).toMatchObject({ type: 'InvokeAction', formId: 'D1', controlPath: 'server:c[1]/c[0]', systemAction: 300 });
  });

  it('falls back to server:c[0] when the dialog has no such button', async () => {
    const session = makeSession();
    const repo = dialogRepo([{ t: 'gc', Children: [{ t: 'sc', Caption: 'Do you want to post?' }] }]);
    await new RespondDialogOperation(session, repo, makeDownloadService())
      .execute({ pageContextId: 'pc:dlg', dialogFormId: 'D1', response: 'yes' });
    expect(session.invoke.mock.calls[0][0]).toMatchObject({ controlPath: 'server:c[0]', systemAction: 380 });
  });
});

describe('RespondDialogOperation: StandardDialog OK/Cancel are LookupOk/LookupCancel', () => {
  // Live cronus291, page 364 "Send Document to": Refresh 30 at server:c[2], OK 330 and
  // Cancel 340 at server:c[3]/c[0..1].
  const sendDocumentTo = () => {
    const repo = new PageContextRepository();
    repo.create('pc:dlg', 'D1', { isModal: true });
    repo.applyToPage('pc:dlg', [{
      type: 'DialogOpened', formId: 'D1',
      controlTree: { t: 'lf', ServerId: 'D1', PageType: 1, Caption: 'Send Document to', Children: [
        { t: 'gc', Children: [{ t: 'sc', Caption: 'Email' }] },
        { t: 'gc', Children: [] },
        { t: 'ac', Caption: 'Refresh', SystemAction: 30 },
        { t: 'gc', Children: [
          { t: 'ac', Caption: 'OK', SystemAction: 330 },
          { t: 'ac', Caption: 'Cancel', SystemAction: 340 },
        ] },
      ] },
    } as BCEvent]);
    return repo;
  };

  it.each([
    ['ok', 'server:c[3]/c[0]', 330],
    ['cancel', 'server:c[3]/c[1]', 340],
  ] as const)('"%s" presses %s with SystemAction %d', async (response, controlPath, systemAction) => {
    const session = makeSession();
    await new RespondDialogOperation(session, sendDocumentTo(), makeDownloadService())
      .execute({ pageContextId: 'pc:dlg', dialogFormId: 'D1', response });
    expect(session.invoke.mock.calls[0][0]).toMatchObject({ type: 'InvokeAction', formId: 'D1', controlPath, systemAction });
  });
});
