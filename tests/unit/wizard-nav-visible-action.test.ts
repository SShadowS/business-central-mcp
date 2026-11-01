// tests/unit/wizard-nav-visible-action.test.ts
//
// Issue #41: a NavigatePage carries each nav action twice, a hidden action-bar
// copy under server:c[0] and the footer-bar copy. Invoking the hidden copy is a
// silent no-op on BC (bare InvokeCompleted), so executeWizardNav must target the
// visible footer copy. Shape mirrors live cronus28 page 1803.

import { describe, it, expect, vi } from 'vitest';
import { ActionService } from '../../src/services/action-service.js';
import { ok } from '../../src/core/result.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { buildSection } from '../../src/protocol/section-dto.js';

const next = { t: 'ac', Caption: 'Next', SystemAction: 0, Icon: { Identifier: 'Actions/NextRecord/16.png' } };

// PageType 9 = NavigatePage (decompiled Nav.Types.Metadata.PageType; the live CDO wizard recording sends 9).
function makeRepo(): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create('pc:wiz', 'F1');
  repo.applyToPage('pc:wiz', [{
    type: 'FormCreated',
    formId: 'F1',
    isReload: false,
    controlTree: {
      t: 'lf', ServerId: 'F1', Caption: 'Company Setup', PageType: 9,
      Children: [
        { t: 'gc', Visible: false, Children: [{ t: 'gc', Visible: false, Children: [next] }] },
        { t: 'gc', Children: [next] },
      ],
    },
  } as BCEvent]);
  return repo;
}

// #50: page 143 Posted Sales Invoices (List) with an extension action "Mark as Handled", Image = Approve.
function makeListRepo(): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create('pc:list', 'F2');
  repo.applyToPage('pc:list', [{
    type: 'FormCreated',
    formId: 'F2',
    isReload: false,
    controlTree: {
      t: 'lf', ServerId: 'F2', Caption: 'Posted Sales Invoices', PageType: 1,
      Children: [{ t: 'ac', Caption: 'Mark as Handled', SystemAction: 0, Icon: { Identifier: 'Actions/Approve/16.png' } }],
    },
  } as BCEvent]);
  return repo;
}

describe('ActionService.executeWizardNav', () => {
  it('invokes the visible footer action, not the hidden action-bar copy', async () => {
    const invoke = vi.fn(async () => ok([{ type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] }] as BCEvent[]));
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const service = new ActionService({ invoke } as any, makeRepo(), logger);

    const result = await service.executeWizardNav('pc:wiz', 'next');

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect((invoke.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'InvokeAction', controlPath: 'server:c[1]/c[0]' });
  });

  it('does not run an Approve-icon action on a non-wizard page as "finish" (#50)', async () => {
    const invoke = vi.fn();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const repo = makeListRepo();
    const service = new ActionService({ invoke } as any, repo, logger);

    const result = await service.executeWizardNav('pc:list', 'finish');

    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    const action = buildSection(repo.get('pc:list')!, 'header')!.actions!.find(a => a.name === 'Mark as Handled');
    expect(action).toBeDefined();
    expect(action!.wizardNav).toBeUndefined();
  });
});
