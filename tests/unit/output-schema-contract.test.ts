// The output schemas were hollow ({ type: object, additionalProperties: {} } for sections, rows,
// results), so success validation was near-trivial and told an agent nothing. These tests feed
// real shapes (live captures) through the advertised schemas and require unknown keys to fail.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { describeDialog } from '../../src/protocol/mutation-result.js';
import { OpenPageOutputSchema, RunReportOutputSchema, WriteDataOutputSchema, ReadDataOutputSchema } from '../../src/mcp/schemas.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { DialogOpenedEvent } from '../../src/protocol/types.js';

function hostedForms(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, unknown>;
  if (o.t === 'fhc' && Array.isArray(o.Children) && o.Children[0]) out.push(o.Children[0]);
  if (Array.isArray(o.Children)) for (const c of o.Children) hostedForms(c, out);
  return out;
}

function ctxFor(lf: unknown): PageContext {
  const root = buildFormTree(lf);
  return {
    pageContextId: 'pc:1', rootFormId: 'F', pageType: 'CardPart', caption: 'Part',
    forms: new Map([['F', { formId: 'F', root, rows: new Map() }]]),
    sections: new Map([['header', { sectionId: 'header', kind: 'header', caption: 'Header', formId: 'F', valid: true }]]),
    dialogs: [], ownedFormIds: ['F'], generation: 1, isModal: false, wizardState: null,
  } as unknown as PageContext;
}

const rc = JSON.parse(readFileSync('src/protocol/captures/cuegroup-rolecenter-2026-04-28.json', 'utf8')) as Array<Record<string, unknown>>;
const rcRoot = rc.find(e => e.type === 'FormCreated' && !e.parentFormId)!.controlTree;
const sections = hostedForms(rcRoot).map(lf => buildSection(ctxFor(lf), 'header')!).filter(Boolean);

describe('advertised output schemas fit real payloads, and nothing else', () => {
  it('sections from the Role Center capture (fields, cues, actions) validate', () => {
    expect(sections.length).toBeGreaterThan(5);
    expect(sections.some(s => s.cues && s.cues.length > 0)).toBe(true);
    const r = OpenPageOutputSchema.safeParse({ pageContextId: 'pc:1', pageType: 'RoleCenter', caption: 'RC', isModal: false, sections, stateVersion: 1 });
    expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true);
  });

  it('a section with an unknown key is rejected', () => {
    const bad = { ...sections[0]!, controlPath: 'server:c[0]' };
    expect(ReadDataOutputSchema.safeParse({ section: bad, stateVersion: 1 }).success).toBe(false);
  });

  it('a row whose cell is not a string or null is rejected', () => {
    const section = { sectionId: 'header', kind: 'header', caption: 'L', rows: [{ bookmark: 'B', cells: { Qty: 0 } }] };
    expect(ReadDataOutputSchema.safeParse({ section, stateVersion: 1 }).success).toBe(false);
  });

  it('the captured report request page validates as a run_report dialogsOpened entry', () => {
    const ev = JSON.parse(readFileSync('tests/fixtures/dialogs/request-page-report6.json', 'utf8')) as DialogOpenedEvent;
    const requestPage = { pageContextId: 'session:page:report:1', ...describeDialog(ev.formId, ev.controlTree) };
    const r = RunReportOutputSchema.safeParse({ success: true, reportId: 6, dialogsOpened: [requestPage], requiresDialogResponse: true, downloads: [], externalUris: [], replaySafe: false });
    expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true);
  });

  it('write results and warnings have a fixed shape', () => {
    const ok = {
      results: [{ fieldName: 'City', success: true, newValue: 'London', echoed: true }],
      allSucceeded: true, changedSections: [], dialogsOpened: [], requiresDialogResponse: false,
      validationWarnings: [{ field: 'City', message: 'Check the post code', severity: 'Warning' }],
      messages: [], replaySafe: true,
    };
    expect(WriteDataOutputSchema.safeParse(ok).success).toBe(true);
    const leaky = { ...ok, results: [{ ...ok.results[0], events: [] }] };
    expect(WriteDataOutputSchema.safeParse(leaky).success).toBe(false);
  });
});
