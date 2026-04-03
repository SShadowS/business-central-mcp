import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseControlTree } from '../../src/protocol/control-tree-parser.js';

function loadControlTree(filename: string): unknown {
  const raw = JSON.parse(readFileSync(`tests/recordings/${filename}`, 'utf8'));
  // The recording wraps the control tree inside formCreatedEvents[0].controlTree
  return raw.formCreatedEvents[0].controlTree;
}

describe('parseControlTree', () => {
  it('parses Customer Card (page 21) control tree', () => {
    const controlTree = loadControlTree('page21-control-tree.json');
    const parsed = parseControlTree(controlTree);

    expect(parsed.caption).toBe('Customer Card');
    expect(parsed.pageType).toBe('Card');
    expect(parsed.fields.length).toBeGreaterThan(10);
    expect(parsed.actions.length).toBeGreaterThan(0);

    // Should have known fields
    const nameField = parsed.fields.find(f => f.caption === 'Name');
    expect(nameField).toBeDefined();
    expect(nameField!.type).toBe('sc');
    expect(nameField!.columnBinderName).toBeDefined();

    // Should have No. field
    const noField = parsed.fields.find(f => f.caption === 'No.');
    expect(noField).toBeDefined();

    // Should have boolean fields (bc type)
    const boolField = parsed.fields.find(f => f.type === 'bc');
    expect(boolField).toBeDefined();

    // Should have decimal/numeric fields (dc type)
    const decField = parsed.fields.find(f => f.type === 'dc');
    expect(decField).toBeDefined();

    // Card page should not have a repeater at root level
    // (it may have sub-page repeaters but the main form is a Card)
    // Just verify metadata
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata!.id).toBe(21);
    expect(parsed.metadata!.sourceTableId).toBe(18);

    // Should NOT contain placeholder fields
    const placeholders = parsed.fields.filter(f => f.caption === '' && !f.columnBinderName);
    // Some fields may have empty captions but valid binders; that's fine.
    // Just verify no MappingHint=PlaceholderField got through
    expect(parsed.fields.every(f => f.caption !== '' || f.columnBinderName !== undefined)).toBe(true);

    console.error(`Page 21: ${parsed.fields.length} fields, ${parsed.actions.length} actions`);
    console.error('Sample fields:', parsed.fields.slice(0, 10).map(f => `${f.caption} [${f.type}]`));
  });

  it('parses Customer List (page 22) control tree', () => {
    const controlTree = loadControlTree('page22-control-tree.json');
    const parsed = parseControlTree(controlTree);

    expect(parsed.caption).toBe('Customers');
    expect(parsed.pageType).toBe('List');
    expect(parsed.repeaters.size).toBeGreaterThan(0);

    // Get the first (main) repeater
    const repeater = parsed.repeaters.values().next().value!;
    expect(repeater.columns.length).toBeGreaterThanOrEqual(5);
    expect(parsed.actions.length).toBeGreaterThan(0);

    // Repeater columns should have captions
    const noCol = repeater.columns.find((c: { caption: string }) => c.caption === 'No.');
    expect(noCol).toBeDefined();
    expect(noCol!.columnBinderPath).toBe('18_Customer.1');

    const nameCol = repeater.columns.find((c: { caption: string }) => c.caption === 'Name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.columnBinderPath).toBe('18_Customer.2');

    // Should not include placeholder columns
    const placeholderCols = repeater.columns.filter(
      (c: { caption: string; columnBinderPath?: string }) => c.caption === '' && !c.columnBinderPath,
    );
    expect(placeholderCols.length).toBe(0);

    // Metadata
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata!.id).toBe(22);
    expect(parsed.metadata!.sourceTableId).toBe(18);

    console.error(`Page 22: ${repeater.columns.length} columns, ${parsed.actions.length} actions`);
    console.error('Sample columns:', repeater.columns.slice(0, 10).map((c: { caption: string }) => c.caption));
  });

  it('handles null control tree', () => {
    const parsed = parseControlTree(null);
    expect(parsed.fields).toEqual([]);
    expect(parsed.repeaters.size).toBe(0);
    expect(parsed.actions).toEqual([]);
    expect(parsed.caption).toBe('');
    expect(parsed.pageType).toBe('Unknown');
  });

  it('handles empty object control tree', () => {
    const parsed = parseControlTree({});
    expect(parsed.fields).toEqual([]);
    expect(parsed.repeaters.size).toBe(0);
    expect(parsed.caption).toBe('');
  });

  it('extracts action details correctly', () => {
    const controlTree = loadControlTree('page21-control-tree.json');
    const parsed = parseControlTree(controlTree);

    // Should have New, Edit, Delete, View actions
    const newAction = parsed.actions.find(a => a.caption === 'New');
    expect(newAction).toBeDefined();
    expect(newAction!.systemAction).toBe(10);
    expect(newAction!.enabled).toBe(true);

    const deleteAction = parsed.actions.find(a => a.caption === 'Delete');
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.systemAction).toBe(20);
    expect(deleteAction!.enabled).toBe(false); // Delete is disabled in view mode

    const viewAction = parsed.actions.find(a => a.caption === 'View');
    expect(viewAction).toBeDefined();
    expect(viewAction!.systemAction).toBe(60);
  });

  it('all actions have isLineScoped property', () => {
    const controlTree21 = loadControlTree('page21-control-tree.json');
    const parsed21 = parseControlTree(controlTree21);
    expect(parsed21.actions.every(a => typeof a.isLineScoped === 'boolean')).toBe(true);

    const controlTree22 = loadControlTree('page22-control-tree.json');
    const parsed22 = parseControlTree(controlTree22);
    expect(parsed22.actions.every(a => typeof a.isLineScoped === 'boolean')).toBe(true);
  });

  it('extracts columnBinderName on repeater columns for page 22', () => {
    const controlTree = loadControlTree('page22-control-tree.json');
    const parsed = parseControlTree(controlTree);

    expect(parsed.repeaters.size).toBeGreaterThan(0);
    const repeater = parsed.repeaters.values().next().value!;

    // The No. column should have a columnBinderName if BC provides ColumnBinder.Name
    const noCol = repeater.columns.find((c: { caption: string }) => c.caption === 'No.');
    expect(noCol).toBeDefined();
    // columnBinderName may be undefined if the recording doesn't include ColumnBinder.Name,
    // but the property should exist on the object (not throw)
    expect('columnBinderName' in noCol!).toBe(true);

    console.error('No. column:', noCol);
  });
});
