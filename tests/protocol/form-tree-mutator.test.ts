// tests/protocol/form-tree-mutator.test.ts
import { describe, it, expect } from 'vitest';
import { applyPropertyChange } from '../../src/protocol/form-tree-mutator.js';
import { findByControlPath } from '../../src/protocol/form-tree-walk.js';
import type { FormNode } from '../../src/protocol/form-node.js';

function makeTree(): FormNode {
  return {
    type: 'lf', controlPath: 'server:', serverId: '1', pageType: 'Card',
    properties: { caption: 'Root' },
    children: [
      { type: 'gc', controlPath: 'server:c[0]', properties: { caption: 'Group', visible: true }, children: [
        { type: 'sc', controlPath: 'server:c[0]/c[0]', properties: { caption: 'A', stringValue: 'oldA' } },
      ] },
      { type: 'gc', controlPath: 'server:c[1]', properties: { caption: 'Other' }, children: [] },
    ],
  };
}

describe('applyPropertyChange', () => {
  it('updates the target node\'s properties', () => {
    const updated = applyPropertyChange(makeTree(), 'server:c[0]/c[0]', { stringValue: 'newA' });
    const node = findByControlPath(updated, 'server:c[0]/c[0]')!;
    expect(node.properties.stringValue).toBe('newA');
    expect(node.properties.caption).toBe('A'); // existing prop preserved
  });

  it('merges multiple properties in one call', () => {
    const updated = applyPropertyChange(makeTree(), 'server:c[0]', { visible: false, caption: 'NewCap' });
    const node = findByControlPath(updated, 'server:c[0]')!;
    expect(node.properties.visible).toBe(false);
    expect(node.properties.caption).toBe('NewCap');
  });

  it('returns the same root reference when path is unknown', () => {
    const orig = makeTree();
    const updated = applyPropertyChange(orig, 'server:c[42]', { visible: false });
    expect(updated).toBe(orig);
  });

  it('preserves off-path nodes by reference (structural sharing)', () => {
    const orig = makeTree();
    const sibling = findByControlPath(orig, 'server:c[1]')!;
    const updated = applyPropertyChange(orig, 'server:c[0]/c[0]', { stringValue: 'newA' });
    const newSibling = findByControlPath(updated, 'server:c[1]')!;
    expect(newSibling).toBe(sibling); // same reference, not just equal value
  });

  it('returns a new root reference when a node is updated', () => {
    const orig = makeTree();
    const updated = applyPropertyChange(orig, 'server:c[0]/c[0]', { stringValue: 'newA' });
    expect(updated).not.toBe(orig);
  });
});

import { buildPathIndex } from '../../src/protocol/form-tree-mutator.js';

describe('buildPathIndex', () => {
  it('indexes every node by controlPath', () => {
    const idx = buildPathIndex(makeTree());
    expect(idx.size).toBe(4); // lf root + c[0] gc + c[0]/c[0] sc + c[1] gc
    expect(idx.get('server:c[0]/c[0]')?.properties.caption).toBe('A');
  });
});

describe('applyPropertyChange — RepeaterNode.columns', () => {
  function makeRepeaterTree(): FormNode {
    return {
      type: 'lf', controlPath: 'server:', serverId: '1', pageType: 'List',
      properties: { caption: 'List Page' },
      children: [
        {
          type: 'rc',
          controlPath: 'server:c[0]',
          properties: { bookmark: 'B10' },
          columns: [
            { type: 'rcc', controlPath: 'server:c[0]/co[0]', properties: { caption: 'No.' } },
            { type: 'rcc', controlPath: 'server:c[0]/co[1]', properties: { caption: 'Name', visible: true } },
          ],
          children: [],
        },
      ],
    };
  }

  it('updates a RepeaterColumnNode reachable only via columns', () => {
    const updated = applyPropertyChange(makeRepeaterTree(), 'server:c[0]/co[1]', { visible: false });
    const idx = buildPathIndex(updated);
    const col = idx.get('server:c[0]/co[1]')!;
    expect(col.type).toBe('rcc');
    expect(col.properties.visible).toBe(false);
    expect(col.properties.caption).toBe('Name'); // existing prop preserved
  });

  it('preserves sibling columns by reference (structural sharing)', () => {
    const orig = makeRepeaterTree();
    const sibling = buildPathIndex(orig).get('server:c[0]/co[0]')!;
    const updated = applyPropertyChange(orig, 'server:c[0]/co[1]', { visible: false });
    const newSibling = buildPathIndex(updated).get('server:c[0]/co[0]')!;
    expect(newSibling).toBe(sibling);
  });
});

describe('applyPropertyChange — chained mutations', () => {
  it('keeps off-path subtrees stable across multiple sequential mutations', () => {
    const t0 = makeTree();
    const sibling0 = findByControlPath(t0, 'server:c[1]')!;

    const t1 = applyPropertyChange(t0, 'server:c[0]/c[0]', { stringValue: 'first' });
    expect(findByControlPath(t1, 'server:c[1]')).toBe(sibling0);

    const t2 = applyPropertyChange(t1, 'server:c[0]/c[0]', { stringValue: 'second' });
    expect(findByControlPath(t2, 'server:c[1]')).toBe(sibling0);

    const t3 = applyPropertyChange(t2, 'server:c[0]', { caption: 'GroupRenamed' });
    expect(findByControlPath(t3, 'server:c[1]')).toBe(sibling0);

    expect(findByControlPath(t3, 'server:c[0]/c[0]')!.properties.stringValue).toBe('second');
    expect(findByControlPath(t3, 'server:c[0]')!.properties.caption).toBe('GroupRenamed');
  });
});

describe('replaceChild invariant', () => {
  it('returns root unchanged when path is not found in a leaf-only tree', () => {
    // FieldNode (type 'sc') has no children — childrenOf returns [].
    // applyPropertyChange cannot recurse further, so it returns the root
    // unchanged. This serves as a regression marker: replaceChild's throw
    // guard exists for internal correctness, but the public API never routes
    // a PropertyChanged through a leaf's subtree under normal protocol
    // semantics (BC never publishes a child path beneath a field node).
    const leaf = {
      type: 'sc', controlPath: 'server:c[0]', properties: { caption: 'Field' },
    } as FormNode;
    expect(applyPropertyChange(leaf, 'server:c[0]/c[0]', { caption: 'x' })).toBe(leaf);
  });
});
