// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';
import type { FieldType, FieldNode } from './form-node.js';
import { resolveSection } from './section-resolver.js';
import {
  fields as treeFields,
  actions as treeActions,
  groupVisibility as treeGroupVisibility,
  cues as treeCues,
  tabs as treeTabs,
  fieldName,
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
  /** The field's value type: text, decimal, boolean, datetime, integer, option, progress or static (read-only text). */
  readonly type: FieldTypeName;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
  /**
   * True when the field's lookup is driven by a custom AL OnLookup trigger
   * (LookupAction.CanShowSimpleLookup=false). Such fields have isLookup=true
   * but are NOT browseable via bc_lookup — BC does not emit an enumerable
   * lookup form. Use the field's own UI / AssistEdit instead.
   */
  readonly lookupCustom?: boolean;
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
  /** The tab (FastTab) the field sits on; pass it to bc_read_data { tab } to read just that tab. */
  readonly tab?: string;
}

export interface SectionAction {
  /** Action caption as shown in the BC client. */
  readonly name: string;
  /** SystemAction ordinal. See SystemAction enum in protocol/types.ts. 0 = no system role (custom AL action). */
  readonly systemAction: number;
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
export interface SectionRow {
  readonly bookmark: string;
  /** Caption -> BC's display string, or null when empty. */
  readonly cells: Record<string, string | null>;
}

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /** Card-shape sections: the tab (FastTab) captions in page order. */
  readonly tabs?: readonly string[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  /** An empty new-row bookmark (BC's DraftRecordN): pass it to bc_write_data to add a line. */
  readonly newRowBookmark?: string;
  /** bc_read_data with range: true when rows exist past the range (read on with a higher offset). */
  readonly hasMore?: boolean;
  /** bc_read_data on a list: the filters this session applied that are active now. */
  readonly filters?: ReadonlyArray<{ readonly column: string; readonly value: string }>;
  /** bc_read_data on a list: the sort this session applied, or null (BC's default order). */
  readonly sort?: { readonly column: string; readonly direction: 'asc' | 'desc' } | null;
  readonly actions?: readonly SectionAction[];
  /** Populated when the section's form contains cuegroup tiles. */
  readonly cues?: readonly SectionCue[];
}

/** Readable field types for the wire control aliases (decompiled Client*Control TypeAlias attributes). */
export type FieldTypeName = 'text' | 'decimal' | 'boolean' | 'datetime' | 'integer' | 'option' | 'progress' | 'static';
const FIELD_TYPE_NAMES: Record<FieldType, FieldTypeName> = {
  sc: 'text',          // StringControl
  dc: 'decimal',       // DecimalControl
  bc: 'boolean',       // BooleanControl
  dtc: 'datetime',     // DateTimeControl (dates too)
  i32c: 'integer',     // Int32Control
  sec: 'option',       // SelectionControl (options/enums)
  pc: 'progress',      // ProgressControl
  ssc: 'static',       // StaticStringControl (read-only text)
};

/** The one MCP field shape, shared by page sections and dialogs. */
export function toSectionField(f: FieldNode): SectionField {
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
    name: fieldName(f),
    value: f.properties.stringValue,
    editable: f.properties.editable !== false,
    type: FIELD_TYPE_NAMES[f.type],
    ...(f.properties.showMandatory ? { showMandatory: true as const } : {}),
    ...(f.hasLookup ? { isLookup: true as const } : {}),
    ...(f.hasLookup && f.canShowSimpleLookup === false ? { lookupCustom: true as const } : {}),
    ...(opts && opts.length > 0 ? { options: opts } : {}),
    ...(selectedOption ? { selectedOption } : {}),
  };
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
    tabs?: string[];
    rows?: SectionRow[];
    newRowBookmark?: string;
    actions?: SectionAction[];
    cues?: SectionCue[];
  } = {
    sectionId: section.sectionId,
    kind: section.kind,
    // The header is the page itself: its descriptor caption is the placeholder "Header".
    caption: isHeader ? (ctx.caption || section.caption) : section.caption,
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
    // BC keeps empty DraftRecordN rows ready for new lines (live cronus29: 1 real Sales Order
    // line + 15 drafts of 38 empty cells each). Collapse them into one bookmark to write to.
    const isEmptyDraft = (r: SectionRow) => r.bookmark.startsWith('DraftRecord') && Object.values(r.cells).every(v => v === null);
    const draft = out.rows.find(isEmptyDraft);
    out.rows = out.rows.filter(r => !isEmptyDraft(r));
    if (draft) out.newRowBookmark = draft.bookmark;
  } else {
    // Tabs (FastTabs) are the captioned top-level groups; bc_read_data { tab } filters by them.
    const tabList = treeTabs(root);
    const tabOf = (path: string) => tabList.find(t => path.startsWith(`${t.controlPath}/`))?.caption;
    // A field known only by its design name that is read-only and empty is a control add-in
    // host (live cronus29: a chart part's "StatusText"/"BusinessChart"), nothing to read or
    // write. Captionless inputs stay (some dialogs only name their fields that way).
    const addInHost = (f: FieldNode) => !f.properties.caption && f.properties.editable === false && !f.properties.stringValue;
    out.fields = treeFields(root)
      .filter(f => fieldName(f) && !addInHost(f) && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
      .map(f => {
        const tab = tabOf(f.controlPath);
        return tab ? { ...toSectionField(f), tab } : toSectionField(f);
      });
    if (tabList.length > 0) out.tabs = tabList.map(t => t.caption);
  }

  if (isHeader) {
    out.actions = treeActions(root)
      .filter(a => (a.properties.enabled ?? true) && a.properties.caption
        && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
      .map(a => {
        const wn = classifyWizardNav(a, ctx.pageType);
        return {
          name: a.properties.caption!,
          systemAction: a.systemAction,
          ...(wn ? { wizardNav: wn } : {}),
        };
      });
  }

  const cueList = treeCues(root);
  if (cueList.length > 0) {
    // An unnamed AL cuegroup arrives captioned with its control name ("Control2", live cronus29
    // Role Center 9022): that tells the reader nothing, so it is left out.
    out.cues = cueList.map(c => ({
      name: c.caption,
      value: c.value,
      ...(c.groupCaption && !/^Control\d+$/.test(c.groupCaption) ? { groupCaption: c.groupCaption } : {}),
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
