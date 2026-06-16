// tests/integration/field-options.test.ts
//
// Integration tests verifying that option/enum field values (Items + CurrentIndex
// from the BC wire) are surfaced on SectionField.options + SectionField.selectedOption.
//
// (a) Item Card (page 30): card-shape fields must expose options on all sec/bc
//     fields. The "Type" field specifically carries Inventory/Service/Non-Inventory.
//     selectedOption must be coherent with the options list.
//
// (b) Repeater column options: BC28 standard list/document repeaters (Sales Order
//     42 lines, Item List 31, Purchase Order 50 lines) do NOT include Items on rcc
//     column nodes or rc.Children in their FormCreated wire frames. This is a
//     BC server-side decision: option metadata is only sent for card-shape fields,
//     not for list column headers. The unit tests in form-tree-builder.test.ts
//     cover the rcc propagation logic for repeaters that DO send rc.Children Items
//     (e.g. Role Center Checklist subpage per cuegroup-rolecenter-2026-04-28.json
//     capture). This integration test verifies the absence behavior is clean (no
//     empty arrays, no errors).
//
// Rules: uses integrationPool; no 2>/dev/null; no emojis.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { isOk } from '../../src/core/result.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { repeaters as treeRepeaters } from '../../src/protocol/form-views.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

describe('field-options integration', () => {
  let lease: PooledLease;
  let session: BCSession;
  let pageService: PageService;
  const logger = createNullLogger();

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    const repo = new PageContextRepository();
    pageService = new PageService(session, repo, logger);
  }, 60000);

  afterAll(async () => {
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  // (a) Card-shape field options: Item Card page 30.
  // The "Type" field is a sec (option-enum) with Items: Inventory/Service/Non-Inventory.
  // PageService.openPage calls LoadForm(loadData:true) so field values are populated.
  it('(a) Item Card (page 30) "Type" field carries options Inventory/Service/Non-Inventory', async () => {
    const openResult = await pageService.openPage('30');
    expect(isOk(openResult)).toBe(true);
    if (!isOk(openResult)) return;

    const ctx = openResult.value;
    const pcId = ctx.pageContextId;
    console.error(`[field-options] Page 30 opened: pcId=${pcId}, pageType=${ctx.pageType}`);

    const section = buildSection(ctx, 'header');
    expect(section).not.toBeNull();
    if (!section) return;

    const allFieldNames = section.fields?.map(f => f.name) ?? [];
    console.error(`[field-options] (a) fields count: ${section.fields?.length}; first 10: ${allFieldNames.slice(0, 10).join(', ')}`);

    const typeField = section.fields?.find(f => f.name === 'Type');
    expect(typeField).toBeDefined();
    if (!typeField) {
      console.error('[field-options] "Type" field not found; available:', allFieldNames.join(', '));
      return;
    }

    console.error(`[field-options] (a) Type: type=${typeField.type}, options count=${typeField.options?.length}, selectedOption=${JSON.stringify(typeField.selectedOption)}`);

    // options must be present and contain the three known Item type texts.
    expect(typeField.options).toBeDefined();
    const optionTexts = typeField.options?.map(o => o.text) ?? [];
    expect(optionTexts).toContain('Inventory');
    expect(optionTexts).toContain('Service');
    expect(optionTexts).toContain('Non-Inventory');

    // Each option must have string text and value.
    for (const opt of typeField.options ?? []) {
      expect(typeof opt.text).toBe('string');
      expect(typeof opt.value).toBe('string');
    }

    // selectedOption coherence: if present, it must match one of the options.
    if (typeField.selectedOption) {
      const sel = typeField.selectedOption;
      const matchingOpt = typeField.options?.find(
        o => o.text === sel.text && o.value === sel.value,
      );
      expect(matchingOpt).toBeDefined();
      console.error(`[field-options] (a) selectedOption = ${JSON.stringify(sel)}`);
    } else {
      // Acceptable: item may have no type set (optionIndex -1, empty stringValue).
      console.error('[field-options] (a) selectedOption absent (option unset or blank)');
    }

    // Verify plain text fields do NOT get options (no spurious empty arrays).
    const noField = section.fields?.find(f => f.name === 'No.');
    if (noField) {
      expect(noField.options).toBeUndefined();
      expect(noField.selectedOption).toBeUndefined();
    }

    // Verify multiple other option fields on this page are populated.
    const fieldsWithOptions = section.fields?.filter(f => f.options) ?? [];
    console.error(`[field-options] (a) total fields with options: ${fieldsWithOptions.length}`);
    expect(fieldsWithOptions.length).toBeGreaterThan(3); // Blocked, Type, Costing Method, etc.

    await pageService.closePage(pcId, { discardChanges: true });
  }, 30000);

  // (b) Repeater column options: verify no spurious options on standard list pages
  //     AND document the BC28 wire behavior (Items absent on list column rcc nodes).
  //
  // Finding: BC28 sends Items only on card-shape sec/bc field nodes (FormCreated
  // Children array). Standard list repeaters send rcc column headers with NO Items
  // and NO rc.Children template nodes. The unit tests cover the propagation path
  // for repeaters that DO send rc.Children Items (e.g. Role Center Checklist subpage).
  it('(b) Sales Order (page 42) lines repeater columns have no spurious options', async () => {
    const openResult = await pageService.openPage('42');
    expect(isOk(openResult)).toBe(true);
    if (!isOk(openResult)) return;

    const ctx = openResult.value;
    const pcId = ctx.pageContextId;
    console.error(`[field-options] Page 42 opened: pcId=${pcId}, pageType=${ctx.pageType}`);

    const linesSection = Array.from(ctx.sections.values()).find(s => s.kind === 'lines');
    if (!linesSection) {
      console.error('[field-options] (b) No lines section; skipping.');
      await pageService.closePage(pcId, { discardChanges: true });
      return;
    }

    const childForm = ctx.forms.get(linesSection.formId);
    expect(childForm).toBeDefined();
    if (!childForm) return;

    const reps = treeRepeaters(childForm.root);
    const firstRep = reps.values().next().value;
    expect(firstRep).toBeDefined();
    if (!firstRep) return;

    console.error(`[field-options] (b) lines repeater: ${firstRep.columns.length} columns, ${firstRep.children.length} children`);

    // BC28 behavior: rc.Children is empty for standard list repeaters.
    // No column should have options (no propagation happened, no spurious arrays).
    for (const col of firstRep.columns) {
      // options must not be an empty array — either absent or non-empty.
      if (col.properties.options !== undefined) {
        expect(col.properties.options.length).toBeGreaterThan(0);
      }
    }

    // Document: "Type" column is present but carries no options on BC28.
    const typeCol = firstRep.columns.find(c => c.properties.caption === 'Type');
    if (typeCol) {
      console.error(`[field-options] (b) Type column options: ${typeCol.properties.options ?? 'undefined (expected — BC28 does not send Items on list rcc nodes)'}`);
      // This is expected BC28 behavior: Items absent on list rcc nodes.
      // Options coverage for repeater columns requires rc.Children with sec/bc
      // template nodes, which BC28 only sends for certain CardPart subpages
      // (e.g. Role Center Checklist). Unit tests cover that propagation path.
    }

    await pageService.closePage(pcId, { discardChanges: true });
  }, 30000);
});
