// tests/protocol/cuegroup-fixture.test.ts
//
// Verifies that buildFormTree parses the captured Role Center cuegroup wire
// shape into typed StackGroupNode and CueFieldNode variants.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { walkTree } from '../../src/protocol/form-tree-walk.js';
import {
  isStackGroupNode,
  isCueFieldNode,
  type StackGroupNode,
  type CueFieldNode,
} from '../../src/protocol/form-node.js';

function findFhcChildren(node: unknown, results: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return results;
  const obj = node as Record<string, unknown>;
  if (obj.t === 'fhc') {
    const children = obj.Children as unknown[] | undefined;
    if (Array.isArray(children) && children[0]) results.push(children[0]);
  }
  const children = obj.Children as unknown[] | undefined;
  if (Array.isArray(children)) for (const c of children) findFhcChildren(c, results);
  return results;
}

const fixturePath = resolve(__dirname, '../../src/protocol/captures/cuegroup-rolecenter-2026-04-28.json');
const fixtureEvents = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown[];

describe('cuegroup fixture parsing', () => {
  // Find a hosted CardPart that contains stackgcs
  const rcEvent = (fixtureEvents as Array<Record<string, unknown>>).find(
    e => e.type === 'FormCreated' && !e.parentFormId,
  );
  const rcTree = rcEvent?.controlTree as unknown;
  const hostedForms = findFhcChildren(rcTree);

  let cueGroupCount = 0;
  let cueFieldCount = 0;
  const designNames: string[] = [];
  const cueCaptions: string[] = [];

  for (const lf of hostedForms) {
    if (!lf || typeof lf !== 'object') continue;
    const tree = buildFormTree(lf);
    for (const node of walkTree(tree)) {
      if (isStackGroupNode(node)) {
        cueGroupCount++;
        if (node.designName) designNames.push(node.designName);
      }
      if (isCueFieldNode(node)) {
        cueFieldCount++;
        const cap = node.properties.caption;
        if (cap) cueCaptions.push(cap);
      }
    }
  }

  it('parses at least one stackgc cuegroup container', () => {
    expect(cueGroupCount).toBeGreaterThan(0);
  });

  it('parses cue tile fields (stackc)', () => {
    expect(cueFieldCount).toBeGreaterThan(0);
  });

  it('extracts designName from cuegroups', () => {
    expect(designNames.length).toBeGreaterThan(0);
    // Known stackgc captions from the fixture
    expect(designNames).toEqual(expect.arrayContaining(['Ongoing Sales']));
  });

  it('extracts cue captions from stackc tiles', () => {
    expect(cueCaptions.length).toBeGreaterThan(0);
    expect(cueCaptions).toEqual(expect.arrayContaining(['Sales Quotes']));
  });
});

describe('CueFieldNode property extraction', () => {
  // Hand-crafted node to verify property mapping
  const synthetic = {
    t: 'lf',
    ServerId: 'X',
    PageType: 0,
    Children: [
      {
        t: 'stackgc',
        Caption: 'Test Group',
        DesignName: 'TestGroup',
        Children: [
          {
            t: 'gc',
            MappingHint: 'STACKGROUP',
            Children: [
              {
                t: 'stackc',
                Caption: 'Test Cue',
                StringValue: '5',
                ObjectValue: 5,
                HasAction: true,
                Synopsis: 'Test tooltip',
                ColumnBinder: { Name: 'binder1' },
              },
            ],
          },
        ],
      },
    ],
  };

  const tree = buildFormTree(synthetic);
  const cueFields: CueFieldNode[] = [];
  const groups: StackGroupNode[] = [];
  for (const node of walkTree(tree)) {
    if (isCueFieldNode(node)) cueFields.push(node);
    if (isStackGroupNode(node)) groups.push(node);
  }

  it('captures designName on stackgc', () => {
    expect(groups[0]!.designName).toBe('TestGroup');
  });

  it('captures caption on stackc', () => {
    expect(cueFields[0]!.properties.caption).toBe('Test Cue');
  });

  it('captures stringValue on stackc', () => {
    expect(cueFields[0]!.properties.stringValue).toBe('5');
  });

  it('captures hasAction true', () => {
    expect(cueFields[0]!.hasAction).toBe(true);
  });

  it('captures synopsis', () => {
    expect(cueFields[0]!.synopsis).toBe('Test tooltip');
  });

  it('captures columnBinder name and path', () => {
    expect(cueFields[0]!.columnBinder).toEqual({ name: 'binder1' });
  });
});
