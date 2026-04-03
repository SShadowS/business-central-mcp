// tests/protocol/section-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { SectionResolver, resolveSection } from '../../src/protocol/section-resolver.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';

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
      ['lines', { sectionId: 'lines', kind: 'lines', caption: 'First', formId: 'c1' }],
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
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root' };
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
    const headerSection: SectionDescriptor = { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'root' };
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
});
