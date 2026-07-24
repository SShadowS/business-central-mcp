// tests/unit/wizard-navigate-operation.test.ts
//
// Unit tests for WizardNavigateOperation.
// The operation:
//   1. Delegates to actionService.executeWizardNav(pageContextId, action)
//   2. On service error: propagates err unchanged
//   3. On service success: builds output from post-action page context in repo
//   4. Computes closed=true when action is 'finish'/'cancel' AND no wizard nav actions remain
//   5. Computes closed=true when pageContextId no longer exists in repo after action
//   Key output fields: success, caption, fields, availableNav, closed, changedSections, dialogsOpened

import { describe, it, expect, vi } from 'vitest';
import { WizardNavigateOperation } from '../../src/operations/wizard-navigate.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeActionService(overrides?: Record<string, unknown>) {
  return {
    executeWizardNav: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    ...overrides,
  } as any;
}

// Minimal stub for DownloadService — captures nothing.
function makeDownloadService() {
  return { capture: vi.fn(async () => ({ downloads: [], externalUris: [] })) } as any;
}

function makeRepo(withContext = true) {
  const repo = new PageContextRepository();
  if (withContext) {
    repo.create('pc:wizard:1', 'wiz-form-1');
    // Apply a minimal FormCreated so the page has a parseable root
    repo.applyToPage('pc:wizard:1', [{
      type: 'FormCreated',
      formId: 'wiz-form-1',
      isReload: false,
      controlTree: {
        t: 'lf',
        ServerId: 'wiz-form-1',
        Caption: 'Setup Wizard',
        PageType: 14, // NavigatePage
        Children: [],
      },
    } as BCEvent]);
  }
  return repo;
}

describe('WizardNavigateOperation — error propagation', () => {
  it('propagates actionService error unchanged', async () => {
    const actionService = makeActionService({
      executeWizardNav: vi.fn(async () => err(new ProtocolError('Page context not found: pc:wizard:1'))),
    });
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Page context not found');
    }
  });

  it('does not call executeWizardNav if action service errors early', async () => {
    const navErr = new ProtocolError('session dead');
    const actionService = makeActionService({
      executeWizardNav: vi.fn(async () => err(navErr)),
    });
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'back' });

    expect(result.ok).toBe(false);
    expect(actionService.executeWizardNav).toHaveBeenCalledOnce();
  });
});

describe('WizardNavigateOperation — service call routing', () => {
  it('passes pageContextId and action to executeWizardNav', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(actionService.executeWizardNav).toHaveBeenCalledWith('pc:wizard:1', 'next');
  });

  it('passes "back" action correctly', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    await op.execute({ pageContextId: 'pc:wizard:1', action: 'back' });

    expect(actionService.executeWizardNav).toHaveBeenCalledWith('pc:wizard:1', 'back');
  });

  it('passes "finish" action correctly', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    await op.execute({ pageContextId: 'pc:wizard:1', action: 'finish' });

    expect(actionService.executeWizardNav).toHaveBeenCalledWith('pc:wizard:1', 'finish');
  });

  it('passes "cancel" action correctly', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    await op.execute({ pageContextId: 'pc:wizard:1', action: 'cancel' });

    expect(actionService.executeWizardNav).toHaveBeenCalledWith('pc:wizard:1', 'cancel');
  });
});

describe('WizardNavigateOperation — output shape (successful actions)', () => {
  it('returns success=true from action result', async () => {
    const actionService = makeActionService({
      executeWizardNav: vi.fn(async () => ok({ success: true, events: [] as BCEvent[] })),
    });
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);
  });

  it('returns empty changedSections and dialogsOpened when events array is empty', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changedSections).toEqual([]);
    expect(result.value.dialogsOpened).toEqual([]);
  });

  it('returns caption from page context', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Caption comes from the FormCreated controlTree we applied: 'Setup Wizard'
    expect(result.value.caption).toBe('Setup Wizard');
  });

  it('returns closed=false for "next" action when page context still exists', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No availableNav = [] AND action='next' does NOT trigger closed=true
    // (only 'finish' or 'cancel' + empty nav triggers closed)
    // With empty tree, availableNav will be [] and action='next', so closed stays false
    expect(result.value.closed).toBe(false);
  });

  it('returns closed=true when action is "finish" and no wizard nav actions remain', async () => {
    // After finish, availableNav should be empty (no more next/back/finish/cancel).
    // WizardNavigateOperation sets closed = (action==='finish'|'cancel') && availableNav.length===0
    const actionService = makeActionService();
    const repo = makeRepo(); // empty tree -> no wizard nav actions -> availableNav=[]
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'finish' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.closed).toBe(true);
  });

  it('returns closed=true when action is "cancel" and no wizard nav actions remain', async () => {
    const actionService = makeActionService();
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'cancel' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.closed).toBe(true);
  });

  it('returns closed=true when page context no longer exists in repo after action', async () => {
    // If the page context disappeared (e.g., server closed it), closed should be true
    const actionService = makeActionService();
    const repo = makeRepo(false); // no context in repo at all
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:missing', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.closed).toBe(true);
    expect(result.value.caption).toBe('');
    expect(result.value.fields).toEqual([]);
    expect(result.value.availableNav).toEqual([]);
  });

  it('includes DialogOpened info when events contain a dialog', async () => {
    const dialogEvent: BCEvent = {
      type: 'DialogOpened',
      formId: 'wiz-confirm',
      controlTree: { t: 'lf', ServerId: 'wiz-confirm', Caption: 'Confirm Setup', Children: [] },
    } as any;
    const actionService = makeActionService({
      executeWizardNav: vi.fn(async () => ok({ success: true, events: [dialogEvent] })),
    });
    const repo = makeRepo();
    const op = new WizardNavigateOperation(actionService, repo, makeDownloadService());

    const result = await op.execute({ pageContextId: 'pc:wizard:1', action: 'next' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dialogsOpened).toHaveLength(1);
    expect(result.value.dialogsOpened[0]!.formId).toBe('wiz-confirm');
    expect(result.value.dialogsOpened[0]!.message).toBe('Confirm Setup');
  });
});
