// One dialog shape for every tool (recorded flow 2026-11-24): the discard confirm came back
// as message "Confirm" with its question in fields[0].caption, wire keys (controlPath, type
// "ssc", ancestorGroupPaths) and no hint which answers are valid.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeDialog, registerDialogs } from '../../src/protocol/mutation-result.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageService } from '../../src/services/page-service.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import type { BCEvent, DialogOpenedEvent } from '../../src/protocol/types.js';

const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/dialogs/${name}.json`, 'utf8')) as DialogOpenedEvent;
const confirm = fixture('discard-confirm');
const requestPage = fixture('request-page-report6');
const WIRE_KEYS = ['controlPath', 'stringValue', 'columnBinderName', 'ancestorGroupPaths', 'caption'];

describe('describeDialog', () => {
  it('a confirm carries its question as message and yes/no as responses', () => {
    const d = describeDialog(confirm.formId, confirm.controlTree);
    expect(d.kind).toBe('confirm');
    expect(d.message).toMatch(/Do you want to discard these changes\?/);
    expect(d.responses).toEqual(['yes', 'no']);
    expect(d.fields ?? []).toEqual([]); // the question is the message, not a field
  });

  it('a request page lists its fields in the section field shape and ok/cancel', () => {
    const d = describeDialog(requestPage.formId, requestPage.controlTree);
    expect(d.kind).toBe('requestPage');
    expect(d.title).toBeTruthy();
    expect(d.responses).toEqual(expect.arrayContaining(['ok', 'cancel']));
    const maxRows = d.fields!.find(f => f.name === 'Maximum rows');
    expect(maxRows).toMatchObject({ name: 'Maximum rows', editable: true });
    for (const f of d.fields!) for (const k of WIRE_KEYS) expect(f).not.toHaveProperty(k);
  });
});

describe('bc_close_page', () => {
  function cardRepo(): PageContextRepository {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    repo.applyToPage('pc:card', [{
      type: 'FormCreated', formId: 'CARD', isReload: false,
      controlTree: { t: 'lf', ServerId: 'CARD', PageType: 0, Children: [] },
    } as BCEvent]);
    return repo;
  }

  it('a close blocked by the discard confirm reports closed:false and the confirm', async () => {
    const repo = cardRepo();
    const blocker = { ...confirm, ownerFormId: 'CARD' } as BCEvent;
    const pageService = { closePage: vi.fn(async () => ok({ events: [blocker] })) };
    const r = await new ClosePageOperation(pageService as never, repo).execute({ pageContextId: 'pc:card' });
    expect(r.ok && r.value).toMatchObject({ closed: false, requiresDialogResponse: true, dialogsOpened: [{ kind: 'confirm', responses: ['yes', 'no'] }] });
    expect(r.ok && r.value).not.toHaveProperty('success');
  });

  it('a clean close reports closed:true', async () => {
    const repo = cardRepo();
    const pageService = { closePage: vi.fn(async () => { repo.remove('pc:card'); return ok({ events: [] }); }) };
    const r = await new ClosePageOperation(pageService as never, repo).execute({ pageContextId: 'pc:card' });
    expect(r.ok && r.value).toMatchObject({ closed: true, dialogsOpened: [], requiresDialogResponse: false });
  });
});

// Code review 2026-11-24: a failed CloseForm was swallowed and reported closed:true.
describe('PageService.closePage on a failed CloseForm', () => {
  function svc(answer: unknown) {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    const session = { invoke: vi.fn(async () => answer), removeOpenForm: vi.fn() };
    return { repo, service: new PageService(session as never, repo, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never) };
  }

  it('surfaces the error instead of reporting a close', async () => {
    const { service } = svc(err(new ProtocolError('WebSocket closed')));
    const r = await service.closePage('pc:card');
    expect(r.ok).toBe(false);
  });

  it('treats FormNotFoundException as already closed', async () => {
    const { service, repo } = svc(err(new ProtocolError('JSON-RPC error: {"errorType":"Microsoft.Dynamics.Framework.UI.FormNotFoundException"}')));
    const r = await service.closePage('pc:card');
    expect(r.ok).toBe(true);
    expect(repo.get('pc:card')).toBeUndefined();
  });
});

// Payload review 2026-11-24, step 22: "yes" on the discard confirm closed the card, but the
// answer listed all 13 card sections as changed and never said the card was gone.
describe('bc_respond_dialog when the answer closes the page', () => {
  it('reports closedPages and no changed sections of the closed page', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    repo.applyToPage('pc:card', [{
      type: 'FormCreated', formId: 'CARD', isReload: false,
      controlTree: { t: 'lf', ServerId: 'CARD', PageType: 0, Children: [{ t: 'sc', Caption: 'Name', Visible: true }] },
    } as BCEvent]);
    const [dlg] = registerDialogs(repo, 'pc:card', [{ ...confirm, ownerFormId: 'CARD' } as BCEvent]);
    // As BCSession delivers it: BC's State 0 per closed form, each followed by the derived FormClosed.
    const closedState = (formId: string) => [
      { type: 'PropertyChanged', formId, controlPath: 'server:', changes: { State: 0 } },
      { type: 'FormClosed', formId },
    ];
    const events = [...closedState(confirm.formId), ...closedState('CARD'), { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[];
    const session = { invoke: vi.fn(async () => ok(events)) };
    const downloads = { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) };
    const r = await new RespondDialogOperation(session as never, repo, downloads as never)
      .execute({ pageContextId: dlg!.pageContextId, dialogFormId: confirm.formId, response: 'yes' });
    expect(r.ok && r.value).toMatchObject({ closed: true, closedPages: ['pc:card'], changedSections: [] });
    expect(repo.get('pc:card')).toBeUndefined();
  });
});

describe('registerDialogs', () => {
  it('returns the dialog shape with its own pageContextId', () => {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    const [d] = registerDialogs(repo, 'pc:card', [{ ...confirm, ownerFormId: 'CARD' } as BCEvent]);
    expect(d).toMatchObject({ formId: confirm.formId, kind: 'confirm', responses: ['yes', 'no'] });
    expect(d!.pageContextId).toMatch(/^session:page:dialog:/);
  });
});
