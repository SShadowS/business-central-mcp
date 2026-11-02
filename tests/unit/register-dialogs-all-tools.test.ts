// tests/unit/register-dialogs-all-tools.test.ts
//
// #52: every tool that can open a dialog registers it as a page context of its own
// (shared registerDialogs), not only bc_execute_action. Repro shape: Set Up Email
// wizard -> "next" opens the "Set up SMTP Account" page as a dialog.
import { describe, it, expect, vi } from 'vitest';
import { WizardNavigateOperation } from '../../src/operations/wizard-navigate.js';
import { WriteDataOperation } from '../../src/operations/write-data.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { UploadFileOperation } from '../../src/operations/upload-file.js';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const downloads = { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as never;
const done: BCEvent = { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent;

const smtpTree = {
  t: 'lf', Caption: 'Set up SMTP Account',
  Children: [{ t: 'gc', Children: [
    { t: 'sc', Caption: 'Account Name', Editable: true, Visible: true, StringValue: '', ColumnBinder: { Name: 'name' } },
  ] }],
};
const confirmTree = { t: 'lf', Caption: 'Do you want to save?', Children: [] };
const opened = (formId: string, ownerFormId: string, controlTree: unknown): BCEvent =>
  ({ type: 'DialogOpened', formId, ownerFormId, controlTree }) as BCEvent;

function makePage(repo: PageContextRepository, pcId: string, formId: string, pageType = 1) {
  repo.create(pcId, formId);
  repo.applyToPage(pcId, [{
    type: 'FormCreated', formId, isReload: false,
    controlTree: { t: 'lf', ServerId: formId, Caption: 'Host', PageType: pageType, Children: [
      { t: 'sc', Caption: 'Name', Editable: true, Visible: true, StringValue: '', ColumnBinder: { Name: 'n' } },
    ] },
  } as BCEvent]);
}

function expectRegistered(repo: PageContextRepository, d: { pageContextId: string; formId: string }, owner: string) {
  const ctx = repo.get(d.pageContextId)!;
  expect(ctx.rootFormId).toBe(d.formId);
  expect(ctx.isModal).toBe(true);
  expect(ctx.ownerPageContextId).toBe(owner);
}

describe('dialogs opened outside bc_execute_action get a pageContextId (#52)', () => {
  it('bc_wizard_navigate: the dialog a step opens can be filled with bc_write_data', async () => {
    const repo = new PageContextRepository();
    makePage(repo, 'pc:wiz', 'WIZ', 9);
    const events = [opened('E3A', 'WIZ', smtpTree), done];
    const actionService = {
      executeWizardNav: vi.fn(async () => { repo.applyToPage('pc:wiz', events); return ok({ success: true, events }); }),
    } as never;

    const nav = await new WizardNavigateOperation(actionService, repo, downloads).execute({ pageContextId: 'pc:wiz', action: 'next' });
    expect(nav.ok).toBe(true);
    if (!nav.ok) return;
    const dlg = nav.value.dialogsOpened[0]!;
    expect(dlg.message).toBe('Set up SMTP Account');
    expectRegistered(repo, dlg, 'pc:wiz');

    const invoke = vi.fn(async () => ok([
      { type: 'PropertyChanged', formId: 'E3A', controlPath: dlg.fields![0]!.controlPath, changes: { StringValue: 'Office' } }, done,
    ] as BCEvent[]));
    const write = await new WriteDataOperation(new DataService({ invoke } as never, repo, logger), repo)
      .execute({ pageContextId: dlg.pageContextId, fields: { 'Account Name': 'Office' } });
    expect(write.ok && write.value.allSucceeded).toBe(true);
    expect((invoke.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'SaveValue', formId: 'E3A' });
  });

  it('bc_write_data: an OnValidate confirm is registered under the written page', async () => {
    const repo = new PageContextRepository();
    makePage(repo, 'pc:card', 'CARD');
    const invoke = vi.fn(async () => ok([opened('C1', 'CARD', confirmTree), done]));
    const result = await new WriteDataOperation(new DataService({ invoke } as never, repo, logger), repo)
      .execute({ pageContextId: 'pc:card', fields: { Name: 'x' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectRegistered(repo, result.value.dialogsOpened[0]!, 'pc:card');
  });

  it('bc_respond_dialog: a follow-up dialog is owned by the opening page, not the answered dialog', async () => {
    const repo = new PageContextRepository();
    makePage(repo, 'pc:host', 'HOST');
    repo.create('pc:dlg1', 'D1', { isModal: true, ownerPageContextId: 'pc:host' });
    repo.applyToPage('pc:dlg1', [opened('D1', 'HOST', confirmTree)]);
    const session = { invoke: vi.fn(async () => ok([
      { type: 'PropertyChanged', formId: 'D1', controlPath: 'server:', changes: { State: 0 } },
      { type: 'FormClosed', formId: 'D1' },
      opened('D2', 'HOST', confirmTree), done,
    ] as BCEvent[])) } as never;

    const result = await new RespondDialogOperation(session, repo, downloads)
      .execute({ pageContextId: 'pc:dlg1', dialogFormId: 'D1', response: 'yes' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiresDialogResponse).toBe(true);
    expectRegistered(repo, result.value.dialogsOpened[0]!, 'pc:host');
  });

  it('bc_close_page: a blocking save dialog is registered; a completed close registers nothing', async () => {
    const repo = new PageContextRepository();
    makePage(repo, 'pc:card', 'CARD');
    const blocked = await new ClosePageOperation({ closePage: vi.fn(async () => ok({ events: [opened('S1', 'CARD', confirmTree)] })) } as never, repo)
      .execute({ pageContextId: 'pc:card' });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expectRegistered(repo, blocked.value.dialogsOpened[0]!, 'pc:card');

    const repo2 = new PageContextRepository();
    makePage(repo2, 'pc:card', 'CARD');
    const closePage = vi.fn(async () => { repo2.remove('pc:card'); return ok({ events: [opened('S1', 'CARD', confirmTree)] }); });
    const closed = await new ClosePageOperation({ closePage } as never, repo2).execute({ pageContextId: 'pc:card' });
    expect(closed.ok && closed.value.dialogsOpened).toEqual([]);
    expect(repo2.listPageContextIds()).toEqual([]);
  });

  it('bc_upload_file: a dialog the OnUpload code raises is registered under the page', async () => {
    const repo = new PageContextRepository();
    makePage(repo, 'pc:page', 'PAGE');
    const svc = { upload: vi.fn(async () => ok({ success: true, fileName: 'a.txt', sizeBytes: 1, formId: 'UP', events: [opened('E1', 'PAGE', confirmTree)] })) };
    const result = await new UploadFileOperation(svc as never, repo).execute({ pageContextId: 'pc:page', base64: 'YQ==', fileName: 'a.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectRegistered(repo, result.value.dialogsOpened[0]!, 'pc:page');
  });
});
