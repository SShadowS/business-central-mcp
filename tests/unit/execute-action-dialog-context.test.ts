// tests/unit/execute-action-dialog-context.test.ts
//
// A dialog opened by bc_execute_action is registered as a page context (the way
// bc_run_report registers its request page), and dialogsOpened[] returns its
// pageContextId. Its fields are filled with the existing bc_write_data against that
// id; bc_respond_dialog stays a plain button press.
import { describe, it, expect, vi } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { RespondDialogSchema } from '../../src/mcp/schemas.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const copyDialogTree = {
  t: 'lf',
  Caption: 'Copy Sales Document',
  Children: [
    {
      t: 'gc',
      Children: [
        { t: 'sc', Caption: 'Document No.', Editable: true, Visible: true, StringValue: '', ColumnBinder: { Name: 'docNo' } },
        { t: 'sc', Caption: 'Include Header', Editable: true, Visible: true, StringValue: 'No', ColumnBinder: { Name: 'inclHdr' } },
      ],
    },
  ],
};

const confirmTree = { t: 'lf', Caption: 'Do you want to post?', Children: [] };

function makeHost(repo: PageContextRepository) {
  repo.create('pc:host', 'HOST');
  repo.applyToPage('pc:host', [{
    type: 'FormCreated', formId: 'HOST', isReload: false,
    controlTree: { t: 'lf', ServerId: 'HOST', PageType: 1, Children: [{ t: 'ac', Caption: 'Copy Document', SystemAction: 0 }] },
  } as BCEvent]);
}

