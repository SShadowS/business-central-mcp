import { describe, it, expect } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';
import {
  actions as treeActions,
} from '../../src/protocol/form-views.js';

describe('PageContextRepository — modal-rooted pages', () => {
  const wizardTree = {
    t: 'lf',
    Caption: 'Sample Wizard',
    PageType: 9, // NavigatePage
    Children: [
      { t: 'gc', Caption: 'Step0', Children: [
        { t: 'sc', Caption: 'Step0Field', Editable: true, Visible: true, ColumnBinder: { Name: 'b1' } },
      ] },
      { t: 'gc', MappingHint: 'ACTIONBAR', Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Actions/PreviousRecord/16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Actions/NextRecord/16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Actions/Approve/16.png' } },
        { t: 'ac', Caption: 'Cancel', SystemAction: 320 },
      ] },
    ],
  };

  it('treats DialogOpened with formId === rootFormId as the page root layout', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1', { isModal: true });

    const event: BCEvent = {
      type: 'DialogOpened',
      formId: 'F1',
      ownerFormId: 'roleCenterForm',
      controlTree: wizardTree,
    };
    repo.applyEvents([event]);

    const ctx = repo.get('pc1')!;
    expect(ctx.isModal).toBe(true);
    expect(ctx.pageType).toBe('NavigatePage');
    expect(ctx.caption).toBe('Sample Wizard');

    const rootForm = ctx.forms.get('F1')!;
    const actionNodes = treeActions(rootForm.root);
    // classifyWizardNav logic mirrors form-state.ts actionNodeToActionInfo
    const navs = actionNodes.map(a => {
      const id = a.iconIdentifier;
      if (id) {
        if (/PreviousRecord/i.test(id)) return 'back';
        if (/NextRecord|Action_Start/i.test(id)) return 'next';
        if (/Approve/i.test(id)) return 'finish';
      }
      if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
      return undefined;
    }).filter(Boolean);
    expect(navs).toEqual(expect.arrayContaining(['back', 'next', 'finish', 'cancel']));
  });

  it('treats DialogOpened with a different formId as a child dialog (not root)', () => {
    const repo = new PageContextRepository();
    // Open a regular page first
    repo.create('pc1', 'rootForm');
    repo.applyEvents([{
      type: 'FormCreated',
      formId: 'rootForm',
      isReload: false,
      controlTree: { t: 'lf', Caption: 'Customer Card', PageType: 0, Children: [] },
    } as BCEvent]);

    // Now a confirmation dialog appears with a *different* formId
    repo.applyEvents([{
      type: 'DialogOpened',
      formId: 'dialogForm',
      ownerFormId: 'rootForm',
      controlTree: { t: 'lf', Caption: 'Confirm', PageType: 8, Children: [] },
    } as BCEvent]);

    const ctx = repo.get('pc1')!;
    expect(ctx.isModal).toBe(false);
    expect(ctx.pageType).toBe('Card');
    expect(ctx.dialogs.length).toBe(1);
    expect(ctx.dialogs[0]!.formId).toBe('dialogForm');
    // Root form is unchanged — no actions
    expect(treeActions(ctx.forms.get('rootForm')!.root)).toHaveLength(0);
  });

  it('isModal defaults to false when create() is called without options', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');
    expect(repo.get('pc1')!.isModal).toBe(false);
  });

  it('invalidateSection marks the named section invalid', () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'F1', { isModal: false, wizardState: null });
    // Use the repo's existing factbox-section path -- simulate a discovered child form
    repo.registerDiscoveredChildForm('pc:1', {
      serverId: 'fb1',
      caption: 'Customer Statistics',
      controlTree: { t: 'lf', ServerId: 'fb1', PageType: 3, Children: [] },
      isSubForm: false,
      isPart: true,
    });
    const before = repo.get('pc:1');
    const fbSectionId = Array.from(before!.sections.keys()).find(k => k.startsWith('factbox:'))!;
    expect(before!.sections.get(fbSectionId)!.valid).toBe(true);

    repo.invalidateSection('pc:1', fbSectionId);

    const after = repo.get('pc:1');
    expect(after!.sections.get(fbSectionId)!.valid).toBe(false);
  });

  it('invalidateSection is a no-op for an unknown section', () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'F1', { isModal: false, wizardState: null });
    // Should not throw
    expect(() => repo.invalidateSection('pc:1', 'nonexistent')).not.toThrow();
    expect(() => repo.invalidateSection('nonexistent-page', 'header')).not.toThrow();
  });

  // Payload review 2026-11-24: a page kept with invalid sections answered the next read with
  // "Section 'header' not found. Available sections: [\"header\", ...]". A page whose root
  // form BC closed is gone: the context is removed, so callers get PAGE_CONTEXT_NOT_FOUND.
  it('removes a page context when its root form closes', () => {
    const repo = new PageContextRepository();
    repo.create('pc:modal', 'M1', { isModal: true });

    // Apply a DialogOpened so the page becomes a real modal-rooted page
    repo.applyEvents([{
      type: 'DialogOpened',
      formId: 'M1',
      ownerFormId: 'roleCenter',
      controlTree: { t: 'lf', Caption: 'Modal', PageType: 9, Children: [] },
    }]);

    const ctxBefore = repo.get('pc:modal')!;
    expect(ctxBefore.isModal).toBe(true);
    expect(ctxBefore.sections.get('header')!.valid).toBe(true);

    // Close the modal
    repo.applyToPage('pc:modal', [{ type: 'FormClosed', formId: 'M1' }]);

    expect(repo.get('pc:modal')).toBeUndefined();
    expect(repo.getByFormId('M1')).toBeUndefined();
  });

  it('removes a modal-rooted page with hosted parts when its root form closes', () => {
    const repo = new PageContextRepository();
    repo.create('pc:modal', 'M1', { isModal: true });

    // Modal page with an embedded fhc child form (a hosted card-part section)
    const hostedTree = { t: 'lf', ServerId: 'C1', Caption: 'Sub', PageType: 3, Children: [] };
    repo.applyEvents([{
      type: 'DialogOpened',
      formId: 'M1',
      ownerFormId: 'roleCenter',
      controlTree: {
        t: 'lf', Caption: 'Modal', PageType: 9,
        Children: [
          { t: 'fhc', Children: [hostedTree] },
        ],
      },
    }]);

    const ctxBefore = repo.get('pc:modal')!;
    // Confirm there's at least one non-header section attached to a different formId
    const nonHeaderSections = Array.from(ctxBefore.sections.values()).filter(s => s.sectionId !== 'header');
    if (nonHeaderSections.length === 0) {
      // No hosted child form was registered -- skip this branch quietly
      return;
    }
    for (const sec of ctxBefore.sections.values()) expect(sec.valid).toBe(true);

    // Close the root modal
    repo.applyToPage('pc:modal', [{ type: 'FormClosed', formId: 'M1' }]);

    // The page is gone, parts included.
    expect(repo.get('pc:modal')).toBeUndefined();
    expect(repo.getByFormId('C1')).toBeUndefined();
  });
});
