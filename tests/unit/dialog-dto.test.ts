// One dialog shape for every tool (recorded flow 2026-11-24): the discard confirm came back
// as message "Confirm" with its question in fields[0].caption, wire keys (controlPath, type
// "ssc", ancestorGroupPaths) and no hint which answers are valid.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeDialog, registerDialogs } from '../../src/protocol/mutation-result.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { ok } from '../../src/core/result.js';
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

describe('registerDialogs', () => {
  it('returns the dialog shape with its own pageContextId', () => {
    const repo = new PageContextRepository();
    repo.create('pc:card', 'CARD');
    const [d] = registerDialogs(repo, 'pc:card', [{ ...confirm, ownerFormId: 'CARD' } as BCEvent]);
    expect(d).toMatchObject({ formId: confirm.formId, kind: 'confirm', responses: ['yes', 'no'] });
    expect(d!.pageContextId).toMatch(/^session:page:dialog:/);
  });
});
