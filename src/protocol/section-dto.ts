// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';
import type { FieldType } from './form-node.js';
import type { RepeaterRow } from './types.js';
import { resolveSection } from './section-resolver.js';
import {
  fields as treeFields,
  actions as treeActions,
  groupVisibility as treeGroupVisibility,
  cues as treeCues,
} from './form-views.js';
import { isEffectivelyVisible } from './visibility.js';
import { mapRowCellKeys } from './row-mapping.js';
import { classifyWizardNav } from './wizard-classify.js';
import type { PageContext } from './page-context.js';

export interface SectionField {
  /** Field caption as shown in the BC client. Display label only. */
  readonly name: string;
  /** Display string. Undefined for fields that have no string projection (e.g. boolean tristate). */
  readonly value?: string;
  readonly editable: boolean;
  /** Wire-level BC field type. See FieldType union in protocol/form-node.ts. */
  readonly type: FieldType;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
  /**
   * For option/enum fields (`sec`) and boolean fields (`bc`): the allowed
   * choices. Use the `value` string as the SaveValue payload when writing
   * this field. Absent on plain text/numeric fields.
   *
   * Reference: live BC28 wire — Item Card page 30 "Type" field;
   * decompiled `LogicalControlSerializer.WriteItems`.
   */
  readonly options?: ReadonlyArray<{ readonly text: string; readonly value: string }>;
  /**
   * The currently selected option, resolved from `optionIndex` (preferred) or
   * by matching `value` against option texts (fallback for PropertyChanged
   * echoes that omit CurrentIndex). Absent when no option is selected (`optionIndex === -1`
   * and `value` does not match any option text).
   */
  readonly selectedOption?: { readonly text?: string; readonly value?: string };
}

export interface SectionAction {
  /** Action caption as shown in the BC client. */
  readonly name: string;
  /** SystemAction ordinal. See SystemAction enum in protocol/types.ts. 0 = no system role (custom AL action). */
  readonly systemAction: number;
  /** True if BC marks the action as currently invokable. */
  readonly enabled: boolean;
  /** Wizard role on a NavigatePage / StandardDialog. */
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
}

export interface SectionCue {
  /** Cue tile caption — used as the cue identifier for bc_execute_action. */
  readonly name: string;
  /** Display value (the count). May be empty initially before LoadForm populates StringValue. */
  readonly value: string;
  /** Group caption (e.g. "Ongoing Sales"). Helps the LLM frame the cue. */
  readonly groupCaption?: string;
  /** Tooltip text from the AL source. */
  readonly synopsis?: string;
  /** True when the cue supports drill-down (HasAction on the wire). */
  readonly hasAction: boolean;
}

/**
 * Row inside a list-shape Section. Identical to the internal `RepeaterRow`
 * type — cells keyed by `columnBinderName` (e.g. "1165569367_c2"), not by
 * caption.
 */
export type SectionRow = RepeaterRow;

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
  /** Populated when the section's form contains cuegroup tiles. */
  readonly cues?: readonly SectionCue[];
}

/**
 * Build the Section DTO for `sectionId` in `ctx`. Returns `null` when the
 * sectionId is unknown or the section has been invalidated.
 *
 * Card-shape sections emit `fields[]` (and `actions[]` for header sections);
 * list-shape sections emit `rows[]` and `totalRowCount`. Header sections
 * always include `actions[]` because actions are reachable only from the root
 * form.
 */
export function buildSection(ctx: PageContext, sectionId: string): Section | null {
  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return null;
  const { section, form, repeater, rows } = resolved;

  const isHeader = section.kind === 'header';

  const root = form.root;
  const groupVis = treeGroupVisibility(root);
  const ws = ctx.wizardState;

  const out: {
    sectionId: string;
    kind: typeof section.kind;
    caption: string;
    fields?: SectionField[];
    rows?: SectionRow[];
    totalRowCount?: number | null;
    actions?: SectionAction[];
    cues?: SectionCue[];
  } = {
    sectionId: section.sectionId,
    kind: section.kind,
    caption: section.caption,
  };

  if (repeater) {
    // TODO(tier-2/T25): replace mapRowCellKeys adapter with direct tree-node reads
    out.rows = mapRowCellKeys(
      [...rows],
      repeater.columns.map(c => ({
        controlPath: c.controlPath,
        caption: c.properties.caption ?? '',
        type: 'rcc' as const,
        columnBinderName: c.columnBinder?.name,
        columnBinderPath: c.columnBinder?.path,
      })),
    ).map(r => ({ bookmark: r.bookmark, cells: r.cells }));
    out.totalRowCount = repeater.properties.totalRowCount ?? null;
  } else {
    out.fields = treeFields(root)
      .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
      .map(f => {
        const opts = f.properties.options;
        let selectedOption: { text?: string; value?: string } | undefined;
        if (opts && opts.length > 0) {
          const idx = f.properties.optionIndex;
          if (typeof idx === 'number' && idx >= 0 && idx < opts.length) {
            selectedOption = opts[idx];
          } else if (f.properties.stringValue) {
            // Fallback: match stringValue against option text (PropertyChanged
            // echoes may omit CurrentIndex).
            const match = opts.find(o => o.text === f.properties.stringValue);
            if (match) selectedOption = match;
          }
        }
        return {
          name: f.properties.caption!,
          value: f.properties.stringValue,
          editable: f.properties.editable ?? false,
          type: f.type,
          ...(f.properties.showMandatory ? { showMandatory: true as const } : {}),
          ...(f.hasLookup ? { isLookup: true as const } : {}),
          ...(opts && opts.length > 0 ? { options: opts } : {}),
          ...(selectedOption ? { selectedOption } : {}),
        };
      });
  }

  if (isHeader) {
    out.actions = treeActions(root)
      .filter(a => (a.properties.enabled ?? true) && a.properties.caption
        && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
      .map(a => {
        const wn = classifyWizardNav(a);
        return {
          name: a.properties.caption!,
          systemAction: a.systemAction,
          enabled: a.properties.enabled ?? true,
          ...(wn ? { wizardNav: wn } : {}),
        };
      });
  }

  const cueList = treeCues(root);
  if (cueList.length > 0) {
    out.cues = cueList.map(c => ({
      name: c.caption,
      value: c.value,
      ...(c.groupCaption ? { groupCaption: c.groupCaption } : {}),
      ...(c.synopsis ? { synopsis: c.synopsis } : {}),
      hasAction: c.hasAction,
    }));
  }

  return out as Section;
}

const SECTION_KIND_ORDER: Record<SectionKind, number> = {
  header: 0,
  lines: 1,
  subpage: 2,
  factbox: 3,
  requestPage: 4,
};

/**
 * Emit every valid section in `ctx` in canonical order: header, lines,
 * subpages, factboxes, requestPage. Returns an empty array for a context
 * with no sections (defensive — should not occur in practice).
 */
export function buildAllSections(ctx: PageContext): Section[] {
  const out: Section[] = [];
  const ordered = Array.from(ctx.sections.values())
    .filter(s => s.valid)
    .sort((a, b) => SECTION_KIND_ORDER[a.kind] - SECTION_KIND_ORDER[b.kind]);
  for (const desc of ordered) {
    const built = buildSection(ctx, desc.sectionId);
    if (built !== null) out.push(built);
  }
  return out;
}