function makeActionOp(repo: PageContextRepository, events: BCEvent[]) {
  const first = events.find(e => e.type === 'DialogOpened') as (BCEvent & { type: 'DialogOpened' }) | undefined;
  // Mirrors ActionService.invokeAction: the events are applied to the host page first.
  const actionService = {
    executeAction: vi.fn(async () => {
      repo.applyToPage('pc:host', events);
      return ok({
        success: true, events,
        dialog: first ? { formId: first.formId, controlTree: first.controlTree } : undefined,
        updatedState: repo.get('pc:host'),
      });
    }),
  } as never;
  const downloads = { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as never;
  return new ExecuteActionOperation(actionService, repo, {} as never, downloads, 100);
}

const dialogOpened = (formId: string, controlTree: unknown): BCEvent =>
  ({ type: 'DialogOpened', formId, ownerFormId: 'HOST', controlTree }) as BCEvent;

describe('bc_execute_action registers opened dialogs as page contexts', () => {
  it('returns a pageContextId per dialog, holding the dialog as its root form', async () => {
    const repo = new PageContextRepository();
    makeHost(repo);
    const op = makeActionOp(repo, [dialogOpened('DLG1', copyDialogTree)]);

    const result = await op.execute({ pageContextId: 'pc:host', action: 'Copy Document' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.requiresDialogResponse).toBe(true);
    expect(result.value.dialogsOpened).toHaveLength(1);
    const dlg = result.value.dialogsOpened[0]!;
    expect(dlg.formId).toBe('DLG1');
    expect(dlg.message).toBe('Copy Sales Document');
    expect(dlg.fields?.map(f => f.caption)).toEqual(['Document No.', 'Include Header']);
    expect(result.value.dialog?.pageContextId).toBe(dlg.pageContextId);

    const ctx = repo.get(dlg.pageContextId)!;
    expect(ctx.rootFormId).toBe('DLG1');
    expect(ctx.isModal).toBe(true);
    expect(ctx.caption).toBe('Copy Sales Document');
    expect(repo.getByFormId('DLG1')?.pageContextId).toBe(dlg.pageContextId);
    // The page that opened the dialog still lists it (the upload flow looks it up there).
    expect(repo.get('pc:host')!.dialogs.map(d => d.formId)).toEqual(['DLG1']);
  });

  it('gives each dialog of one response its own context, without leaking siblings', async () => {
    const repo = new PageContextRepository();
    makeHost(repo);
    const op = makeActionOp(repo, [dialogOpened('DLG1', copyDialogTree), dialogOpened('DLG2', confirmTree)]);

    const result = await op.execute({ pageContextId: 'pc:host', action: 'Copy Document' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.value.dialogsOpened;
    expect(a!.pageContextId).not.toBe(b!.pageContextId);
    expect(repo.get(a!.pageContextId)!.dialogs).toEqual([]);
    expect(repo.get(b!.pageContextId)!.dialogs).toEqual([]);
    expect(repo.get(a!.pageContextId)!.rootFormId).toBe('DLG1');
    expect(repo.get(b!.pageContextId)!.rootFormId).toBe('DLG2');
  });

  it('registers nothing when the action opens no dialog', async () => {
    const repo = new PageContextRepository();
    makeHost(repo);
    const op = makeActionOp(repo, []);

    const result = await op.execute({ pageContextId: 'pc:host', action: 'Copy Document' });
    expect(result.ok && result.value.dialogsOpened).toEqual([]);
    expect(repo.listPageContextIds()).toEqual(['pc:host']);
  });
});

describe('filling a dialog field with bc_write_data against its pageContextId', () => {
  async function openDialog() {
    const repo = new PageContextRepository();
    makeHost(repo);
    const opened = await makeActionOp(repo, [dialogOpened('DLG1', copyDialogTree)])
      .execute({ pageContextId: 'pc:host', action: 'Copy Document' });
    if (!opened.ok) throw new Error('action failed');
    return { repo, dialogPcId: opened.value.dialogsOpened[0]!.pageContextId, fields: opened.value.dialogsOpened[0]!.fields! };
  }

  it('sends SaveValue on the dialog form and reports the value BC echoed', async () => {
    const { repo, dialogPcId, fields } = await openDialog();
    const docNo = fields.find(f => f.caption === 'Document No.')!;
    const invoke = vi.fn(async () => ok([
      { type: 'PropertyChanged', formId: 'DLG1', controlPath: docNo.controlPath, changes: { StringValue: '101001' } },
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ] as BCEvent[]));
    const write = new WriteDataOperation(new DataService({ invoke } as never, repo, logger), repo);

    const result = await write.execute({ pageContextId: dialogPcId, fields: { 'Document No.': '101001' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(invoke).toHaveBeenCalledOnce();
    const [interaction] = invoke.mock.calls[0] as unknown as [{ type: string; formId: string; controlPath: string; newValue: string }];
    expect(interaction).toMatchObject({ type: 'SaveValue', formId: 'DLG1', controlPath: docNo.controlPath, newValue: '101001' });
    expect(result.value.allSucceeded).toBe(true);
    expect(result.value.results[0]).toMatchObject({ fieldName: 'Document No.', success: true, newValue: '101001', echoed: true });
    expect(result.value.replaySafe).toBe(true);
    // The echo lands in the dialog's own context.
    const field = repo.get(dialogPcId)!.forms.get('DLG1')!;
    expect(JSON.stringify(field.root)).toContain('101001');
  });

  it('does not send anything for a field the dialog does not have and lists the candidates', async () => {
    const { repo, dialogPcId } = await openDialog();
    const invoke = vi.fn();
    const write = new WriteDataOperation(new DataService({ invoke } as never, repo, logger), repo);

    const result = await write.execute({ pageContextId: dialogPcId, fields: { 'No Such Field': 'x' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(invoke).not.toHaveBeenCalled();
    expect(result.value.allSucceeded).toBe(false);
    expect(result.value.results[0]!.success).toBe(false);
    expect(result.value.results[0]!.error).toContain('Field not found');
  });
});

describe('bc_respond_dialog is a plain button press', () => {
  it('has no fields parameter and no "none" response', () => {
    expect(RespondDialogSchema.shape).not.toHaveProperty('fields');
    const base = { pageContextId: 'p', dialogFormId: 'd' };
    expect(RespondDialogSchema.safeParse({ ...base, response: 'ok' }).success).toBe(true);
    expect(RespondDialogSchema.safeParse({ ...base, response: 'none' }).success).toBe(false);
  });

  it('answering through the dialog page context closes it and keeps the opener in sync', async () => {
    const repo = new PageContextRepository();
    makeHost(repo);
    const opened = await makeActionOp(repo, [dialogOpened('DLG1', copyDialogTree)])
      .execute({ pageContextId: 'pc:host', action: 'Copy Document' });
    if (!opened.ok) throw new Error('action failed');
    const dialogPcId = opened.value.dialogsOpened[0]!.pageContextId;

    const session = {
      invoke: vi.fn(async () => ok([
        { type: 'PropertyChanged', formId: 'HOST', controlPath: 'server:c[0]', changes: { Caption: 'Copied' } },
        { type: 'PropertyChanged', formId: 'DLG1', controlPath: 'server:', changes: { State: 0 } },
        { type: 'FormClosed', formId: 'DLG1' },
        { type: 'InvokeCompleted', sequenceNumber: 2, completedInteractions: [] },
      ] as BCEvent[])),
    } as never;
    const downloads = { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as never;
    const respond = new RespondDialogOperation(session, repo, downloads);

    const result = await respond.execute({ pageContextId: dialogPcId, dialogFormId: 'DLG1', response: 'ok' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replaySafe).toBe(true);
    expect(result.value).not.toHaveProperty('fieldResults');
    // The closed dialog no longer shows up on the page that opened it.
    expect(repo.get('pc:host')!.dialogs).toEqual([]);
    // The host's change in the same response was routed to the host, not dropped.
    expect(JSON.stringify(repo.get('pc:host')!.forms.get('HOST')!.root)).toContain('Copied');
  });
});
