// tests/protocol/section-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { SectionResolver, resolveSection } from '../../src/protocol/section-resolver.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makePageContext(
  sections: Map<string, SectionDescriptor> = new Map(),
  forms: Map<string, FormState> = new Map(),
): PageContext {
  return {
    pageContextId: 'ctx:1', rootFormId: 'root', pageType: 'Document',
    caption: 'Sales Order', forms, sections, dialogs: [], ownedFormIds: ['root'],
  };
}

describe('SectionResolver', () => {
  const resolver = new SectionResolver();

  it('derives lines section for child form with repeater', () => {
    const ctx = makePageContext();
    const childTree = {
      Caption: 'Sales Order Subform',
      PageType: 1,
      Children: [{
        t: 'rc',
        Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinderPath: '37_SalesLine.6' }],
      }],
    };
    const section = resolver.deriveSection(ctx, 'child1', childTree);
    expect(section.kind).toBe('lines');
    expect(section.sectionId).toBe('lines');
    expect(section.formId).toBe('child1');
    expect(section.repeaterControlPath).toBeDefined();
  });

  it('derives subpage for child form without repeater', () => {
    const ctx = makePageContext();
    const childTree = { Caption: 'Unknown Part', Children: [] };
    const section = resolver.deriveSection(ctx, 'child2', childTree);
    expect(section.kind).toBe('subpage');
    expect(section.sectionId).toBe('subpage:Unknown Part');
  });

  it('handles section ID collisions with ordinal', () => {
    const existing = new Map<string, SectionDescriptor>([
      ['lines', { sectionId: 'lines', kind: 'lines', caption: 'First', formId: 'c1', valid: true }],
    ]);
    const ctx = makePageContext(existing);
    const childTree = {
      Caption: 'Second Lines',
      Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Col' }] }],
    };
    const section = resolver.deriveSection(ctx, 'child3', childTree);
    expect(section.sectionId).toBe('lines#2');
    expect(section.kind).toBe('lines');
  });

  it('creates header section for root form', () => {
    const section = resolver.createHeaderSection('rootForm');
    expect(section.sectionId).toBe('header');
    expect(section.kind).toBe('header');
    expect(section.formId).toBe('rootForm');
  });
});

describe('resolveSection', () => {
  it('resolves section by id', () => {
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root', valid: true };
    const rootForm: FormState = {
      formId: 'root', controlTree: [], repeaters: new Map(), actions: [], filterControlPath: null,
    };
    const ctx = makePageContext(
      new Map([['header', headerSection]]),
      new Map([['root', rootForm]]),
    );
    const result = resolveSection(ctx, 'header');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.section.sectionId).toBe('header');
      expect(result.form.formId).toBe('root');
    }
  });

  it('returns error for unknown section', () => {
    const ctx = makePageContext(new Map(), new Map());
    const result = resolveSection(ctx, 'nonexistent');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('nonexistent');
    }
  });

  it('defaults to header when no sectionId given', () => {
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root', valid: true };
    const rootForm: FormState = {
      formId: 'root', controlTree: [], repeaters: new Map(), actions: [], filterControlPath: null,
    };
    const ctx = makePageContext(
      new Map([['header', headerSection]]),
      new Map([['root', rootForm]]),
    );
    const result = resolveSection(ctx);
    expect('error' in result).toBe(false);
  });

  it('returns error for stale (invalid) section', () => {
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root', valid: true };
    const linesSection: SectionDescriptor = { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'child1', valid: false };
    const rootForm: FormState = {
      formId: 'root', controlTree: [], repeaters: new Map(), actions: [], filterControlPath: null,
    };
    const childForm: FormState = {
      formId: 'child1', controlTree: [], repeaters: new Map(), actions: [], filterControlPath: null,
    };
    const ctx = makePageContext(
      new Map([['header', headerSection], ['lines', linesSection]]),
      new Map([['root', rootForm], ['child1', childForm]]),
    );
    const result = resolveSection(ctx, 'lines');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('no longer available');
      expect(result.error).toContain('re-opening');
      // Available sections should only include valid ones
      expect(result.availableSections).toContain('header');
      expect(result.availableSections).not.toContain('lines');
    }
  });

  it('valid sections still resolve normally', () => {
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root', valid: true };
    const linesSection: SectionDescriptor = { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'child1', valid: false };
    const rootForm: FormState = {
      formId: 'root', controlTree: [], repeaters: new Map(), actions: [], filterControlPath: null,
    };
    const ctx = makePageContext(
      new Map([['header', headerSection], ['lines', linesSection]]),
      new Map([['root', rootForm]]),
    );
    const result = resolveSection(ctx, 'header');
    expect('error' in result).toBe(false);
  });
});

describe('PageContextRepository FormClosed handling', () => {
  it('marks sections as invalid when their form is closed', () => {
    const repo = new PageContextRepository();
    const pcId = 'ctx:test';
    repo.create(pcId, 'root');

    // Simulate adding a child form with a lines section
    const formCreated: BCEvent = {
      type: 'FormCreated',
      formId: 'child1',
      parentFormId: 'root',
      controlTree: {
        Caption: 'Lines Subform',
        Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Col1' }] }],
      },
    };
    repo.applyEvents([formCreated]);

    // Verify section was created and is valid
    let ctx = repo.get(pcId)!;
    const linesSection = Array.from(ctx.sections.values()).find(s => s.kind === 'lines');
    expect(linesSection).toBeDefined();
    expect(linesSection!.valid).toBe(true);

    // Now close the child form
    const formClosed: BCEvent = { type: 'FormClosed', formId: 'child1' };
    repo.applyEvents([formClosed]);

    // Verify section is now invalid
    ctx = repo.get(pcId)!;
    const updatedSection = Array.from(ctx.sections.values()).find(s => s.kind === 'lines');
    expect(updatedSection).toBeDefined();
    expect(updatedSection!.valid).toBe(false);

    // Resolving the stale section should return an error
    const result = resolveSection(ctx, updatedSection!.sectionId);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('no longer available');
    }
  });

  it('does not affect sections for other forms when one form closes', () => {
    const repo = new PageContextRepository();
    const pcId = 'ctx:test2';
    repo.create(pcId, 'root');

    // Add two child forms
    repo.applyEvents([
      {
        type: 'FormCreated',
        formId: 'child1',
        parentFormId: 'root',
        controlTree: { Caption: 'Lines', Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'A' }] }] },
      } as BCEvent,
      {
        type: 'FormCreated',
        formId: 'child2',
        parentFormId: 'root',
        controlTree: { Caption: 'Details', Children: [] },
      } as BCEvent,
    ]);

    // Close only child1
    repo.applyEvents([{ type: 'FormClosed', formId: 'child1' } as BCEvent]);

    const ctx = repo.get(pcId)!;
    // Header should still be valid
    expect(ctx.sections.get('header')!.valid).toBe(true);
    // Lines section (child1) should be invalid
    const linesSection = Array.from(ctx.sections.values()).find(s => s.formId === 'child1');
    expect(linesSection!.valid).toBe(false);
    // Subpage (child2) should still be valid
    const subpageSection = Array.from(ctx.sections.values()).find(s => s.formId === 'child2');
    expect(subpageSection!.valid).toBe(true);
  });
});
