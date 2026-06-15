import { describe, it, expect } from 'vitest';
import { detectChangedSections, detectDialogs, extractValidationErrors } from '../../src/protocol/mutation-result.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { BCEvent } from '../../src/protocol/types.js';

function makeCtx(overrides: Partial<PageContext> = {}): PageContext {
  return {
    pageContextId: 'ctx:1',
    rootFormId: 'root',
    pageType: 'Document',
    caption: 'Test',
    forms: new Map(),
    sections: new Map([
      ['header', { sectionId: 'header', kind: 'header' as const, caption: 'Header', formId: 'root', valid: true }],
      ['lines', { sectionId: 'lines', kind: 'lines' as const, caption: 'Lines', formId: 'child1', valid: true }],
      ['factbox:stats', { sectionId: 'factbox:stats', kind: 'factbox' as const, caption: 'Stats', formId: 'child2', valid: true }],
    ]),
    dialogs: [],
    ownedFormIds: ['root', 'child1', 'child2'],
    ...overrides,
  };
}

describe('detectChangedSections', () => {
  it('detects sections by event formId', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[0]', changes: { StringValue: 'x' } },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toContain('lines');
    expect(changed).not.toContain('header');
    expect(changed).not.toContain('factbox:stats');
  });

  it('includes all sections when root formId is in events (cascade)', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'root', controlPath: 'c[0]', changes: {} },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toContain('header');
    expect(changed).toContain('lines');
    expect(changed).toContain('factbox:stats');
  });

  it('returns empty for InvokeCompleted-only events (no formId)', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed).toEqual([]);
  });

  it('deduplicates when multiple events target same section', () => {
    const ctx = makeCtx();
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[0]', changes: {} },
      { type: 'PropertyChanged', formId: 'child1', controlPath: 'c[1]', changes: {} },
    ];
    const changed = detectChangedSections(ctx, events);
    expect(changed.filter(s => s === 'lines')).toHaveLength(1);
  });
});

describe('detectDialogs', () => {
  it('extracts dialog info from DialogOpened events', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg1', ownerFormId: 'root', controlTree: { Caption: 'Save changes?' } },
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.formId).toBe('dlg1');
    expect(dialogs[0]!.message).toBe('Save changes?');
  });

  it('returns empty when no dialogs', () => {
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'c[0]', changes: {} },
    ];
    expect(detectDialogs(events)).toHaveLength(0);
  });

  it('handles dialog with no caption', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg2', controlTree: {} },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.message).toBeUndefined();
  });

  it('parses dialog control tree fields (e.g. Copy Document dialog)', () => {
    const controlTree = {
      Caption: 'Copy Sales Document',
      Children: [
        {
          t: 'gc',
          Children: [
            {
              t: 'sc',
              Caption: 'Document Type',
              Editable: true,
              Visible: true,
              StringValue: 'Quote',
              ColumnBinder: { Name: 'docType_c1' },
            },
            {
              t: 'sc',
              Caption: 'Document No.',
              Editable: true,
              Visible: true,
              StringValue: 'S-ORD101001',
              ColumnBinder: { Name: 'docNo_c2' },
            },
            {
              t: 'bc',
              Caption: 'Include Header',
              Editable: true,
              Visible: true,
              StringValue: 'true',
              ObjectValue: true,
            },
          ],
        },
      ],
    };
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg3', ownerFormId: 'root', controlTree },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.message).toBe('Copy Sales Document');
    expect(dialogs[0]!.fields).toBeDefined();
    expect(dialogs[0]!.fields!.length).toBe(3);

    const docType = dialogs[0]!.fields!.find(f => f.caption === 'Document Type');
    expect(docType).toBeDefined();
    expect(docType!.editable).toBe(true);
    expect(docType!.stringValue).toBe('Quote');
    expect(docType!.controlPath).toMatch(/server:c\[0\]\/c\[0\]/);

    const docNo = dialogs[0]!.fields!.find(f => f.caption === 'Document No.');
    expect(docNo).toBeDefined();
    expect(docNo!.stringValue).toBe('S-ORD101001');

    const includeHeader = dialogs[0]!.fields!.find(f => f.caption === 'Include Header');
    expect(includeHeader).toBeDefined();
    expect(includeHeader!.type).toBe('bc');
  });

  it('does not include fields when dialog has no parseable controls', () => {
    const events: BCEvent[] = [
      { type: 'DialogOpened', formId: 'dlg4', controlTree: { Caption: 'Confirm?', Children: [] } },
    ];
    const dialogs = detectDialogs(events);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.fields).toBeUndefined();
  });
});

describe('extractValidationErrors', () => {
  it('returns empty when no PropertyChanged events carry ValidationResults', () => {
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]', changes: { StringValue: 'hello' } },
      { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] },
    ];
    expect(extractValidationErrors(events)).toEqual([]);
  });

  it('extracts ValidationResultItem from a PropertyChanged event', () => {
    const events: BCEvent[] = [
      {
        type: 'PropertyChanged',
        formId: 'f1',
        controlPath: 'server:c[2]/c[0]',
        changes: {
          ValidationResults: [
            {
              Id: 17,
              Description: 'The length of the string is 22, but it must be less than or equal to 10 characters.',
              Severity: 'Error',
              IsLocal: true,
              OriginatingControl: 'server:c[2]/c[0]',
              Title: null,
              TroubleshootInfo: null,
            },
          ],
        },
      },
    ];
    const errors = extractValidationErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.Id).toBe(17);
    expect(errors[0]!.Severity).toBe('Error');
    expect(errors[0]!.Description).toContain('less than or equal to 10 characters');
  });

  it('de-duplicates items that appear on multiple controls (same Id)', () => {
    // BC emits the same ValidationResultItem on the field, parent group,
    // and root form — all three PropertyChanged events carry identical Id.
    const item = {
      Id: 42,
      Description: 'Value must be positive.',
      Severity: 'Error' as const,
      IsLocal: true,
    };
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]/c[0]', changes: { ValidationResults: [item] } },
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]', changes: { ValidationResults: [item] } },
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'server:', changes: { ValidationResults: [item] } },
    ];
    const errors = extractValidationErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.Id).toBe(42);
  });

  it('returns empty array when ValidationResults is cleared (empty array)', () => {
    const events: BCEvent[] = [
      { type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]', changes: { ValidationResults: [] } },
    ];
    expect(extractValidationErrors(events)).toEqual([]);
  });

  it('collects multiple distinct validation errors', () => {
    const events: BCEvent[] = [
      {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
        changes: {
          ValidationResults: [
            { Id: 1, Description: 'Error A', Severity: 'Error' as const },
            { Id: 2, Description: 'Warning B', Severity: 'Warning' as const },
          ],
        },
      },
    ];
    const errors = extractValidationErrors(events);
    expect(errors).toHaveLength(2);
    expect(errors.map(e => e.Id)).toEqual([1, 2]);
  });
});
